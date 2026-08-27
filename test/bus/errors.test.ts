import { AuthorizationError } from '@gravadigital/jiku/nats';
import { JikuError } from '@gravadigital/jiku';
import { describe, expect, it } from 'vitest';

import {
  BusConnectError,
  KeyLoadError,
  causeChain,
  diagnoseConnectFailure,
} from '#infra/bus/errors.js';

/**
 * Las formas de error que este archivo construye a mano imitan las VERIFICADAS contra el SDK
 * instalado (H1-H5 del Story Plan, reverificadas al implementar). Los tests de la Tarea 6 vuelven
 * a afirmar los mismos diagnosticos contra errores REALES: sin ese par, estos unit tests podrian
 * estar afirmando sobre una forma de error inventada que el SDK no produce nunca.
 */

const busRefused = (): JikuError =>
  new JikuError('jiku: the bus refused the credentials\n  ...', {
    cause: new AuthorizationError('Authorization Violation'),
  });

const tokenFailure = (): JikuError =>
  new JikuError('jiku: obtaining an access token', { cause: new Error('zitadel down') });

const unresolvableHost = (): JikuError => {
  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND no-such-host'), {
    code: 'ENOTFOUND',
  });
  return new JikuError('jiku: no NATS server answered at nats://no-such-host:4222', { cause });
};

const closedPort = (): JikuError => {
  // La rama GENERICA del SDK: su regex no matchea el "connection refused" en minuscula que
  // reporta el transporte (H5). Si la clasificacion leyera el texto, este caso caeria en
  // 'desconocido' y el operador iria a revisar Zitadel en vez de la red.
  const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
    code: 'ECONNREFUSED',
  });
  const outer = Object.assign(new Error('connection refused'), { cause: inner });
  outer.name = 'ConnectionError';
  return new JikuError('jiku: connecting to nats://127.0.0.1:1', { cause: outer });
};

const unreadableCreds = (): JikuError => {
  const cause = Object.assign(
    new Error("ENOENT: no such file or directory, open '/run/secrets/sentinel.creds'"),
    { code: 'ENOENT' },
  );
  return new JikuError(
    'jiku: the sentinel creds file "/run/secrets/sentinel.creds" is unreadable\n  ...',
    { cause },
  );
};

describe('diagnoseConnectFailure', () => {
  it('classifies the bus refusing the token as a subject rejection', () => {
    expect(diagnoseConnectFailure(busRefused())).toBe('rechazo_del_bus_por_subject');
  });

  it('does not guess Zitadel for a wrapped token failure: that is attributed by the caller', () => {
    // Este es el caso donde es MAS tentador adivinar, y por eso tiene test propio.
    //
    // El error tiene la forma exacta del fallo de token que produce el SDK, pero por ESTRUCTURA es
    // indistinguible de cualquier otro fallo inclasificable: la excepcion que lanza un TokenSource
    // puede ser un fetch fallido, un OAuthError o un TypeError, y ninguno trae marca. Lo unico que
    // lo distingue es el TEXTO del mensaje del SDK, que esta funcion no lee por diseno.
    //
    // Asi que se devuelve 'desconocido' — y el fallo de token se reconoce donde SI hay certeza:
    // `connectToBus()` pide el token antes de connect(), asi que cuando falla ahi la atribucion
    // viene de la llamada que lo produjo, no de lo que sobra. Ver TS-8 en connection.test.ts.
    expect(diagnoseConnectFailure(tokenFailure())).toBe('desconocido');
  });

  it('classifies an unresolvable host as an unreachable bus', () => {
    expect(diagnoseConnectFailure(unresolvableHost())).toBe('bus_inalcanzable');
  });

  it('classifies a closed port as an unreachable bus despite the generic SDK message', () => {
    expect(diagnoseConnectFailure(closedPort())).toBe('bus_inalcanzable');
  });

  it('classifies an unreadable creds file as its own diagnosis', () => {
    // Sexto modo de fallo, no enumerado por la story: se produce ANTES del socket y su arreglo
    // esta en el montaje del archivo, no en Zitadel ni en la red.
    expect(diagnoseConnectFailure(unreadableCreds())).toBe('creds_ilegible');
  });

  it('returns desconocido for a bare Error instead of guessing', () => {
    // Un diagnostico equivocado es peor que uno ausente: manda a revisar el sistema equivocado,
    // que es el fallo exacto que ADR-006 existe para evitar.
    expect(diagnoseConnectFailure(new Error('algo raro'))).toBe('desconocido');
  });

  it('returns desconocido for a non-error value', () => {
    expect(diagnoseConnectFailure('un string')).toBe('desconocido');
    expect(diagnoseConnectFailure(undefined)).toBe('desconocido');
  });

  it('never reads the SDK message text to classify', () => {
    // La prueba estructural de que no se lee el texto: un JikuError cuyo mensaje ANUNCIA una
    // rama pero cuya cadena de causas es la de otra se clasifica por la cadena.
    const misleading = new JikuError('jiku: the bus refused the credentials', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }),
    });

    expect(diagnoseConnectFailure(misleading)).toBe('bus_inalcanzable');
  });
});

