import { describe, expect, it } from 'vitest';

import { EXPECTATIONS, ConfigValidationError, toConfigValidationError } from '#config/errors.js';
import { envSchema } from '#config/schema.js';
import { AppError } from '#shared/errors/index.js';

/** Minimal shape of a Standard Schema issue, enough to drive the formatter. */
function issue(variable: string, message = 'Invalid input'): { path: string[]; message: string } {
  return { path: [variable], message };
}

describe('ConfigValidationError', () => {
  it('extends AppError with the documented code and http status', () => {
    const err = toConfigValidationError([issue('JIKU_CREDS')]);

    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(ConfigValidationError);
    expect(err.code).toBe('CONFIG_VALIDATION_ERROR');
    expect(err.httpStatus).toBe(500);
    expect(err.name).toBe('ConfigValidationError');
  });

  it('exposes the offending variable names sorted and deduplicated', () => {
    const err = toConfigValidationError([
      issue('JIKU_PROJECT_ID'),
      issue('JIKU_CREDS'),
      issue('JIKU_CREDS', 'a second issue on the same variable'),
    ]);

    expect(err.variables).toEqual(['JIKU_CREDS', 'JIKU_PROJECT_ID']);
  });

  it('reports every variable in a single multiline message', () => {
    const err = toConfigValidationError([
      issue('JIKU_CREDS'),
      issue('JIKU_KEY_FILE'),
      issue('JIKU_PROJECT_ID'),
      issue('JIKU_VERIFY_PROJECT_ID'),
    ]);

    expect(err.message).toContain('jiku-email-tickets');
    for (const name of ['JIKU_CREDS', 'JIKU_KEY_FILE', 'JIKU_PROJECT_ID', 'JIKU_VERIFY_PROJECT_ID']) {
      expect(err.message).toContain(name);
    }
    // Encabezado + una linea por variable + cierre.
    expect(err.message.split('\n')).toHaveLength(6);
  });

  it('agrees in number when a single variable is at fault', () => {
    const err = toConfigValidationError([issue('JIKU_PROJECT_ID')]);

    expect(err.message).toContain('1 variable:');
    expect(err.message).not.toContain('1 variables');
    expect(err.message).toContain('Corregila');
  });

  it('describes what was expected for each variable', () => {
    const err = toConfigValidationError([issue('JIKU_TIMEOUT')]);

    expect(err.message).toMatch(/JIKU_TIMEOUT:.+/);
  });

  it('keeps details limited to the variable names', () => {
    const err = toConfigValidationError([issue('JIKU_CREDS')]);

    expect(err.details).toEqual({ variables: ['JIKU_CREDS'] });
  });

  it('never interpolates the zod message, so a leaked value cannot reach the output', () => {
    // Una version futura de Zod podria incluir el valor ofensor en el message del issue.
    // El formateador no lee issue.message, asi que no hay camino desde el valor al string.
    const err = toConfigValidationError([issue('JIKU_CREDS', 'received "SENTINEL-abc123"')]);

    expect(err.message).not.toContain('SENTINEL-abc123');
    expect(JSON.stringify(err.details)).not.toContain('SENTINEL-abc123');
  });

  it('still names an unknown variable without dumping the issue', () => {
    const err = toConfigValidationError([issue('SOME_FUTURE_VAR', 'received "leaked"')]);

    expect(err.variables).toEqual(['SOME_FUTURE_VAR']);
    expect(err.message).toContain('SOME_FUTURE_VAR');
    expect(err.message).not.toContain('leaked');
  });
});

