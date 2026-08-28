import {
  JikuError,
  JikuFailure,
  JikuInvalidRequest,
  JikuNoEndpoint,
  JikuNotConnected,
  JikuPermissionDenied,
  JikuTimeout,
} from '@gravadigital/jiku';
import { describe, expect, it } from 'vitest';

import {
  type PublishDiagnosis,
  PublishError,
  REMEDIES,
  codeOf,
  coreMessageOf,
  diagnosePublishFailure,
  hintOf,
  isWritePlaneOpen,
} from '#domain/publicacion/publish-errors.js';

/**
 * TS-23 y TS-24, mas las aserciones de diagnostico de TS-15..TS-22 que se cubren construyendo la
 * clase de error a mano.
 *
 * El traductor es una FUNCION PURA sobre un error, asi que la mayor parte de su cobertura no
 * necesita contenedor: se le pasan instancias construidas de cada clase. Los tests CON bus real
 * (publish-errors.test.ts) verifican algo distinto y necesario: que las clases que el SDK
 * REALMENTE produce en cada situacion son las que este traductor espera — que es la afirmacion
 * que se rompe si el SDK cambia.
 */

const SUBJECT = 'test.test-machine-user.jiku-commands.v1.requirements.new';

/** Las ocho situaciones de la tabla de ADR-006, como instancias reales del SDK. */
const SITUATIONS: { name: string; error: unknown; diagnosis: PublishDiagnosis }[] = [
  {
    name: 'JikuPermissionDenied',
    error: new JikuPermissionDenied('el bus rechazo', SUBJECT, 'requirements.new'),
    diagnosis: 'rechazo_del_bus_por_subject',
  },
  {
    name: 'JikuNoEndpoint',
    error: new JikuNoEndpoint('nadie suscripto'),
    diagnosis: 'bus_sin_endpoint',
  },
  {
    name: 'JikuInvalidRequest',
    error: new JikuInvalidRequest('actor esta prohibido'),
    diagnosis: 'error_de_armado_del_conector',
  },
  {
    name: 'JikuTimeout',
    error: new JikuTimeout('nadie respondio'),
    diagnosis: 'nada_respondio',
  },
  {
    name: 'JikuFailure caller_not_authorized',
    error: new JikuFailure({ code: 'caller_not_authorized', method: 'requirements.new' }),
    diagnosis: 'core_rechazo_por_rol',
  },
  {
    name: 'JikuFailure invalid_fields',
    error: new JikuFailure({ code: 'invalid_fields', errorMessage: 'title requerido' }),
    diagnosis: 'core_rechazo_por_forma',
  },
  {
    name: 'JikuFailure project_not_found',
    error: new JikuFailure({ code: 'project_not_found', errorMessage: 'no existe el proyecto 99' }),
    diagnosis: 'core_rechazo_por_forma',
  },
  {
    name: 'JikuFailure with an unknown code',
    error: new JikuFailure({ code: 'flux_capacitor_offline', errorMessage: 'raro' }),
    diagnosis: 'core_rechazo_desconocido',
  },
];

