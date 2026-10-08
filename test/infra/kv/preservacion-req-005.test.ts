import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readSource, sourceFiles } from '../../shared/source-scan.js';

/**
 * S-028 Tarea 6 (CA-5, CA-6): las propiedades que REQ-005 TENIA QUE PRESERVAR, verificadas.
 * TS-47 a TS-50.
 *
 * ============================================================================================
 * ESTA SUITE EXISTE PARA EVITAR EL PEOR FINAL DE UNA STORY DE CIERRE: que alguien "arregle" un
 * test de propiedad que estaba bien, o "mejore" una ausencia deliberada.
 * ============================================================================================
 *
 * # POR QUE NO SE AFIRMA CORRIENDO `git`
 *
 * CA-5 pide que los dos tests de propiedad del bus "sigan pasando SIN MODIFICARSE". La forma
 * ingenua de afirmarlo seria un test que ejecute `git log` sobre esos archivos — y es la forma
 * equivocada: seria fragil (depende del rango de commits, del rebase, del squash, de correr dentro
 * de un repo con historia), y sobre todo seria un test que mide EL HISTORIAL en vez de LA
 * PROPIEDAD. Un archivo puede haber cambiado de linea y seguir afirmando exactamente lo mismo.
 *
 * Asi que se hace de las dos formas que el Story Plan habilita, en orden:
 *
 * 1. **Verificacion manual documentada** en el cierre de la story: la corrida verde de las dos
 *    suites, y la comparacion byte a byte de los cuatro tests nombrados contra el commit anterior
 *    al primero de REQ-005. Su resultado, registrado acá para que quede en el repo y no solo en un
 *    mensaje de commit:
 *
 *    Rango de REQ-005: `ccb2909` (anterior a S-024) .. HEAD.
 *
 *    | Test | Archivo | Resultado |
 *    |---|---|---|
 *    | `invokes the SDK connect exactly once, in the file that imports it` | `test/bus/source-properties.test.ts` | **IDENTICO** |
 *    | `never opens a raw NATS connection outside the SDK` | `test/bus/source-properties.test.ts` | **IDENTICO** |
 *    | `never passes the whole AppConfig as a log context` | `test/config/source-properties.test.ts` | **IDENTICO** |
 *    | `keeps the startup line enumerating fields by hand, with no IMAP or poll value` | `test/config/source-properties.test.ts` | **IDENTICO** |
 *
 *    **MATIZ QUE IMPORTA Y QUE LA STORY NO ANTICIPO:** los dos ARCHIVOS si cambiaron durante
 *    REQ-005 — `bus/source-properties.test.ts` en S-027 (`5b8ea91`) y
 *    `config/source-properties.test.ts` en S-024 (`f5f7942`) y S-025 (`a322ca5`)—, pero **ninguno
 *    de los cuatro tests que CA-5 y CA-6 nombran fue tocado**. Los cambios fueron: AMPLIAR la
 *    allowlist de publicadores en UNA entrada (el tercer comando que ADR-003 permite) y AGREGAR las
 *    cuatro claves `kv` al escaner de configuracion. Las dos son ampliaciones de una lista cerrada,
 *    que es exactamente lo que ADR-003 prescribe —"la lista se AMPLIA una entrada por comando
 *    permitido; MUST NOT relajarse a un patron"—, no relajaciones de la propiedad. Lo que CA-5 pide
 *    en sustancia —que nadie haya debilitado esos dos tests para que el REQ pasara— se cumple.
 *
 * 2. **Este archivo**, que afirma sobre el CONTENIDO: que los cuatro tests siguen existiendo con su
 *    nombre y que su cuerpo sigue conteniendo los patrones clave. Es lo que detecta un
 *    debilitamiento FUTURO, que es de lo que hay que protegerse de acá en adelante.
 *
 * # NADA DE NUMEROS DE LINEA
 *
 * La story cita `:57-77` y `:80-90` porque el REQ los citó, pero **ya no coinciden**: el archivo
 * crecio. Anclar por numero de linea produciria un test que falla en el proximo cambio cosmetico y
 * que no verifica nada real. Se ancla POR NOMBRE DE TEST, siempre.
 */

