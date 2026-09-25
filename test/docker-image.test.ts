import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cleanupKeyFiles, generateServiceAccountKeyFile, writeRawKeyFile } from './bus/auth-helpers.js';

/**
 * Propiedades de la IMAGEN CONSTRUIDA: lo que la imagen resulta ser, no lo que el Dockerfile dice.
 *
 * **Este archivo requiere Docker** — construye la imagen y la ejecuta como contenedor real. Docker
 * ya es una precondicion declarada de la suite (el `globalSetup` levanta un NATS con
 * Testcontainers), asi que no agrega ninguna dependencia nueva.
 *
 * Verifica exactamente lo que `test/dockerfile.test.ts` NO puede verificar leyendo el archivo: que
 * la imagen ARRANCA, que el proceso es no-root de verdad, que no hay ningun secreto ni fuente
 * TypeScript adentro, y que con configuracion incompleta no arranca informando la lista completa.
 * Hay una clase entera de fallo que pasa todas las verificaciones estaticas y muere al arrancar:
 * el `package.json` ausente (ERR_PACKAGE_IMPORT_NOT_DEFINED), el `dist/` mal ubicado
 * (ERR_MODULE_NOT_FOUND) y el usuario sin permisos sobre /app. Es el mismo argumento de
 * `test/build-runtime.test.ts`, un nivel mas arriba: alla se ejecuta el `dist/` como proceso, aca
 * la imagen como contenedor.
 */

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * `:vitest` y no `:test`, deliberadamente: el README documenta `--target test -t
 * jiku-email-tickets:test` para la etapa de la SUITE, y reusar esa etiqueta aca haria que una
 * corrida de tests pisara la imagen de la otra etapa —o al reves— produciendo un verde o un rojo
 * que no corresponde a lo que se creyo construir.
 */
const IMAGE_TAG = 'jiku-email-tickets:vitest';

/** Las mismas listas que `test/manifest.test.ts` afirma sobre el package.json. Dos listas divergen. */
const DATABASE_CLIENTS = [
  'pg',
  'sequelize',
  'sequelize-typescript',
  'typeorm',
  'prisma',
  'knex',
] as const;

const STORAGE_CLIENTS = [
  '@aws-sdk/client-s3',
  '@aws-sdk/s3-request-presigner',
  'aws-sdk',
  'minio',
  '@google-cloud/storage',
  '@azure/storage-blob',
] as const;

/**
 * Las devDependencies que NO pueden estar en la imagen.
 *
 * `typescript` NO esta en la lista, y no por comodidad: es un **peer dependency de
 * `@t3-oss/env-core`**, que es dependencia de PRODUCCION, asi que `npm ci --omit=dev` lo instala
 * correctamente y su presencia no es una fuga de devDependencies. Que ademas figure en
 * `devDependencies` es lo que hace confusa la observacion: son dos caminos distintos al mismo
 * paquete, y el que sobrevive al `--omit=dev` es el de produccion. Afirmar su ausencia seria pedirle
 * a la imagen algo que la rompe.
 */
const DEV_ONLY_DEPENDENCIES = ['vitest', 'testcontainers', 'pino-pretty'] as const;

const VALID_ENV = {
  JIKU_CREDS: '/run/secrets/sentinel.creds',
  JIKU_KEY_FILE: '/run/secrets/machine-user.json',
  JIKU_PROJECT_ID: '307f1f77bcf86cd799439011',
  JIKU_VERIFY_PROJECT_ID: '42',
  // Requeridas desde S-007.
  IMAP_HOST: 'imap.gmail.com',
  IMAP_USER: 'tickets@ejemplo.com',
  IMAP_PASSWORD: 'app-password-de-prueba',
  // Requerida desde S-012, en una de sus dos fuentes.
  TICKET_MAP: '{"alfa":42}',
};