describe('diagnosePublishFailure', () => {
  // TS-24
  it.each(SITUATIONS)('maps $name without throwing', ({ error, diagnosis }) => {
    // La regresion concreta de H1: `hint()` no existe en cuatro de las siete clases, asi que un
    // traductor que lo invoque sin discriminar lanza TypeError — en el peor momento posible.
    expect(() => diagnosePublishFailure(error)).not.toThrow();
    expect(diagnosePublishFailure(error)).toBe(diagnosis);
  });

  it('gives a distinct diagnosis to every system that can refuse', () => {
    // Los ocho diagnosticos son distintos entre si SALVO los dos de `core` por forma, que
    // comparten eje y comparten arreglo a proposito.
    //
    // El conjunto se DERIVA invocando el traductor, no leyendo la columna `diagnosis` de la tabla:
    // afirmar sobre el fixture probaria que la tabla esta bien escrita, que no es lo que interesa.
    const produced = SITUATIONS.map((situation) => diagnosePublishFailure(situation.error));
    const distinct = new Set(produced);

    expect(distinct.size).toBe(SITUATIONS.length - 1);

    const byName = new Map(
      SITUATIONS.map((situation) => [situation.name, diagnosePublishFailure(situation.error)]),
    );
    expect(byName.get('JikuFailure invalid_fields')).toBe(
      byName.get('JikuFailure project_not_found'),
    );
  });

  // TS-23
  it('blames the BUS, not core, for a permission denial by subject', () => {
    const error = new JikuPermissionDenied('el bus rechazo', SUBJECT, 'requirements.new');

    expect(diagnosePublishFailure(error)).toBe('rechazo_del_bus_por_subject');

    const remedy = REMEDIES['rechazo_del_bus_por_subject'];
    expect(remedy).toContain('Zitadel');
    expect(remedy).toMatch(/NO implica nada sobre core/i);
    // Y no manda a revisar el payload, que es el peor desvio posible para este caso.
    expect(remedy).not.toMatch(/revisa el payload/i);
  });

  it('maps an unknown code without falling into any of the known cases', () => {
    // TS-22 sobre la funcion pura: el catalogo del SDK NO ES CERRADO y un codigo nuevo es un
    // resultado normal, no un caso residual.
    const diagnosis = diagnosePublishFailure(
      new JikuFailure({ code: 'flux_capacitor_offline', errorMessage: 'raro' }),
    );

    expect(diagnosis).toBe('core_rechazo_desconocido');
    expect(diagnosis).not.toBe('core_rechazo_por_rol');
    expect(diagnosis).not.toBe('core_rechazo_por_forma');
    expect(diagnosis).not.toBe('rechazo_del_bus_por_subject');
  });

  it('maps unknown_caller to the same fix as caller_not_authorized', () => {
    // Gate 2 del SDK: el caller sin fila en `users`. El SDK los distingue porque son preguntas
    // distintas; el operador hace lo mismo con las dos (reconectar).
    expect(diagnosePublishFailure(new JikuFailure({ code: 'unknown_caller' }))).toBe(
      'core_rechazo_por_rol',
    );
  });

  it('maps a non-SDK error to desconocido without guessing', () => {
    // Un diagnostico equivocado es peor que uno ausente: manda a revisar el sistema equivocado.
    expect(diagnosePublishFailure(new TypeError('algo raro'))).toBe('desconocido');
    expect(diagnosePublishFailure('no soy un error')).toBe('desconocido');
    expect(diagnosePublishFailure(undefined)).toBe('desconocido');
  });

  it('maps an SDK error class it does not enumerate to desconocido', () => {
    // `JikuNotConnected` y `JikuError` a secas no son ninguna de las cinco clases mapeadas. Se
    // devuelven como desconocido y NO se mapean a otra.
    expect(diagnosePublishFailure(new JikuNotConnected())).toBe('desconocido');
    expect(diagnosePublishFailure(new JikuError('generico'))).toBe('desconocido');
  });

  it('evaluates JikuFailure before any generic branch', () => {
    // El orden de las ramas no es intercambiable: escrito al revés, un caller_not_authorized
    // caeria en 'desconocido' y se perderia el unico diagnostico que se arregla solo reconectando.
    const failure = new JikuFailure({ code: 'caller_not_authorized' });

    expect(failure).toBeInstanceOf(JikuError);
    expect(diagnosePublishFailure(failure)).toBe('core_rechazo_por_rol');
  });
});