const TEST_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const read = (relativePath: string): string =>
  readFileSync(`${TEST_ROOT}${relativePath}`, 'utf8');

/** El cuerpo de un `it('nombre', ...)` hasta el `it(` siguiente. */
function testBody(source: string, name: string): string {
  const start = source.indexOf(`it('${name}'`);
  if (start === -1) return '';
  const next = source.indexOf('\n  it(', start + 5);
  return source.slice(start, next === -1 ? source.length : next);
}

describe('CA-5: los dos tests de propiedad del bus siguen vigentes y no se debilitaron', () => {
  const BUS = read('bus/source-properties.test.ts');

  it('sanity: el archivo del escaner del bus se pudo leer y tiene contenido real', () => {
    // Sin esto, un path roto haria pasar todo lo de abajo contra un string vacio, en verde y sin
    // verificar nada. Es la regla del repo para todo escaner.
    expect(BUS.length).toBeGreaterThan(1_000);
    expect(BUS).toContain("describe('src/ bus source properties'");
  });

  // TS-47, primera mitad: el que escanea `src/` buscando un SEGUNDO `connect()`.
  it('TS-47: sigue existiendo el test que afirma UN SOLO connect() del SDK en todo src/', () => {
    const body = testBody(BUS, 'invokes the SDK connect exactly once, in the file that imports it');
    expect(body.length).toBeGreaterThan(200);

    // Los patrones clave que hacen que el test verifique algo. Si alguien los borrara, el test
    // seguiria existiendo y pasando SIN VERIFICAR NADA — que es el modo de falla contra el que este
    // caso protege.
    // Sigue buscando invocaciones de `connect(` con el lookbehind que evita el falso positivo de
    // `connectToBus(` — sin el, el test contaria dos y fallaria por la razon equivocada.
    expect(body).toContain('connect');
    expect(body).toContain('(?<![A-Za-z0-9_$])');
    // Y sigue CONTANDO: exactamente una. Es lo que distingue "importado una vez" (que es el test
    // hermano) de "invocado una vez".
    expect(body).toMatch(/toHaveLength\(1\)/);
    // Anclado al archivo autorizado, por la constante del propio archivo.
    expect(body).toContain('BUS_CONNECTION');
  });

  // TS-47, segunda mitad: el que busca `from 'nats'`.
  it("TS-47: sigue existiendo el test que prohibe importar 'nats' fuera del SDK", () => {
    const body = testBody(BUS, 'never opens a raw NATS connection outside the SDK');
    expect(body.length).toBeGreaterThan(100);

    // El patron literal que busca el import prohibido. DOS COPIAS DE `nats-core` EN EL ARBOL SON
    // DOS JUEGOS DE CLASES DE ERROR, y `error instanceof X` falla contra la copia que lanzo
    // (ADR-002). Es la razon por la que el KV es el del SDK (`client.kv()`, S-032) y no el de
    // `@nats-io/kv`.
    expect(body).toContain("'nats'");
    // Y sigue afirmando que la lista de infractores esta VACIA: es la forma que hace que el test
    // nombre el archivo culpable cuando falla, en vez de un `false` sin contexto.
    expect(body).toMatch(/toEqual\(\[\]\)/);
  });

  // TS-48: la razon POSITIVA de que los dos de arriba sigan pasando con el KV agregado. Desde S-032
  // el import del bus del modulo del KV es la ENTRADA PRINCIPAL del SDK (`client.kv()`, el tipo `KV`
  // y sus clases de error), ya no el subpath `./nats`, que no re-exporta ningun KV.
  it('TS-48: el modulo del KV no importa connect ni nats — su unico import del bus es la entrada principal del SDK', () => {
    const kvFiles = sourceFiles().filter((file) => file.relativePath.startsWith('infra/kv'));

    // Sanity del escaner: sin esto, un filtro que no matchea nada haria pasar el bucle vacio.
    expect(kvFiles.length).toBeGreaterThanOrEqual(4);

    for (const file of kvFiles) {
      expect(
        /import\s*\{[^}]*\bconnect\b[^}]*\}\s*from\s*'@gravadigital\/jiku'/.test(file.code),
        `${file.relativePath} importa connect del SDK: el UNICO connect() vive en infra/bus/connection.ts`,
      ).toBe(false);
      expect(
        /from\s*'nats'/.test(file.code),
        `${file.relativePath} importa 'nats' directo`,
      ).toBe(false);
      expect(
        /from\s*'@nats-io\//.test(file.code),
        `${file.relativePath} importa '@nats-io/*' directo`,
      ).toBe(false);
    }

    // Y el import del bus del modulo es la ENTRADA PRINCIPAL: ningun archivo toma nada del subpath
    // `./nats`, y el que abre el espacio importa de `'@gravadigital/jiku'`.
    for (const file of kvFiles) {
      expect(
        /from\s*'@gravadigital\/jiku\/nats'/.test(file.code),
        `${file.relativePath} importa del subpath ./nats: el KV es el de la entrada principal (S-032)`,
      ).toBe(false);
    }
    const space = kvFiles.find((file) => file.relativePath.endsWith('space.ts'));
    expect(space?.code).toMatch(/from\s*'@gravadigital\/jiku'/);
  });

  // TS-39, la mitad que faltaba: `infra/kv/source-properties.test.ts` ya afirma que ningun archivo
  // de `src/` crea un bucket. Lo que no estaba afirmado es que el UNICO lugar del REPO —tests
  // incluidos— que lo crea viva en `createBucket()`, que es el que representa al deploy de Jiku
  // creando `JIKU_KV`. (Hasta S-032 era `seedBucket()` con `kvm.create()`: dos buckets propios
  // creados con el KV crudo. Desde REQ-008 hay un solo bucket, y se crea con la API de JetStream.)
  it('TS-39: el unico lugar del repo que crea un bucket es createBucket() de test/infra/kv/helpers.ts', () => {
    // Sin comentarios: la cabecera del helper nombra el subject para explicar que hace.
    const helpers = read('infra/kv/helpers.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    // Se ancla a la IMPLEMENTACION, no a la declaracion de la interfaz: `createBucket` aparece dos
    // veces en el archivo (el campo de `JetStreamNats` y la funcion que lo cumple).
    const createIdx = helpers.indexOf('const createBucket = async (');
    expect(createIdx, 'createBucket debe seguir siendo el que crea el bucket').toBeGreaterThan(-1);
    const createBody = helpers.slice(createIdx, helpers.indexOf('};', createIdx));
    expect(createBody).toMatch(/STREAM\.CREATE\.KV_JIKU_KV/);

    // Y el subject aparece en el archivo EXACTAMENTE una vez: si hubiera una segunda, la excepcion
    // habria dejado de ser una.
    expect(helpers.match(/STREAM\.CREATE/g) ?? []).toHaveLength(1);

    // Ningun archivo de `src/` crea un bucket, ni con la API de JetStream ni con el KV crudo.
    // (`infra/kv/source-properties.test.ts` ya lo afirma con sus propios patrones; aca se afirma la
    // contraparte de la excepcion, para que el conjunto "prohibido en src, permitido SOLO en ese
    // helper" quede completo y nombrado.)
    for (const file of sourceFiles()) {
      expect(
        /STREAM\.CREATE/.test(file.code),
        `${file.relativePath} crea un stream: el conector NO crea buckets (ADR-004)`,
      ).toBe(false);
      expect(
        /\bkvm\s*\.\s*create\s*\(/.test(file.code),
        `${file.relativePath} crea un bucket con el KV crudo`,
      ).toBe(false);
    }
  });
});