/**
 * Las SIETE requeridas. Eran cuatro hasta S-006; S-007 sumo las tres de la casilla y S-012 el Mapa
 * de Tickets, cuya obligatoriedad es cross-field: lo requerido es UNA de sus dos fuentes, y el
 * reporte lo nombra por TICKET_MAP.
 *
 * BAJARON DE OCHO A SIETE al volverse OPCIONAL `JIKU_VERIFY_PROJECT_ID`: la lee un solo consumidor
 * (`src/verify.ts`), y el worker no la toca, asi que exigirsela a todo despliegue obligaba a
 * declarar un proyecto de prueba para correr un proceso que no lo usa. El fail-fast no se perdio,
 * se mudo a `requireVerifyProjectId()` en ese script. Fue la primera vez que esta lista ENCOGIO.
 *
 * Y BAJARON DE SIETE A SEIS en S-025, la segunda vez: `TICKET_MAP` ya no se declara en ningun lado
 * porque el Mapa de Tickets se mudo a un bucket KV del bus. El fail-fast tampoco se perdio —se mudo
 * al arranque, que falla nombrando el bucket si no existe (S-024)—, pero ya no es un fallo de
 * VALIDACION DE ENTORNO, que es lo que esta lista enumera.
 */
const REQUIRED_VARIABLES = [
  'JIKU_CREDS',
  'JIKU_KEY_FILE',
  'JIKU_PROJECT_ID',
  'IMAP_HOST',
  'IMAP_USER',
  'IMAP_PASSWORD',
];

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

/**
 * Corre la imagen con el entorno EXPLICITO, un `-e` por variable, sin heredar nada del host.
 *
 * Es el `runDist()` de `build-runtime.test.ts` un nivel mas arriba, y el principio es el mismo: un
 * test que hereda el entorno pasa o falla segun lo que el desarrollador tenga exportado en su
 * shell, que es el fallo intermitente que la convencion `testing` prohibe. Un contenedor solo ve
 * lo que se le pasa, asi que el aislamiento es aun mas fuerte que con un proceso hijo.
 *
 * `spawnSync` y no `execFileAsync`: la mayoria de estas corridas salen con codigo != 0 —el bus no
 * es alcanzable desde el test— y `execFileAsync` RECHAZA en ese caso, escondiendo los streams justo
 * cuando son lo que hay que afirmar.
 */