describe('EXPECTATIONS', () => {
  const NEW_VARIABLES = [
    'IMAP_HOST',
    'IMAP_PORT',
    'IMAP_USER',
    'IMAP_PASSWORD',
    'POLL_CRON',
    'POLL_ENABLED',
    'POLL_MAX_PER_TICK',
    // Las tres del ruteo que quedan (S-012; S-025 elimino las dos del Mapa de Tickets junto con
    // sus claves del schema — la correspondencia es BIDIRECCIONAL, asi que dejar una entrada sin
    // clave rompe la suite igual que al revés).
    'SUBADDRESS_PREFIX',
    'PLACEHOLDER_TITLE',
    'PLACEHOLDER_BODY',
    // Las cuatro de la politica local de archivos (S-017).
    'ATTACHMENT_ALLOWED_EXTENSIONS',
    'ATTACHMENT_ALLOWED_MIME_TYPES',
    'ATTACHMENT_MAX_SIZE_BYTES',
    'PUT_TIMEOUT_MS',
    // Las cuatro del KV de S-024 (`KV_TICKETS_BUCKET`, `KV_THREADS_BUCKET`, `KV_THREADS_TTL_DAYS`,
    // `KV_WATCH_RETRY_MS`) SALIERON con S-032 junto con sus claves del schema: el Espacio KV del SDK
    // tiene el bucket fijo, sin TTL y sin watch. La correspondencia bidireccional de abajo rompe la
    // suite si alguna entrada quedara sin clave.
  ] as const;

  // TS-26. La correspondencia se afirma en las DOS direcciones para que una variable futura sin
  // entrada rompa la suite en vez de quedar muda: sin entrada cae en UNKNOWN_EXPECTATION, que es
  // seguro pero no le dice al operador que arreglar.
  it('has one entry per schema key, and no entry that the schema does not declare', () => {
    const declared = Object.keys(envSchema).sort();
    const described = Object.keys(EXPECTATIONS).sort();

    expect(described).toEqual(declared);
  });

  it('describes each of the new variables', () => {
    for (const name of NEW_VARIABLES) {
      expect(EXPECTATIONS[name], name).toMatch(/^se esperaba /);
    }
  });

  // El texto describe QUE se esperaba, nunca que se recibio: es lo que hace estructuralmente
  // imposible que un valor llegue al mensaje.
  it('never quotes a value or hints at the shape of a credential', () => {
    expect(EXPECTATIONS.IMAP_PASSWORD).not.toMatch(/caracter|largo|longitud|min|mayuscula|simbolo/i);
    for (const name of NEW_VARIABLES) {
      expect(EXPECTATIONS[name], name).not.toMatch(/recibi|recibido|valor recibido/i);
    }
  });
});

describe('toConfigValidationError with the IMAP and poll variables', () => {
  // TS-3. Sin entrada propia, IMAP_PASSWORD caeria en UNKNOWN_EXPECTATION: correcto pero mudo.
  it('describes IMAP_PASSWORD from its own entry, not from the unknown fallback', () => {
    const err = toConfigValidationError([issue('IMAP_PASSWORD')]);

    expect(err.variables).toEqual(['IMAP_PASSWORD']);
    expect(err.message).not.toContain('no paso la validacion declarada en el schema');
    expect(err.message).toContain(EXPECTATIONS.IMAP_PASSWORD);
  });

  // TS-10. El mensaje se lee igual que el criterio: "el minimo es 1".
  it('names 1 as the minimum for POLL_MAX_PER_TICK', () => {
    const err = toConfigValidationError([issue('POLL_MAX_PER_TICK')]);

    expect(err.message).toContain('1');
    expect(err.message).toContain(EXPECTATIONS.POLL_MAX_PER_TICK);
  });

  // TS-20. Un interruptor operativo tiene que decir cuales son sus dos posiciones.
  it('enumerates the two accepted values for POLL_ENABLED', () => {
    const err = toConfigValidationError([issue('POLL_ENABLED')]);

    expect(err.message).toContain('true');
    expect(err.message).toContain('false');
  });

  it('asks for a valid cron expression without echoing what was received', () => {
    const err = toConfigValidationError([issue('POLL_CRON', 'received "no es un cron"')]);

    expect(err.message).toContain('cron');
    expect(err.message).not.toContain('no es un cron');
  });

  // TS-4. El valor de un secreto no llega al reporte por ningun camino.
  it('never leaks the IMAP password value into the message or the details', () => {
    const err = toConfigValidationError([
      issue('IMAP_HOST', 'received ""'),
      issue('IMAP_PASSWORD', 'received "app-password-de-prueba"'),
    ]);

    expect(err.variables).toEqual(['IMAP_HOST', 'IMAP_PASSWORD']);
    expect(err.message).not.toContain('app-password-de-prueba');
    expect(JSON.stringify(err.details)).not.toContain('app-password-de-prueba');
  });

  // TS-1. Las tres de IMAP y las del bus salen en UNA sola lista completa.
  it('reports the three IMAP credentials together with the bus ones in a single list', () => {
    const err = toConfigValidationError([
      issue('JIKU_CREDS'),
      issue('JIKU_KEY_FILE'),
      issue('JIKU_PROJECT_ID'),
      issue('JIKU_VERIFY_PROJECT_ID'),
      issue('IMAP_HOST'),
      issue('IMAP_USER'),
      issue('IMAP_PASSWORD'),
    ]);

    expect(err.variables).toEqual([
      'IMAP_HOST',
      'IMAP_PASSWORD',
      'IMAP_USER',
      'JIKU_CREDS',
      'JIKU_KEY_FILE',
      'JIKU_PROJECT_ID',
      'JIKU_VERIFY_PROJECT_ID',
    ]);
    expect(err.message).toContain('7 variables');
  });
});

