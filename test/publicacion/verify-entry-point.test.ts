import { execFile, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { cleanupKeyFiles, generateServiceAccountKeyFile, writeRawKeyFile } from '../bus/auth-helpers.js';
import { setupTestBus, type TestBusContext } from '../bus/helpers.js';
import { type CoreResponder, respondTo } from '../bus/responder.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const COMMAND = 'requirements.new';

/**
 * TS-28 y TS-29: el modo de verificacion es un entry point SEPARADO del arranque.
 *
 * CA-2 es una restriccion ESTRUCTURAL, no una preferencia: un requisito creado no se modifica ni se
 * borra nunca (invariante 9) y no hay comando de compensacion, asi que si la publicacion ocurriera
 * en cada arranque CADA REINICIO dejaria basura permanente en el proyecto de Jiku.
 *
 * TS-28 se verifica ejecutando el `dist/` REAL como proceso contra el bus del contenedor, con un
 * responder contando mensajes. Es mas fuerte que invocar `runStartup()` desde el test: prueba el
 * comportamiento del PROCESO que el operador realmente corre con `npm run start`.
 *
 * Nota sobre hasta donde llega el arranque en este entorno: sin un Zitadel alcanzable, el proceso
 * muere en el Paso 4 (obtener el token), ANTES de conectar. Eso no debilita la afirmacion — la
 * refuerza: si el arranque no publica ni siquiera cuando llega a conectarse (lo que se afirma
 * ademas estructuralmente, mas abajo y en source-properties.test.ts), mucho menos publica antes.
 * Lo que este test descarta positivamente es la unica forma en que podria publicar sin conexion:
 * un `client.command()` colado en un camino previo.
 */

let bus: TestBusContext;
let responder: CoreResponder | undefined;
let VALID_KEY_FILE: string;
let READABLE_CREDS: string;

/**
 * Quita comentarios antes de escanear, igual que `test/bus/source-properties.test.ts`.
 *
 * IMPRESCINDIBLE en este servicio y no una precaucion abstracta: el codigo comenta densamente los
 * "por que" verificados, y varios de esos comentarios mencionan JUSTAMENTE lo que estos tests
 * prohiben —`#domain/publicacion/`, `await using`, `.command(`— para explicar por que NO se hacen.
 * Sin stripear, cada explicacion haria fallar su propio test, y el "arreglo" obvio seria borrar el
 * comentario: exactamente al reves de lo que hay que hacer.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function sourceOf(file: string): string {
  return stripComments(readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8'));
}

/**
 * Entorno explicito para el proceso hijo, nunca heredado.
 *
 * Heredarlo haria que el test pasara o fallara segun lo que el desarrollador tenga exportado en su
 * shell, que es el fallo intermitente que la convencion `testing` prohibe. HOME apunta a un
 * directorio inexistente para que el `loadConfig()` del SDK no levante el
 * `~/.config/jiku/config.yaml` del desarrollador.
 */
function envWith(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'],
    HOME: '/nonexistent-home-for-tests',
    JIKU_PROJECT_ID: '307f1f77bcf86cd799439011',
    JIKU_VERIFY_PROJECT_ID: '7',
    JIKU_INSTANCE: 'test',
    NODE_ENV: 'production',
    ...extra,
  };
}

beforeAll(async () => {
  await execFileAsync('npm', ['run', 'build'], { cwd: PROJECT_ROOT });
  bus = await setupTestBus(inject('natsUrl'));
  VALID_KEY_FILE = await generateServiceAccountKeyFile();
  READABLE_CREDS = await writeRawKeyFile('-----BEGIN NATS USER JWT-----\nno-importa\n------END NATS USER JWT------');
}, 180_000);

afterAll(async () => {
  await bus.cleanup();
  await cleanupKeyFiles();
});

afterEach(async () => {
  await responder?.stop();
  responder = undefined;
});