describe('CA-6: el AppConfig completo sigue sin loguearse', () => {
  const CONFIG = read('config/source-properties.test.ts');

  it('sanity: el archivo del escaner de configuracion se pudo leer y tiene contenido real', () => {
    expect(CONFIG.length).toBeGreaterThan(1_000);
  });

  // TS-49
  it('TS-49: sigue existiendo el test que prohibe pasar el AppConfig entero como contexto de log', () => {
    const body = testBody(CONFIG, 'never passes the whole AppConfig as a log context');
    expect(body.length).toBeGreaterThan(100);
    // Los patrones que hacen que verifique algo.
    expect(body).toMatch(/config/);
    expect(body).toMatch(/toBe\(false\)|not\.toMatch|toEqual\(\[\]\)|toHaveLength\(0\)/);
  });

  it('TS-49: y el que afirma que la linea de arranque enumera campos a mano', () => {
    const body = testBody(
      CONFIG,
      'keeps the startup line enumerating fields by hand, with no IMAP or poll value',
    );
    expect(body.length).toBeGreaterThan(100);
  });

  // TS-50 — el escaneo propio: ningun punto de log de `src/` emite `config`, `config.kv` ni `kv`.
  it('TS-50: ningun punto de log emite config, config.kv ni el bloque kv entero', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(20);

    for (const file of files) {
      // `logger.X({ config })`, `logger.X({ config: ... })`, `logger.X(config, ...)` y las
      // variantes con `kv`. El contexto de log es PLANO de un nivel (la redaccion de Pino no tiene
      // comodin profundo), asi que un objeto de configuracion ahi dejaria sus secretos en claro.
      for (const pattern of [
        /logger\s*\.\s*\w+\s*\(\s*config\s*[,)]/,
        /logger\s*\.\s*\w+\s*\(\s*\{\s*config\s*[,}]/,
        /logger\s*\.\s*\w+\s*\(\s*\{\s*config\s*:/,
        /logger\s*\.\s*\w+\s*\(\s*config\s*\.\s*kv\s*[,)]/,
        /logger\s*\.\s*\w+\s*\(\s*\{\s*kv\s*[,}]/,
        /logger\s*\.\s*\w+\s*\(\s*\{\s*kv\s*:\s*config/,
      ]) {
        expect(
          pattern.test(file.code),
          `${file.relativePath} pasa configuracion como contexto de log (${String(pattern)})`,
        ).toBe(false);
      }
    }
  });

  // Desde S-032 la unica linea del KV es la de `openKvSpace()` (`'espacio KV abierto'`): ya no hay
  // bloque `kv` en el `AppConfig`, pero la propiedad es la misma — los campos se enumeran a mano.
  it('TS-50: la linea del espacio KV enumera sus campos A MANO, no un bloque entero', () => {
    const space = readSource('infra/kv/space.ts');

    // La linea de exito: el bucket y el prefijo de la identidad, enumerados.
    const lineIdx = space.indexOf("'espacio KV abierto'");
    expect(lineIdx).toBeGreaterThan(-1);
    const call = space.slice(space.lastIndexOf('logger.info(', lineIdx), lineIdx);
    expect(call).toMatch(/\bbucket\s*:/);
    expect(call).toMatch(/\bkvPrefix\s*:/);

    // Y NO pasa un objeto armado afuera ni un spread: enumerarlos a mano es lo que hace que un campo
    // nuevo no termine en el log por accidente. Ni un campo llamado `key`, que `REDACT_PATHS`
    // censuraria sin avisar.
    expect(call).not.toMatch(/\.\.\./);
    expect(call).not.toMatch(/\bkey\s*:/);
    expect(space).not.toMatch(/logger\s*\.\s*\w+\s*\(\s*\{\s*config\b/);
  });
});
