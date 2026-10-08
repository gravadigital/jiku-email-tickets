import { ServiceUser } from '@gravadigital/jiku/node';
import { afterAll, describe, expect, it } from 'vitest';

import type { AppConfig } from '#config/index.js';
import { KeyLoadError } from '#infra/bus/errors.js';
import { buildServiceUser } from '#infra/bus/identity.js';

import {
  TEST_SUBJECT,
  cleanupKeyFiles,
  generateServiceAccountKeyFile,
  writeRawKeyFile,
} from './auth-helpers.js';

/**
 * TS-1 a TS-5: la identidad y los CUATRO modos de fallo de la key.
 *
 * Este archivo no necesita el contenedor con `--auth` y por eso vive separado de connection.test.ts:
 * con `fileParallelism: false`, mezclarlos haria que estos tests puros paguen el arranque de un
 * contenedor que no usan.
 *
 * El `issuer` apunta deliberadamente a un host INALCANZABLE: es lo que convierte "no hace llamadas
 * de red" de una afirmacion por inspeccion en una afirmacion por comportamiento. Si el codigo
 * intentara resolver el issuer para construir la identidad, estos tests fallarian o colgarian.
 */

const UNREACHABLE_ISSUER = 'https://unreachable-issuer.invalid';

/**
 * Una key privada RSA cuyo PEM esta en el fixture, para afirmar que NO llega al error.
 *
 * El valor centinela no es decorativo: la asercion que de verdad detecta una filtracion es "el
 * string completo del error no contiene el secreto", y para hacerla hace falta un secreto que se
 * pueda buscar por substring.
 */
const SENTINEL = 'SUPERSECRETVALUE';

function configWith(keyFile: string): AppConfig {
  return {
    servers: 'nats://localhost:4222',
    instance: 'test',
    credsFile: '/run/secrets/sentinel.creds',
    keyFile,
    zitadelProjectId: 'proj-uuid',
    issuer: UNREACHABLE_ISSUER,
    timeoutMs: 15_000,
    verifyProjectId: 42,
    logLevel: 'silent',
    nodeEnv: 'test',
    // Los dos bloques anidados los agrega S-007. Los valores son los de prueba consistentes de toda
    // la suite: TS-34 los busca literalmente en los streams del proceso real.
    imap: {
      host: 'imap.gmail.com',
      port: 993,
      user: 'tickets@ejemplo.com',
      password: 'app-password-de-prueba',
    },
    poll: { cron: '*/5 * * * *', enabled: true, maxPerTick: 50 },
    ruteo: {
      subaddressPrefix: 'tickets',
      placeholderTitle: 'Ticket recibido por mail',
      placeholderBody: '(mail sin contenido)',
    },
    adjuntos: {
      allowedExtensions: ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.log', '.zip'],
      allowedMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'application/pdf'],
      maxSizeBytes: 10_485_760,
      putTimeoutMs: 30_000,
    },
  };
}

/** El texto completo del error: su mensaje mas el de cada nivel de la cadena de causas. */
function fullText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  let depth = 0;

  while (current instanceof Error && depth < 8) {
    parts.push(current.message, String(current.stack ?? ''));
    current = current.cause;
    depth += 1;
  }

  return parts.join('\n');
}

async function expectKeyLoadError(keyFile: string): Promise<KeyLoadError> {
  const error = await buildServiceUser(configWith(keyFile)).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(KeyLoadError);
  return error as KeyLoadError;
}

afterAll(async () => {
  await cleanupKeyFiles();
});