describe('hintOf', () => {
  // H1: la razon de existir de esta funcion.
  it.each([
    ['JikuTimeout', new JikuTimeout('x')],
    ['JikuNoEndpoint', new JikuNoEndpoint('x')],
    ['JikuPermissionDenied', new JikuPermissionDenied('x', SUBJECT, 'requirements.new')],
    ['JikuInvalidRequest', new JikuInvalidRequest('x')],
  ])('returns undefined for %s, which does not declare hint()', (_name, error) => {
    // La comprobacion del hallazgo, no solo del wrapper: si una version futura del SDK agregara
    // hint() a estas clases, este test lo detecta y el comentario de hintOf() deja de valer.
    expect((error as unknown as { hint?: unknown }).hint).toBeUndefined();
    expect(hintOf(error)).toBeUndefined();
  });

  it('returns the SDK hint for the codes that have one', () => {
    const hint = hintOf(new JikuFailure({ code: 'caller_not_authorized' }));

    expect(typeof hint).toBe('string');
    expect(hint?.length ?? 0).toBeGreaterThan(0);
  });

  it('returns undefined for project_not_found and for an unknown code', () => {
    // H2, verificado: el catalogo de hintFor() no los cubre y su default devuelve undefined. Es
    // exactamente lo que CA-9 y CA-13 piden loguear "con su hint()", asi que el campo se omite y
    // lo que viaja en su lugar es code + errorMessage. No inventar texto para tapar la ausencia.
    expect(hintOf(new JikuFailure({ code: 'project_not_found' }))).toBeUndefined();
    expect(hintOf(new JikuFailure({ code: 'flux_capacitor_offline' }))).toBeUndefined();
  });

  it('never throws for a value that is not an error at all', () => {
    expect(hintOf('no soy un error')).toBeUndefined();
    expect(hintOf(undefined)).toBeUndefined();
  });
});

describe('codeOf and coreMessageOf', () => {
  it('extract what core sent, verbatim', () => {
    const error = new JikuFailure({ code: 'project_not_found', errorMessage: 'no existe el 99' });

    expect(codeOf(error)).toBe('project_not_found');
    expect(coreMessageOf(error)).toBe('no existe el 99');
  });

  it('return undefined when core never answered', () => {
    // La ausencia es informacion: no hubo reply de `core`.
    expect(codeOf(new JikuTimeout('x'))).toBeUndefined();
    expect(coreMessageOf(new JikuTimeout('x'))).toBeUndefined();
  });
});

describe('REMEDIES', () => {
  it('covers every diagnosis of the union', () => {
    const ALL: PublishDiagnosis[] = [
      'rechazo_del_bus_por_subject',
      'bus_sin_endpoint',
      'error_de_armado_del_conector',
      'core_rechazo_por_rol',
      'core_rechazo_por_forma',
      'core_rechazo_desconocido',
      'nada_respondio',
      'respuesta_ilegible',
      'desconocido',
    ];

    expect(Object.keys(REMEDIES).sort()).toEqual([...ALL].sort());
    for (const diagnosis of ALL) {
      expect(REMEDIES[diagnosis].length, `${diagnosis} needs a remedy`).toBeGreaterThan(40);
    }
  });

  it('says the role refusal is fixed by reconnecting, not by the payload', () => {
    const remedy = REMEDIES['core_rechazo_por_rol'];

    expect(remedy).toMatch(/users/);
    expect(remedy).toMatch(/RECONECTAR LO CORRIGE SOLO/i);
    expect(remedy).toMatch(/No revises el payload/i);
  });

  it('says a refusal by shape proves the write plane is open', () => {
    expect(REMEDIES['core_rechazo_por_forma']).toMatch(/plano de escritura esta abierto/i);
    expect(REMEDIES['core_rechazo_desconocido']).toMatch(/plano de escritura esta abierto/i);
  });

  it('names the connector, not the bus, for a locally rejected command', () => {
    const remedy = REMEDIES['error_de_armado_del_conector'];

    expect(remedy).toMatch(/nada llego a la red/i);
    expect(remedy).toMatch(/actor/);
  });

  it('names the 15000 ms timeout and the absence of retries for a timeout', () => {
    expect(REMEDIES['nada_respondio']).toContain('15000');
    expect(REMEDIES['nada_respondio']).toMatch(/No se reintenta/i);
  });
});

describe('isWritePlaneOpen', () => {
  it('is true exactly for the diagnoses where core answered', () => {
    expect(isWritePlaneOpen('core_rechazo_por_rol')).toBe(true);
    expect(isWritePlaneOpen('core_rechazo_por_forma')).toBe(true);
    expect(isWritePlaneOpen('core_rechazo_desconocido')).toBe(true);
    expect(isWritePlaneOpen('respuesta_ilegible')).toBe(true);
  });

  it('is false when the refusal never reached core', () => {
    expect(isWritePlaneOpen('rechazo_del_bus_por_subject')).toBe(false);
    expect(isWritePlaneOpen('bus_sin_endpoint')).toBe(false);
    expect(isWritePlaneOpen('error_de_armado_del_conector')).toBe(false);
    expect(isWritePlaneOpen('nada_respondio')).toBe(false);
    expect(isWritePlaneOpen('desconocido')).toBe(false);
  });
});