function runImage(env: Record<string, string>, extraArgs: readonly string[] = []): RunResult {
  const envArgs = Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
  const result = spawnSync(
    'docker',
    ['run', '--rm', ...envArgs, ...extraArgs, IMAGE_TAG],
    { encoding: 'utf8', timeout: 60_000 },
  );

  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

/** Un comando de shell DENTRO de la imagen, para las inspecciones del sistema de archivos. */
function inImage(shellCommand: string): RunResult {
  const result = spawnSync(
    'docker',
    ['run', '--rm', '--entrypoint', 'sh', IMAGE_TAG, '-c', shellCommand],
    { encoding: 'utf8', timeout: 60_000 },
  );

  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

/** Una key RSA REAL: sin ella `ServiceUser` corta en la validacion y el montaje nunca se ejercita. */
let VALID_KEY_FILE: string;

/** Un creds LEIBLE: el SDK lo lee antes de abrir el socket, asi que una ruta inexistente corta antes. */
let READABLE_CREDS: string;

describe('the production image', () => {
  beforeAll(async () => {
    // Una sola construccion para todo el archivo: es lo mas lento de la suite y no hay razon para
    // repetirlo por caso.
    const build = spawnSync(
      'docker',
      ['build', '--target', 'production', '-t', IMAGE_TAG, '.'],
      { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 600_000 },
    );

    // TS-13: la imagen se construye. Se afirma aca y no en un `it` aparte porque si el build falla
    // todos los demas casos fallan sin informacion util; asi el mensaje del build llega entero.
    expect(build.status, `docker build failed:\n${build.stderr}`).toBe(0);

    VALID_KEY_FILE = await generateServiceAccountKeyFile();
    READABLE_CREDS = await writeRawKeyFile('-----BEGIN NATS USER JWT-----\nno-importa\n------END NATS USER JWT------');
  }, 600_000);

  afterAll(async () => {
    await cleanupKeyFiles();
    // Tolerando el fallo: si ya no existe, no hay nada que limpiar.
    spawnSync('docker', ['image', 'rm', '-f', IMAGE_TAG], { encoding: 'utf8', timeout: 60_000 });
  });

  // TS-13
  it('builds', () => {
    const inspect = spawnSync('docker', ['image', 'inspect', IMAGE_TAG], { encoding: 'utf8' });
    expect(inspect.status).toBe(0);
  }, 60_000);

  // TS-14
  it('runs its process as a non-root user', () => {
    const uid = spawnSync('docker', ['run', '--rm', '--entrypoint', 'id', IMAGE_TAG, '-u'], {
      encoding: 'utf8',
      timeout: 60_000,
    });

    expect(uid.status).toBe(0);
    expect(uid.stdout.trim()).not.toBe('0');
    // Y el uid exacto que el Dockerfile declara, para que un `USER` cambiado por accidente —a otro
    // no-root cualquiera— tambien se detecte.
    expect(uid.stdout.trim()).toBe('1001');

    const name = spawnSync('docker', ['run', '--rm', '--entrypoint', 'id', IMAGE_TAG, '-un'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(name.stdout.trim()).toBe('connector');
  }, 60_000);

  // TS-15
  it('ships no dev-only dependency', () => {
    for (const name of DEV_ONLY_DEPENDENCIES) {
      const result = inImage(`test -e node_modules/${name} && echo PRESENT || echo ABSENT`);
      expect(result.stdout.trim(), `${name} must not be in the image`).toBe('ABSENT');
    }
  }, 120_000);

  it('ships no test tooling and no compiler entry point that could run at startup', () => {
    // El complemento del caso anterior, y la razon por la que la ausencia de `typescript` no se
    // puede afirmar: lo que importa no es que el paquete no exista —lo trae `@t3-oss/env-core` como
    // peer de produccion— sino que la imagen no traiga NINGUNA herramienta de test, y que el
    // binario del compilador no sea parte de lo que el contenedor puede ejecutar por accidente.
    const testDir = inImage('test -d /app/test && echo PRESENT || echo ABSENT');
    expect(testDir.stdout.trim()).toBe('ABSENT');

    const vitestConfig = inImage('test -f /app/vitest.config.ts && echo PRESENT || echo ABSENT');
    expect(vitestConfig.stdout.trim()).toBe('ABSENT');
  }, 120_000);

  // TS-16
  it('ships the build output and package.json, and no TypeScript source', () => {
    const src = inImage('test -d /app/src && echo PRESENT || echo ABSENT');
    expect(src.stdout.trim()).toBe('ABSENT');

    const dist = inImage('test -d /app/dist && echo PRESENT || echo ABSENT');
    expect(dist.stdout.trim()).toBe('PRESENT');

    // El `package.json` NO es un residuo: el campo `imports` vive ahi y es lo que resuelve los
    // prefijos `#` en runtime. Sin el, la imagen se construye perfecta y muere al arrancar.
    const manifest = inImage('test -f /app/package.json && echo PRESENT || echo ABSENT');
    expect(manifest.stdout.trim()).toBe('PRESENT');
  }, 120_000);

  // TS-17
  it('ships no database client and no storage client', () => {
    for (const name of [...DATABASE_CLIENTS, ...STORAGE_CLIENTS]) {
      const result = inImage(`test -e node_modules/${name} && echo PRESENT || echo ABSENT`);
      expect(result.stdout.trim(), `${name} must not be in the image`).toBe('ABSENT');
    }
  }, 180_000);

  // TS-18
  it('ships no nats package of its own', () => {
    // El SDK trae `@nats-io/*`, que SI puede existir y es correcto: lo prohibido es el cliente
    // `nats` como dependencia propia del conector (ADR-002).
    const result = inImage('test -e node_modules/nats && echo PRESENT || echo ABSENT');
    expect(result.stdout.trim()).toBe('ABSENT');
  }, 60_000);

  // TS-19
  it('bakes no secret file into the image', () => {
    // `ls /app` no puede probar una negativa universal, y no hay que pretenderlo: lo que se afirma
    // es lo concreto y verificable —ningun `.env*`, ninguna key `.json` suelta, ningun `.creds` en
    // /app, y /run/secrets vacio o inexistente— que son exactamente las vias por las que un secreto
    // llegaria a la imagen. Vale mas un test imperfecto que se ejecuta que una regla que solo vive
    // en un documento.
    const app = inImage("ls -a /app | tr '\\n' ' '");
    expect(app.status).toBe(0);
    expect(app.stdout).not.toMatch(/\.env/);
    expect(app.stdout).not.toMatch(/\.creds/);
    expect(app.stdout).not.toMatch(/\.pem/);

    // El unico .json de /app tiene que ser el package.json (y su lock). El `toContain` previo no
    // es redundante: sin el, un `ls` que no devolviera nada —glob roto, layout cambiado— haria que
    // el for no iterara y la asercion pasara en vacio, que es la forma en que este tipo de caso
    // deja de proteger sin avisar.
    const jsonFiles = inImage("ls /app/*.json 2>/dev/null | tr '\\n' ' '");
    expect(jsonFiles.stdout).toContain('package.json');
    for (const path of jsonFiles.stdout.trim().split(/\s+/).filter((entry) => entry !== '')) {
      expect(path).toMatch(/package(-lock)?\.json$/);
    }

    const secrets = inImage("ls -A /run/secrets 2>/dev/null | tr '\\n' ' '");
    expect(secrets.stdout.trim()).toBe('');
  }, 120_000);

  // TS-21
  it('ships no git history', () => {
    const result = inImage('test -d /app/.git && echo PRESENT || echo ABSENT');
    expect(result.stdout.trim()).toBe('ABSENT');
  }, 60_000);

  // TS-22
  it('starts: resolves its subpath imports and validates its configuration', () => {
    const result = runImage({ ...VALID_ENV, NODE_ENV: 'production' });

    // Las dos regresiones que la imagen puede tener sin que el build lo note: `imports` ausente
    // (ERR_PACKAGE_IMPORT_NOT_DEFINED) y mal apuntado (ERR_MODULE_NOT_FOUND).
    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(result.stderr).not.toContain('ERR_PACKAGE_IMPORT_NOT_DEFINED');

    const first = result.stdout.split('\n').filter((line) => line.trim() !== '')[0] as string;
    const line = JSON.parse(first) as Record<string, unknown>;

    expect(line['msg']).toBe('configuracion valida');
    expect(line['service']).toBe('jiku-email-tickets');
    expect(line['level']).toBe('info');
  }, 120_000);

  // TS-23
  it('does not start with an incomplete configuration, and reports the complete list', () => {
    const result = runImage({ JIKU_INSTANCE: 'dev' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('la configuracion es invalida');
    // Los SEIS nombres, no el primero que encontro: quien despliega tiene que poder arreglar
    // todo de una vez en lugar de descubrirlos de a uno por reinicio.
    for (const name of REQUIRED_VARIABLES) {
      expect(result.stderr).toContain(name);
    }
    // Sin linea JSON: el fallo de configuracion ocurre ANTES de que el logger exista, asi que sale
    // por stderr. La asimetria es deliberada (ADR-006).
    expect(result.stdout.trim()).toBe('');
  }, 120_000);

  // TS-24
  it('logs JSON to stdout, because pino-pretty is not in the image', () => {
    const result = runImage(VALID_ENV);

    const first = result.stdout.split('\n').filter((line) => line.trim() !== '')[0] as string;
    const line = JSON.parse(first) as Record<string, unknown>;

    expect(line).toHaveProperty('level');
    expect(line).toHaveProperty('msg');
    expect(line).toHaveProperty('service');
  }, 120_000);

  // TS-25
  it('never dumps its secret paths to stdout', () => {
    const result = runImage({ ...VALID_ENV, NODE_ENV: 'production' });

    // Donde esta el secreto es informacion sobre el secreto: las rutas quedan fuera de la linea de
    // arranque igual que el contenido (ADR-006).
    expect(result.stdout).not.toContain(VALID_ENV.JIKU_CREDS);
    expect(result.stdout).not.toContain(VALID_ENV.JIKU_KEY_FILE);
    expect(result.stdout).not.toContain(VALID_ENV.JIKU_PROJECT_ID);
  }, 120_000);

  // TS-26
  it('reads a read-only mounted key and fails without dumping its contents', () => {
    const result = runImage(
      {
        ...VALID_ENV,
        JIKU_KEY_FILE: '/run/secrets/key.json',
        JIKU_CREDS: '/run/secrets/sentinel.creds',
        JIKU_SERVERS: 'nats://127.0.0.1:1',
        NODE_ENV: 'production',
      },
      [
        '-v', `${VALID_KEY_FILE}:/run/secrets/key.json:ro`,
        '-v', `${READABLE_CREDS}:/run/secrets/sentinel.creds:ro`,
      ],
    );

    expect(result.status).not.toBe(0);

    const failure = result.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line['level'] === 'fatal');

    // Que el fallo sea de CONEXION y no de key es la prueba de que la key montada se leyo: con una
    // key ilegible el arranque cortaria antes, en `BUS_KEY_LOAD_ERROR`.
    expect(failure).toBeDefined();
    expect(failure?.['code']).toBe('BUS_CONNECT_ERROR');

    const everything = `${result.stdout}${result.stderr}`;
    expect(everything).not.toContain('BEGIN RSA');
  }, 120_000);

  // TS-27
  it('starts the worker without publishing anything', () => {
    // `JIKU_SERVERS` a un puerto cerrado garantiza terminacion rapida: el CMD deja el worker VIVO
    // si la conexion tuviera exito, y un `docker run` sin garantia de terminacion en un test es
    // una suite colgada esperando a que alguien la mate.
    const result = runImage(
      {
        ...VALID_ENV,
        JIKU_KEY_FILE: '/run/secrets/key.json',
        JIKU_CREDS: '/run/secrets/sentinel.creds',
        JIKU_SERVERS: 'nats://127.0.0.1:1',
        NODE_ENV: 'production',
      },
      [
        '-v', `${VALID_KEY_FILE}:/run/secrets/key.json:ro`,
        '-v', `${READABLE_CREDS}:/run/secrets/sentinel.creds:ro`,
      ],
    );

    // Muere por el fallo de conexion, no por haber publicado. Nada de lo que emite menciona un
    // requisito creado — que es lo que un `CMD` que corriera `verify` dejaria como rastro.
    expect(result.stdout).not.toContain('requirementId');
    expect(result.stdout).not.toContain('requisito');
  }, 120_000);

  // TS-28
  it('ships the verification entry point but keeps it out of the CMD', () => {
    // Tiene que VIAJAR en la imagen: U-02 necesita poder correrlo contra el despliegue con
    // `docker exec` o un contenedor de un solo uso. Lo que no puede es ser el CMD (ADR-003: cada
    // reinicio dejaria un requisito permanente que nadie puede limpiar).
    const present = inImage('test -f /app/dist/verify.js && echo PRESENT || echo ABSENT');
    expect(present.stdout.trim()).toBe('PRESENT');

    const inspect = spawnSync(
      'docker',
      ['image', 'inspect', '--format', '{{json .Config.Cmd}}', IMAGE_TAG],
      { encoding: 'utf8', timeout: 60_000 },
    );
    const cmd = JSON.parse(inspect.stdout.trim()) as string[];

    expect(cmd).toEqual(['node', 'dist/index.js']);
    expect(cmd.join(' ')).not.toContain('verify');
  }, 120_000);
});