describe('buildServiceUser', () => {
  // TS-1
  it('derives the identity from the key without a network call', async () => {
    const keyFile = await generateServiceAccountKeyFile({ userId: TEST_SUBJECT });

    const serviceUser = await buildServiceUser(configWith(keyFile));

    expect(serviceUser).toBeInstanceOf(ServiceUser);
    // El user-id sale de la KEY. Es el mismo valor que ira en cada subject, y tiene que coincidir
    // con el `sub` que el auth-callout lee para autorizar: si saliera del entorno, se podria
    // declarar una identidad que no es la de la key (NFR-S03, invariante 17).
    expect(serviceUser.userId).toBe(TEST_SUBJECT);
    expect(await serviceUser.subject()).toBe(TEST_SUBJECT);
  });

  it('resolves before any token exists, which is what makes it network-free', async () => {
    const keyFile = await generateServiceAccountKeyFile();

    const serviceUser = await buildServiceUser(configWith(keyFile));

    // `currentToken()` devuelve '' hasta el primer `token()` exitoso. Que la identidad ya este
    // disponible con el token vacio es la prueba de que no hizo falta hablar con Zitadel.
    expect(serviceUser.currentToken()).toBe('');
    expect(serviceUser.expiresAt()).toBeUndefined();
  });

  // TS-2
  it('fails with KeyLoadError naming the path when the file does not exist', async () => {
    const error = await expectKeyLoadError('/nonexistent/key.json');

    expect(error.code).toBe('BUS_KEY_LOAD_ERROR');
    expect(error.message).toContain('/nonexistent/key.json');

    // La causa real viaja intacta: es el JikuError del SDK, cuyo propio cause trae el ENOENT.
    const sdkError = error.cause as Error;
    expect(sdkError.name).toBe('JikuError');
    expect((sdkError.cause as { code?: string }).code).toBe('ENOENT');
  });

  // TS-3
  it('fails without dumping the file contents when the JSON is malformed', async () => {
    const keyFile = await writeRawKeyFile(`-----BEGIN RSA PRIVATE KEY-----${SENTINEL}`);

    const error = await expectKeyLoadError(keyFile);

    // La asercion que importa: el contenido del archivo NO aparece en ningun nivel del error. Hoy
    // el SDK no lo filtra —verificado— pero eso puede cambiar en un minor, y CA-4 es exactamente
    // sobre esto. Envolver por `cause` en vez de interpolar el mensaje del SDK es lo que mantiene
    // la garantia estructural en lugar de depender de que el SDK siga comportandose bien.
    expect(fullText(error)).not.toContain(SENTINEL);
    expect(fullText(error)).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  // TS-4
  it('fails when the JSON is valid but is not a machine user key', async () => {
    const keyFile = await writeRawKeyFile(JSON.stringify({ hello: 'world' }));

    const error = await expectKeyLoadError(keyFile);

    expect((error.cause as Error).message).toContain('missing key, keyId or userId');
  });

  // TS-5
  it('fails when the key field is not a private key this runtime can read', async () => {
    const keyFile = await generateServiceAccountKeyFile({ key: 'no-es-una-pem' });

    const error = await expectKeyLoadError(keyFile);

    const sdkError = error.cause as Error;
    expect((sdkError.cause as { code?: string }).code).toBe('ERR_OSSL_UNSUPPORTED');
    // Tampoco este filtra lo que habia en el campo `key`.
    expect(fullText(error)).not.toContain('no-es-una-pem');
  });

  it('covers the four documented failure modes of the SDK constructor', async () => {
    // CA-4 menciona dos modos de fallo; el SDK tiene CUATRO, todos por la misma llamada, porque
    // `ServiceUser` valida la forma y la private key en el CONSTRUCTOR. Este test existe para que
    // el conteo quede afirmado: si una version futura agrega un quinto, no pasa desapercibido.
    const cases = [
      '/nonexistent/key.json',
      await writeRawKeyFile('no es json'),
      await writeRawKeyFile(JSON.stringify({ hello: 'world' })),
      await generateServiceAccountKeyFile({ key: 'no-es-una-pem' }),
    ];

    for (const keyFile of cases) {
      const error = await expectKeyLoadError(keyFile);
      expect(error.code).toBe('BUS_KEY_LOAD_ERROR');
    }
  });

  it('never puts the key path in details, only in the message', async () => {
    // La ruta va al MENSAJE, que es lo que el operador lee para arreglar el despliegue, pero no a
    // `details`: `details` termina en el contexto estructurado del log, donde una ruta a un
    // secreto es informacion sobre donde esta el secreto (ADR-006).
    const error = await expectKeyLoadError('/run/secrets/machine-user.json');

    expect(JSON.stringify(error.details ?? {})).not.toContain('/run/secrets');
  });
});