describe('toConfigValidationError with the routing variables', () => {
  // ELIMINADOS EN S-025: los dos casos de la regla de las dos fuentes del Mapa de Tickets (TS-34 de
  // S-012). Su entrada era la UNICA de la tabla que describia una REGLA y no un formato, porque los
  // dos issues cross-field aterrizaban en su path. Con la regla y las claves fuera, no hay ninguna
  // entrada que explicar: no quedo ninguna regla cross-field en el schema.
  //
  // Lo que SI se conserva, mas abajo: que ningun valor recibido se filtre al mensaje.

  it('names the literal default of the two routing variables whose default it can quote', () => {
    for (const [name, fallback] of [
      ['SUBADDRESS_PREFIX', 'tickets'],
      ['PLACEHOLDER_BODY', '(mail sin contenido)'],
    ] as const) {
      expect(EXPECTATIONS[name], name).toContain(fallback);
    }
  });

  // PLACEHOLDER_TITLE es la excepcion, y la excepcion es la propiedad de la tabla y no un descuido:
  // su default literal ("Ticket recibido por mail") contiene la palabra "recibido", y la tabla
  // entera sostiene que describe QUE se esperaba y nunca que se recibio. Citarlo aca convertiria esa
  // propiedad en una excepcion que despues nadie sabe distinguir de una fuga real.
  it('does not quote the title default, whose literal collides with the never-received rule', () => {
    expect(EXPECTATIONS.PLACEHOLDER_TITLE).not.toContain('Ticket recibido por mail');
    expect(EXPECTATIONS.PLACEHOLDER_TITLE).toContain('DEFAULT_PLACEHOLDER_TITLE');
  });

  // TS-35 — REESCRITO en S-025 con otra clave, no borrado. La propiedad que afirma es de S-002 y
  // sigue viva: **ningun valor RECIBIDO llega al reporte por ningun camino**; el mensaje describe
  // que se esperaba y nada mas. Antes se probaba con el `TICKET_MAP` porque era el peor caso —el
  // mapa es la topologia comercial del despliegue, los projectId de todos los clientes—, y esa
  // clave ya no existe. Se prueba con `IMAP_PASSWORD`, que es el peor caso que QUEDA: la unica
  // variable del servicio cuyo VALOR es un secreto.
  it('never leaks a received value into the message or the details', () => {
    const err = toConfigValidationError([
      issue('IMAP_HOST'),
      issue('IMAP_PASSWORD', 'received app-password-super-secreta-98765'),
    ]);

    expect(err.variables).toEqual(['IMAP_HOST', 'IMAP_PASSWORD']);
    for (const value of ['app-password-super-secreta', '98765']) {
      expect(err.message, value).not.toContain(value);
      expect(JSON.stringify(err.details), value).not.toContain(value);
    }
  });
});