describe('the start entry point', () => {
  // TS-28
  it('publishes NO command when the worker starts', async () => {
    // El responder cuenta CUALQUIER mensaje que llegue al subject del comando, con comodin en
    // instance y userId: si el arranque publicara algo, aca se veria.
    responder = await respondTo(bus.connection, COMMAND, { status: 'success', data: { id: 1 } });

    spawnSync(process.execPath, ['dist/index.js'], {
      cwd: PROJECT_ROOT,
      env: envWith({
        JIKU_KEY_FILE: VALID_KEY_FILE,
        JIKU_CREDS: READABLE_CREDS,
        JIKU_SERVERS: inject('natsUrl'),
      }),
      encoding: 'utf8',
      timeout: 30_000,
    });

    // Se drena la conexion del responder para que cualquier mensaje en vuelo llegue antes de
    // contar. Sin esto la asercion podria pasar por carrera en vez de por correccion.
    await bus.connection.flush();

    expect(responder.count()).toBe(0);
  }, 60_000);

  it('imports nothing from the publication domain', () => {
    // La contracara estructural de TS-28, y la que sigue valiendo cuando el arranque SI llegue a
    // conectarse: `src/index.ts` no puede publicar lo que no importa.
    const source = sourceOf('index.ts');

    expect(source).not.toContain('#domain/publicacion/');
    expect(source).not.toMatch(/\.command\s*\(/);
  });

  it('keeps the startup sequence free of any command publication', () => {
    // `src/startup.ts` es la secuencia COMPARTIDA por los dos entry points: si publicara algo, lo
    // publicarian los dos, y `start` volveria a dejar basura en cada reinicio.
    const source = sourceOf('startup.ts');

    expect(source).not.toContain('#domain/publicacion/');
    expect(source).not.toMatch(/\.command\s*\(/);
  });
});

describe('the verify entry point', () => {
  // TS-29
  it('is wired in package.json to the real entry point, not the placeholder', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(pkg.scripts['verify']).toBe('node dist/verify.js');
    // El placeholder de S-004 salia con 1 diciendo que esto se implementaba en S-005. Si volviera,
    // el modo de verificacion "fallaria" sin haber intentado nada.
    expect(pkg.scripts['verify']).not.toContain('se implementa en S-005');
  });

  it('publishes the command, unlike start, and exits non-zero when core refuses', async () => {
    // La otra mitad de CA-2: `verify` SI publica. Un test que solo probara que `start` no publica
    // pasaria igual con un `verify` roto que tampoco publicara.
    responder = await respondTo(bus.connection, COMMAND, {
      status: 'failure',
      errorCode: 'caller_not_authorized',
    });

    const result = spawnSync(process.execPath, ['dist/verify.js'], {
      cwd: PROJECT_ROOT,
      env: envWith({
        JIKU_KEY_FILE: VALID_KEY_FILE,
        JIKU_CREDS: READABLE_CREDS,
        JIKU_SERVERS: inject('natsUrl'),
      }),
      encoding: 'utf8',
      timeout: 30_000,
    });

    // Sin Zitadel alcanzable el proceso muere en el Paso 4, antes de publicar: lo que se afirma es
    // el CONTRATO DE SALIDA del script, que es la mitad de su valor. Un `verify` que saliera con 0
    // despues de fallar haria que el operador concluyera que el plano de escritura esta abierto
    // cuando no lo esta.
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(result.stderr).not.toContain('ERR_PACKAGE_IMPORT_NOT_DEFINED');
  }, 60_000);

  it('imports the publication domain, which is what makes it the verification mode', () => {
    const source = sourceOf('verify.ts');

    expect(source).toContain('#domain/publicacion/publish-requirement.js');
    // Y cierra la conexion, que es la asimetria deliberada con `start`: proceso de vida corta.
    expect(source).toMatch(/closeBus\s*\(/);
    expect(source).toMatch(/finally/);
    // NUNCA `await using`: es un ERROR DE SINTAXIS en Node 22, el runtime de este servicio.
    expect(source).not.toMatch(/await\s+using/);
  });
});
