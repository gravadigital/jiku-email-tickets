import { afterEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { loadEnv } from '#config/env.js';
import {
  DEVELOPMENT_TRANSPORT_TARGET,
  buildLoggerOptions,
  createLogger,
  developmentTransport,
  getLogger,
  initLogger,
  resetLoggerForTests,
} from '#shared/logger.js';

import { createLogCapture } from './log-capture.js';

/**
 * La regla central de este archivo, que es CA-8: CADA ASERCION ES SOBRE LA LINEA SERIALIZADA, nunca
 * sobre el objeto de entrada.
 *
 * No es una distincion pedante. `redact` opera DURANTE la serializacion, asi que un test escrito
 * sobre la entrada pasaria con `redact` completamente desconectado — que es precisamente el fallo
 * que esta suite existe para detectar.
 */

/** AppConfig valido minimo. Los tests pasan objetos literales: nunca mutan process.env. */
const CFG: AppConfig = {
  servers: 'nats://localhost:4222',
  instance: 'dev',
  credsFile: '/run/secrets/sentinel.creds',
  keyFile: '/run/secrets/machine-user.json',
  zitadelProjectId: '307f1f77bcf86cd799439011',
  issuer: 'https://id.grava.io',
  timeoutMs: 15_000,
  verifyProjectId: 42,
  logLevel: 'info',
  nodeEnv: 'production',
  // Los dos bloques anidados los agrega S-007. Los valores son los de prueba consistentes de toda
  // la suite: TS-34 los busca literalmente en los streams del proceso real.
  imap: {
    host: 'imap.gmail.com',
    port: 993,
    user: 'tickets@ejemplo.com',
    password: 'app-password-de-prueba',
  },
  poll: { cron: '*/5 * * * *', enabled: true, maxPerTick: 50 },
};

const cfg = (overrides: Partial<AppConfig> = {}): AppConfig => ({ ...CFG, ...overrides });

afterEach(() => {
  resetLoggerForTests();
});

describe('createLogger output format', () => {
  // TS-1
  it('emits a JSON line with the expected fields outside development', () => {
    const capture = createLogCapture();
    const logger = createLogger(cfg({ logLevel: 'info', nodeEnv: 'production' }), capture.stream);

    logger.info({ instance: 'dev' }, 'arranque ok');

    const [line] = capture.lines();
    expect(line).toMatchObject({
      level: 'info',
      msg: 'arranque ok',
      instance: 'dev',
      service: 'jiku-mail-connector',
      env: 'production',
    });
    // ISO 8601 UTC, como exige la convencion `_base` para los bordes del sistema.
    expect(line?.['time']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  // TS-1: el nivel sale como etiqueta, no como el numero 30.
  it('emits the level as its textual label, not as a number', () => {
    const capture = createLogCapture();
    const logger = createLogger(cfg(), capture.stream);

    logger.warn({}, 'ojo');

    expect(capture.lines()[0]?.['level']).toBe('warn');
  });
});

describe('createLogger transport', () => {
  // TS-2
  it('resolves the pino-pretty transport in development, and none anywhere else', () => {
    // El transporte no se puede observar emitiendo lineas: en desarrollo la salida se va por
    // pino-pretty a stdout, no al sink. Se afirma sobre el transporte resuelto.
    //
    // Lo que importa afirmar es QUE transporte se eligio, no que el logger no exploto: un
    // developmentTransport que devolviera undefined siempre, o que apuntara a otro target, tiene que
    // hacer fallar este test.
    expect(developmentTransport(cfg({ nodeEnv: 'development' }))).toEqual({
      target: 'pino-pretty',
      options: { colorize: true },
    });
    expect(DEVELOPMENT_TRANSPORT_TARGET).toBe('pino-pretty');

    for (const nodeEnv of ['production', 'test'] as const) {
      expect(developmentTransport(cfg({ nodeEnv })), nodeEnv).toBeUndefined();
    }
  });

  it('keeps the transport out of the base options, so an injected sink is never bypassed', () => {
    // buildLoggerOptions no declara transport a proposito: createLogger lo agrega solo en el camino
    // sin destino. Verificado que pasar transport + destination no lanza pero el transporte gana y
    // el sink queda vacio, asi que esta separacion es lo que evita un test que pasa en verde y ciego.
    for (const nodeEnv of ['development', 'production', 'test'] as const) {
      expect(buildLoggerOptions(cfg({ nodeEnv })).transport, nodeEnv).toBeUndefined();
    }
  });

  // TS-2: la discriminacion por entorno, afirmada sobre el comportamiento observable.
  it('emits JSON in production and in test', () => {
    for (const nodeEnv of ['production', 'test'] as const) {
      const capture = createLogCapture();
      const logger = createLogger(cfg({ nodeEnv }), capture.stream);

      logger.info({}, 'linea');

      expect(() => capture.lines(), `${nodeEnv} must emit parseable JSON`).not.toThrow();
      expect(capture.lines()[0]).toMatchObject({ env: nodeEnv, msg: 'linea' });
    }
  });

  // TS-3
  it('never configures a file transport, in any environment', () => {
    for (const nodeEnv of ['development', 'production', 'test'] as const) {
      const options = buildLoggerOptions(cfg({ nodeEnv }));
      const serialized = JSON.stringify(options);

      expect(serialized, `${nodeEnv} declares a file destination`).not.toContain('pino/file');
      expect(options).not.toHaveProperty('destination');
      // Sin destino explicito Pino escribe a stdout (fd 1), que es exactamente lo que se quiere.
      expect(serialized).not.toMatch(/\.log/);
    }
  });

  // TS-20
  it('degrades to JSON on stdout when the development transport does not resolve', () => {
    // Escenario real: la imagen de produccion corriendo con NODE_ENV=development, donde `--omit=dev`
    // dejo `pino-pretty` afuera del arbol. Se reproduce con un target no resoluble, que es la misma
    // via por la que falla (verificado: lanza en la construccion, sincronicamente).
    //
    // Verificado tambien a mano contra una instalacion `--omit=dev` real, con pino-pretty ausente:
    // emite el warn de degradacion y despues la linea de arranque, y sale con 0.
    const capture = createLogCapture();

    expect(() =>
      createLogger(cfg({ nodeEnv: 'development' }), capture.stream, 'pino-pretty-inexistente-xyz'),
    ).not.toThrow();
  });

  it('says why it degraded instead of falling back in silence', () => {
    // Un fallback callado es como se pierde un diagnostico. El logger degradado tiene que dejar
    // constancia de POR QUE quedo degradado, y sale por el mismo canal que todo lo demas.
    const capture = createLogCapture();

    const logger = createLogger(
      cfg({ nodeEnv: 'development' }),
      capture.stream,
      'pino-pretty-inexistente-xyz',
    );

    const [line] = capture.lines();
    expect(line).toMatchObject({
      level: 'warn',
      transportTarget: 'pino-pretty-inexistente-xyz',
    });
    expect(String(line?.['msg'])).toContain('se degrada a JSON en stdout');

    // Y sigue siendo un logger util: emite, con redact puesto.
    logger.info({ token: 'no-deberia-salir' }, 'despues de degradar');
    expect(capture.lines()[1]?.['token']).toBe('[REDACTED]');
  });

  it('degrades JSON-only, never to a file, when the transport fails', () => {
    // La degradacion no puede introducir por la puerta de atras lo que ADR-006 prohibe.
    const capture = createLogCapture();
    createLogger(cfg({ nodeEnv: 'development' }), capture.stream, 'pino-pretty-inexistente-xyz');

    const raw = capture.raw().join('\n');
    expect(raw).not.toContain('pino/file');
    expect(raw).not.toMatch(/\.log"/);
  });
});

describe('createLogger level', () => {
  // TS-11
  it('takes the level from the configuration and filters below it', () => {
    const capture = createLogCapture();
    const logger = createLogger(cfg({ logLevel: 'warn' }), capture.stream);

    logger.debug({}, 'no sale');
    logger.warn({}, 'si sale');

    expect(logger.level).toBe('warn');
    expect(capture.lines()).toHaveLength(1);
    expect(capture.lines()[0]?.['msg']).toBe('si sale');
  });

  // TS-12
  it('gets the info default from the configuration, not from a default of its own', () => {
    // El default vive en envSchema (S-002). El logger no lo duplica: dos fuentes de verdad se
    // desincronizan en silencio.
    const env = loadEnv({
      JIKU_CREDS: '/run/secrets/sentinel.creds',
      JIKU_KEY_FILE: '/run/secrets/machine-user.json',
      JIKU_PROJECT_ID: '307f1f77bcf86cd799439011',
      JIKU_VERIFY_PROJECT_ID: '42',
      // Requeridas desde S-007: un entorno sin ellas ya no resuelve.
      IMAP_HOST: 'imap.gmail.com',
      IMAP_USER: 'tickets@ejemplo.com',
      IMAP_PASSWORD: 'app-password-de-prueba',
    });
    const capture = createLogCapture();

    const logger = createLogger(cfg({ logLevel: env.LOG_LEVEL }), capture.stream);

    expect(env.LOG_LEVEL).toBe('info');
    expect(logger.level).toBe('info');
  });

  // TS-13
  it('respects silent by suppressing every line', () => {
    const capture = createLogCapture();
    const logger = createLogger(cfg({ logLevel: 'silent' }), capture.stream);

    logger.error({}, 'nada');
    logger.fatal({}, 'nada tampoco');

    expect(capture.lines()).toHaveLength(0);
  });
});

describe('logger singleton', () => {
  // TS-4
  it('returns the same reference on every access', () => {
    const first = initLogger(cfg());
    const second = getLogger();
    const third = initLogger(cfg({ logLevel: 'warn' }));

    expect(second).toBe(first);
    // Un segundo initLogger no reemplaza la instancia: una sola instancia, de la que todos derivan.
    expect(third).toBe(first);
  });

  it('fails loudly when used before initialization', () => {
    // Degradarse a un logger silencioso —o peor, a uno sin redact— seria peor que fallar en un
    // servicio cuyo unico borde es el log.
    expect(() => getLogger()).toThrow(/initLogger/);
  });
});

describe('createLogger redaction', () => {
  /**
   * Afirma las DOS cosas que el criterio exige: el campo vale '[REDACTED]' y la linea serializada
   * completa no contiene la subcadena del secreto. La segunda es la que detecta que el valor se
   * filtro por otra ruta.
   */
  function expectRedacted(
    context: Record<string, unknown>,
    message: string,
    secrets: string[],
  ): Record<string, unknown> {
    const capture = createLogCapture();
    const logger = createLogger(cfg(), capture.stream);

    logger.info(context, message);

    const raw = capture.raw().join('\n');
    for (const secret of secrets) {
      expect(raw, `secret "${secret}" leaked into the serialized line`).not.toContain(secret);
    }
    const [line] = capture.lines();
    expect(line).toBeDefined();
    return line as Record<string, unknown>;
  }

  // TS-5
  it('redacts an access token', () => {
    const line = expectRedacted(
      { accessToken: 'eyJhbGciOiJSUzI1NiJ9.payload.sig' },
      'token minted',
      ['eyJhbGciOiJSUzI1NiJ9'],
    );

    expect(line['accessToken']).toBe('[REDACTED]');
  });

  // TS-6
  it('redacts a nested token', () => {
    const line = expectRedacted({ auth: { token: 'secreto-abc123' } }, 'connect', ['secreto-abc123']);

    expect(line['auth']).toEqual({ token: '[REDACTED]' });
  });

  // TS-7
  it('redacts the NATS creds content', () => {
    const line = expectRedacted(
      { creds: '-----BEGIN NATS USER JWT-----\nabc\n------END NATS USER JWT------' },
      'bus creds',
      ['BEGIN NATS USER JWT'],
    );

    expect(line['creds']).toBe('[REDACTED]');
  });

  // TS-8
  it('redacts the private key of the machine user key', () => {
    const line = expectRedacted(
      { key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----' },
      'key cargada',
      ['BEGIN RSA PRIVATE KEY', 'MIIEowIBAAKCAQEA'],
    );

    expect(line['key']).toBe('[REDACTED]');
  });

  // TS-9
  it('never dumps a complete key object in the clear', () => {
    // La forma real del SDK: { type?, keyId, key, userId, expirationDate? }. El PEM es sintetico —
    // `redact` opera por ruta, no por contenido, asi que no hace falta una clave valida.
    const line = expectRedacted(
      {
        key: {
          type: 'serviceaccount',
          keyId: '307936',
          key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
          userId: '284123',
        },
      },
      'key',
      ['MIIEowIBAAKCAQEA', 'BEGIN RSA PRIVATE KEY', '307936'],
    );

    // El nodo completo, no solo el campo interno: una ruta que apunta a un objeto censura el nodo.
    expect(line['key']).toBe('[REDACTED]');
  });

  // TS-10
  it('redacts a generic credential', () => {
    const line = expectRedacted({ credentials: 'usuario:contrasena-secreta' }, 'imap', [
      'contrasena-secreta',
    ]);

    expect(line['credentials']).toBe('[REDACTED]');
  });

  // TS-19
  it('serializes an error with its stack while still redacting a secret path beside it', () => {
    const capture = createLogCapture();
    const logger = createLogger(cfg(), capture.stream);

    logger.error(
      { err: new Error('fallo de conexion'), keyFile: '/run/secrets/mu.json' },
      'arranque fallido',
    );

    const [line] = capture.lines();
    const err = line?.['err'] as { message?: string; stack?: string } | undefined;
    expect(err?.message).toBe('fallo de conexion');
    expect(err?.stack).toBeTruthy();
    // `redact` sigue operando sobre los otros campos aunque uno sea un Error serializado por Pino.
    expect(line?.['keyFile']).toBe('[REDACTED]');
  });

  // TS-16
  it('redacts the anticipated mail body while keeping the messageId intact', () => {
    const capture = createLogCapture();
    const logger = createLogger(cfg(), capture.stream);

    logger.info({ mail: { messageId: '<a@b.com>', body: 'texto del cliente' } }, 'mail procesado');

    const mail = capture.lines()[0]?.['mail'] as Record<string, unknown> | undefined;
    // Las DOS direcciones. La redaccion que se lleva puesto el messageId es un fallo tan real como
    // la que no redacta: ADR-006 exige que el messageId se loguee — es el rastro del ticket.
    expect(mail?.['body']).toBe('[REDACTED]');
    expect(mail?.['messageId']).toBe('<a@b.com>');
    expect(capture.raw().join('\n')).not.toContain('texto del cliente');
  });
});