describe('PublishError', () => {
  it('exposes the diagnosis as a field, not only inside the message', () => {
    // Es lo que permite que el punto de log y los tests afirmen sobre estructura: el mensaje se
    // puede reescribir sin romper ningun test.
    const cause = new JikuFailure({ code: 'invalid_fields', errorMessage: 'title requerido' });
    const error = new PublishError(diagnosePublishFailure(cause), cause);

    expect(error.code).toBe('PUBLISH_ERROR');
    expect(error.httpStatus).toBe(500);
    expect(error.diagnosis).toBe('core_rechazo_por_forma');
    expect(error.sdkErrorClass).toBe('JikuFailure');
    expect(error.errorCode).toBe('invalid_fields');
    expect(error.coreMessage).toBe('title requerido');
    expect(error.planoDeEscrituraAbierto).toBe(true);
    expect(error.cause).toBe(cause);
  });

  it('omits code, hint and errorMessage from the log context when core never answered', () => {
    const context = new PublishError('nada_respondio', new JikuTimeout('x')).logContext(7);

    // No se loguea `hint: null`: sugeriria que el SDK contesto algo cuando no contesto nada.
    expect('hint' in context).toBe(false);
    expect('code' in context).toBe(false);
    expect('errorMessage' in context).toBe(false);
    expect(context['diagnosis']).toBe('nada_respondio');
    expect(context['sdkErrorClass']).toBe('JikuTimeout');
    expect(context['projectId']).toBe(7);
    expect(context['planoDeEscrituraAbierto']).toBe(false);
  });

  it('omits hint but keeps code and errorMessage for project_not_found', () => {
    // TS-21 sobre la funcion pura: hint() es undefined ahi (H2), y lo que reemplaza al hint es el
    // mensaje que mando core.
    const cause = new JikuFailure({ code: 'project_not_found', errorMessage: 'no existe el 99' });
    const context = new PublishError(diagnosePublishFailure(cause), cause).logContext(99);

    expect('hint' in context).toBe(false);
    expect(context['code']).toBe('project_not_found');
    expect(context['errorMessage']).toBe('no existe el 99');
    expect(context['projectId']).toBe(99);
  });

  it('keeps the log context flat, one level deep', () => {
    // La redaccion de S-003 no tiene comodin profundo: un contexto anidado dejaria un secreto en
    // claro sin fallar ni avisar.
    const cause = new JikuFailure({ code: 'caller_not_authorized' });
    const context = new PublishError(diagnosePublishFailure(cause), cause).logContext(7);

    for (const [key, value] of Object.entries(context)) {
      expect(
        typeof value !== 'object' || value === null,
        `${key} must not nest another object in the log context`,
      ).toBe(true);
    }
  });

  it('never carries the payload, the title or the description', () => {
    const cause = new JikuFailure({ code: 'invalid_fields' });
    const error = new PublishError(diagnosePublishFailure(cause), cause);
    const serialized = JSON.stringify({
      message: error.message,
      details: error.details,
      context: error.logContext(7),
    });

    // `title` y `description` NO estan en REDACT_PATHS (verificado), asi que si viajaran no habria
    // nada que los tape. En esta story son literales; en FG-3 son contenido del mail.
    //
    // La asercion es sobre las CLAVES y sobre el CONTENIDO, no sobre la palabra "payload": el
    // remedio de `core_rechazo_por_forma` dice en prosa "revisa el payload", que es correcto y es
    // justamente el diagnostico que hay que dar. Prohibir la palabra haria fallar el texto correcto
    // junto con la filtracion. Lo que no puede aparecer es una CLAVE que arrastre el objeto.
    expect(serialized).not.toMatch(/"payload"\s*:/);
    expect(serialized).not.toContain('[verificacion de despliegue]');
    expect(serialized).not.toMatch(/"(title|description)"\s*:/);
  });

  it('reports the class name of a cause that is not an error at all', () => {
    expect(new PublishError('desconocido', 'un string').sdkErrorClass).toBe('string');
  });
});