describe('causeChain', () => {
  it('walks the chain of causes', () => {
    const chain = causeChain(closedPort());

    expect(chain).toHaveLength(3);
    expect(chain[0]).toBeInstanceOf(JikuError);
  });

  it('stops on a cycle instead of hanging', () => {
    const a = new Error('a');
    const b = new Error('b');
    Object.assign(a, { cause: b });
    Object.assign(b, { cause: a });

    expect(causeChain(a).length).toBeLessThanOrEqual(8);
  });
});

describe('KeyLoadError', () => {
  it('declares the code the contract promises', () => {
    const error = new KeyLoadError('no se pudo cargar', { keyFile: '/run/secrets/key.json' });

    expect(error.code).toBe('BUS_KEY_LOAD_ERROR');
    expect(error.name).toBe('KeyLoadError');
  });
});

describe('BusConnectError', () => {
  it('carries the diagnosis and the SDK class as fields, not only in the message', () => {
    // Imita a ConfigValidationError, que expone `variables` ademas del message: asi los tests y
    // el punto de log afirman sobre estructura y no sobre texto capturado.
    const error = new BusConnectError('rechazo_del_bus_por_subject', busRefused());

    expect(error.code).toBe('BUS_CONNECT_ERROR');
    expect(error.diagnosis).toBe('rechazo_del_bus_por_subject');
    expect(error.sdkErrorClass).toBe('JikuError');
    expect(error.cause).toBeInstanceOf(JikuError);
  });

  it('names Zitadel and rules out the payload when the bus refused the subject', () => {
    const error = new BusConnectError('rechazo_del_bus_por_subject', busRefused());

    expect(error.message).toMatch(/Zitadel/);
    expect(error.message).toMatch(/internal-app/);
    expect(error.message).toMatch(/no es un problema del payload/i);
  });

  it('distinguishes the token failure from the bus refusal in the message', () => {
    const error = new BusConnectError('zitadel_no_entrego_token', tokenFailure());

    expect(error.message).toMatch(/Zitadel/);
    expect(error.message).not.toMatch(/no es un problema del payload/i);
  });

  it('reports the class of a non-Jiku error without inventing one', () => {
    const error = new BusConnectError('desconocido', new TypeError('boom'));

    expect(error.sdkErrorClass).toBe('TypeError');
  });

  it('exposes the cause chain messages for the log', () => {
    const error = new BusConnectError('bus_inalcanzable', closedPort());

    expect(error.causes).toEqual([
      'jiku: connecting to nats://127.0.0.1:1',
      'connection refused',
      'connect ECONNREFUSED 127.0.0.1:1',
    ]);
  });

  it('keeps every secret out of message and details', () => {
    const error = new BusConnectError('creds_ilegible', unreadableCreds());
    const serialized = `${error.message} ${JSON.stringify(error.details)}`;

    expect(serialized).not.toMatch(/BEGIN RSA/);
    expect(serialized).not.toMatch(/eyJ/);
  });
});
