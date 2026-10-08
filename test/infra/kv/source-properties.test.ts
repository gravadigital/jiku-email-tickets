import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readSource, sourceFiles } from '../../shared/source-scan.js';

/**
 * Las propiedades del KV de la forma "no existe ningun camino de codigo que X" (S-024/S-026,
 * reescritas en S-032 para el Espacio KV del SDK: TS-71 y TS-73 a TS-82 de su Story Plan).
 *
 * Un test de comportamiento no puede afirmar eso —solo puede probar los caminos que ejercita— asi
 * que se escanea `src/` con los comentarios stripeados (`test/shared/source-scan.ts`). Stripearlos
 * es imprescindible: los modulos del KV nombran `watch`, `ttl`, `delete()` y `create()` en sus
 * comentarios justamente para explicar por que NO los usan, y sin stripear cada explicacion haria
 * fallar su propio test.
 *
 * Cada caso sostiene una decision que se puede romper por accidente en un refactor
 * bienintencionado, y su comentario nombra ESE refactor:
 *
 * - El KV es el del SDK (`client.kv()`), no el crudo de `@nats-io/kv` (REQ-008, ADR-002).
 * - El espacio se abre en UN lugar, sobre la conexion UNICA, y viaja por parametro.
 * - El conector nunca borra, nunca hace `watch`, nunca lee la antiguedad de una entrada, nunca crea
 *   un bucket: los hilos no expiran (invariante 32) y el bucket lo crea el deploy de Jiku.
 * - La consulta del slug no se guarda ni se reintenta: un alta o una baja vale desde el mail
 *   siguiente (ADR-001, ADR-004 reformulada).
 * - El `\Seen` sigue siendo la unica marca de idempotencia, y la consulta del slug va antes de
 *   subir adjuntos.
 */

const SRC_ROOT = fileURLToPath(new URL('../../../src/', import.meta.url));
const TEST_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** La ruta relativa con `/`, sea cual sea el separador del sistema. */
const posix = (path: string): string => path.split(sep).join('/');

const FILES = sourceFiles().map((file) => ({ ...file, relativePath: posix(file.relativePath) }));
const KV_FILES = FILES.filter((file) => file.relativePath.startsWith('infra/kv/'));

const SPACE = 'infra/kv/space.ts';
const TICKETS = 'infra/kv/tickets.ts';
const THREADS = 'infra/kv/threads.ts';
const KEYS = 'infra/kv/keys.ts';
const ERRORS = 'infra/kv/errors.ts';
const TICK = 'domain/ingesta/tick.ts';
const SCHEDULER = 'domain/ingesta/scheduler.ts';

function codeOf(relativePath: string): string {
  const file = FILES.find((candidate) => candidate.relativePath === relativePath);
  if (file === undefined) throw new Error(`el escaner no encontro ${relativePath}`);
  return file.code;
}

/** Quita comentarios de un archivo de `test/` (mismo criterio que `source-scan.ts` para `src/`). */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Todos los `.ts` de `test/`, con su codigo sin comentarios (TS-82 escanea tambien los tests). */
function testFiles(dir: string = TEST_ROOT): { relativePath: string; code: string }[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return testFiles(full);
    if (!full.endsWith('.ts')) return [];
    return [{ relativePath: posix(relative(TEST_ROOT, full)), code: stripComments(readFileSync(full, 'utf8')) }];
  });
}

describe('src/ kv source properties', () => {
  it('finds the source files it is meant to scan', () => {
    // Sin esta sanidad, un escaner roto pasaria todos los tests de abajo sin verificar nada.
    expect(FILES.length).toBeGreaterThan(3);
    const paths = FILES.map((file) => file.relativePath);
    for (const expected of [SPACE, TICKETS, THREADS, KEYS, ERRORS, TICK, SCHEDULER]) {
      expect(paths).toContain(expected);
    }
    expect(KV_FILES.length).toBeGreaterThanOrEqual(5);
    // Y el codigo llego sin comentarios pero CON contenido.
    expect(codeOf(SPACE)).toContain('openKvSpace');
    expect(codeOf(TICKETS)).toContain('lookupTicket');
  });

  // TS-74 (CA-2). Lo romperia "volver a lo de antes": un `new Kvm(client.connection)` porque el
  // KV crudo lista claves o hace `watch()`. Desde REQ-008 el KV es el del SDK, sus errores son las
  // clases del SDK, y `@gravadigital/jiku/nats` ya no re-exporta ningun KV.
  it('TS-74: ningun archivo usa el KV crudo; el KV y sus errores salen de la entrada principal del SDK', () => {
    for (const file of FILES) {
      expect(/from\s*'nats'/.test(file.code), `${file.relativePath} importa 'nats'`).toBe(false);
      expect(/from\s*'@nats-io\//.test(file.code), `${file.relativePath} importa @nats-io/* directo`).toBe(
        false,
      );
      expect(/\bKvm\b/.test(file.code), `${file.relativePath} nombra Kvm`).toBe(false);

      // Nada del KV por el subpath `./nats`, aunque el SDK lo volviera a exportar.
      for (const match of file.code.matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'@gravadigital\/jiku\/nats'/g,
      )) {
        const names = (match[1] ?? '')
          .split(',')
          .map((name) => name.replace(/^\s*type\s+/, '').trim().split(/\s+as\s+/)[0]);
        for (const forbidden of ['KV', 'Kvm', 'KvWatchEntry', 'KvWatchInclude', 'QueuedIterator']) {
          expect(names, `${file.relativePath} toma ${forbidden} de @gravadigital/jiku/nats`).not.toContain(
            forbidden,
          );
        }
      }
    }

    // Y los cuatro modulos que tocan el KV importan de la ENTRADA PRINCIPAL del SDK.
    for (const path of [SPACE, TICKETS, THREADS, ERRORS]) {
      expect(codeOf(path), `${path} no importa de '@gravadigital/jiku'`).toMatch(/from\s*'@gravadigital\/jiku'/);
    }
  });

  // TS-75 (CA-3). Lo romperia "abrir el espacio donde se usa": un `client.kv()` en el tick o en
  // `lookupTicket()`. El SDK cachea el bind, pero el handle tiene que viajar por parametro: es lo
  // que deja un solo punto de fallo del arranque y lo que hace inyectable el espacio en los tests.
  it('TS-75: client.kv() aparece UNA vez en todo src/, en space.ts, y space.ts no guarda estado', () => {
    const calls = FILES.flatMap((file) =>
      (file.code.match(/\.kv\s*\(/g) ?? []).map(() => file.relativePath),
    );
    expect(calls).toEqual([SPACE]);
    expect(/^let\s/m.test(codeOf(SPACE)), 'space.ts declara un let de modulo').toBe(false);
  });

  // TS-76 (CA-17). Lo romperia "limpiar" un hilo viejo o un slug dado de baja desde el conector. El
  // conector no borra: las bajas son de U-02, y `KvSpace` ni siquiera expone `delete()`.
  it('TS-76: no hay delete() sobre el espacio en el modulo del KV ni en el tick', () => {
    const scanned = [...KV_FILES.map((file) => file.relativePath), TICK, SCHEDULER];
    expect(scanned.length).toBeGreaterThanOrEqual(7);
    for (const path of scanned) {
      expect(/\.delete\s*\(/.test(codeOf(path)), `${path} llama a delete()`).toBe(false);
    }
  });

  // TS-77 (CA-17, invariante 32). Lo romperia "expirar hilos viejos a mano" (leer `entry.created` y
  // descartar los de mas de N dias) o volver a seguir el Mapa de Tickets con `watch()`. Los hilos no
  // expiran: una entrada de cualquier antiguedad matchea.
  it('TS-77: no hay watch(), ni ttl, ni lectura de entry.created en src/', () => {
    for (const file of FILES) {
      expect(/\bwatch\s*\(/.test(file.code), `${file.relativePath} usa watch()`).toBe(false);
      expect(/\bttl\b/i.test(file.code), `${file.relativePath} menciona un ttl en el codigo`).toBe(false);
      expect(/\.created\b/.test(file.code), `${file.relativePath} lee .created`).toBe(false);
    }
  });

  // TS-78 (CA-17, ADR-004). Lo romperia "crear el bucket si no existe" para que el arranque no
  // falle. Crearlo ante un despliegue incompleto dejaria un bucket sin `allow_direct` ni limites y
  // un conector que descarta todo en silencio; el bucket lo crea el deploy de Jiku.
  it('TS-78: no se crean, modifican ni borran buckets desde src/', () => {
    for (const file of FILES) {
      expect(/STREAM\.(CREATE|UPDATE|DELETE)/.test(file.code), `${file.relativePath} toca un stream`).toBe(false);
      expect(/jetstream(Manager)?\s*\(/i.test(file.code), `${file.relativePath} usa la API de JetStream`).toBe(
        false,
      );
      expect(/\$JS\.API/.test(file.code), `${file.relativePath} arma un subject de $JS.API`).toBe(false);
    }
    for (const file of KV_FILES) {
      expect(/\.create\s*\(/.test(file.code), `${file.relativePath} llama a create()`).toBe(false);
    }
  });

  // TS-79 (CA-14). Lo romperia "cachear el slug para no pagar un round-trip por mail". Con cache,
  // un alta o una baja de U-02 dejaria de valer desde el mail siguiente, que es la promesa de
  // REQ-008, y volveria la copia en memoria que se borro con el `watch()`.
  it('TS-79: el resultado de lookupTicket() no se guarda en ningun lado', () => {
    const tickets = codeOf(TICKETS);
    expect(/new\s+Map[^(]*\(/.test(tickets), 'tickets.ts declara un Map').toBe(false);
    expect(/new\s+Set[^(]*\(/.test(tickets), 'tickets.ts declara un Set').toBe(false);
    expect(/^let\s/m.test(tickets), 'tickets.ts declara un let de modulo').toBe(false);
    expect(
      /^\s*(?:const|let|var)\s+\w+\s*:\s*Record</m.test(tickets),
      'tickets.ts declara un Record que acumularia resultados',
    ).toBe(false);

    const tick = codeOf(TICK);
    expect(/new\s+Map[^(]*\(/.test(tick), 'tick.ts declara un Map').toBe(false);
    expect(/new\s+Set[^(]*\(/.test(tick), 'tick.ts declara un Set').toBe(false);
    // Una sola consulta en el tick: si hubiera dos, una podria ser una "precarga" del lote.
    expect(tick.match(/lookupTicket\s*\(/g) ?? []).toHaveLength(1);
  });

  // TS-80 (CA-14, ADR-002). Lo romperia "bajar el timeout del KV" para que un KV caido no frene el
  // tick. ADR-002 manda conservar el timeout del cliente (15 s), y la story decide no agregar uno
  // propio: el guard de no solapamiento ya absorbe un tick lento.
  it('TS-80: el modulo del KV no fija ningun timeout ni signal propio', () => {
    for (const file of KV_FILES) {
      expect(file.code.includes('timeoutMs'), `${file.relativePath} fija timeoutMs`).toBe(false);
      expect(file.code.includes('signal'), `${file.relativePath} pasa un signal`).toBe(false);
    }
  });

  // TS-81 (CA-13, ADR-001). Lo romperia "consultar el slug al final, junto con el alta", o "saltear
  // el mail si el KV no contesta" (un `continue` sin `\Seen` haria que el proximo tick lo reintente,
  // convirtiendo al KV en una marca de idempotencia). Subir adjuntos de un mail que despues se
  // descarta los dejaria huerfanos en el storage.
  it('TS-81: el \\Seen sigue primero y la consulta del slug va antes de los adjuntos', () => {
    const tick = codeOf(TICK);
    const fetchIdx = tick.indexOf('fetch(uid)');
    const markSeenIdx = tick.indexOf('markSeen(uid)');
    const normalizeIdx = tick.indexOf('await normalize(');
    const lookupTicketIdx = tick.indexOf('lookupTicket(');
    const adjuntosIdx = tick.indexOf('procesarAdjuntosDelMail(');

    expect(fetchIdx).toBeGreaterThan(-1);
    expect(markSeenIdx).toBeGreaterThan(fetchIdx);
    expect(normalizeIdx).toBeGreaterThan(markSeenIdx);
    expect(lookupTicketIdx).toBeGreaterThan(normalizeIdx);
    expect(adjuntosIdx).toBeGreaterThan(lookupTicketIdx);

    // Las dos operaciones del hilo tambien despues del `\Seen`: ninguna consulta al KV puede
    // saltear un mail.
    expect(tick.indexOf('lookupThread(')).toBeGreaterThan(markSeenIdx);
    expect(tick.indexOf('recordThreadEntry(')).toBeGreaterThan(markSeenIdx);

    // Y ninguna rama saltea el mail en funcion de una consulta: el resultado solo decide el motivo.
    expect(/lookupThread\([\s\S]{0,400}?\bcontinue\b/.test(tick), 'el tick saltea un mail tras lookupThread').toBe(
      false,
    );
    expect(/lookupTicket\([\s\S]{0,400}?\bcontinue\b/.test(tick), 'el tick saltea un mail tras lookupTicket').toBe(
      false,
    );
  });

  // TS-82 (CA-19). Lo romperia un test que cree su propio bucket "por comodidad": la excepcion de
  // crear un bucket existe SOLO en el helper que representa al deploy de Jiku, y si se multiplica
  // deja de ser una excepcion nombrada.
  it('TS-82: el helper de tests es el UNICO lugar del repo que crea un bucket', () => {
    const tests = testFiles();
    // Sanidad del walker.
    expect(tests.length).toBeGreaterThan(20);
    expect(tests.map((file) => file.relativePath)).toContain('infra/kv/helpers.ts');

    const creators = [...tests, ...FILES]
      .filter((file) => /STREAM\.CREATE/.test(file.code))
      .map((file) => file.relativePath);
    expect(creators).toEqual(['infra/kv/helpers.ts']);

    // Y dentro del helper, solo en `createBucket`, una sola vez. (La posicion se busca con la regex
    // y no con el literal: un literal del subject en ESTE archivo lo volveria un "creador" mas.)
    const helpers = tests.find((file) => file.relativePath === 'infra/kv/helpers.ts')?.code ?? '';
    expect(helpers.match(/STREAM\.CREATE/g) ?? []).toHaveLength(1);
    const createIdx = helpers.indexOf('const createBucket = async (');
    const subjectIdx = helpers.search(/STREAM\.CREATE/);
    expect(createIdx).toBeGreaterThan(-1);
    expect(subjectIdx).toBeGreaterThan(createIdx);
    expect(subjectIdx).toBeLessThan(helpers.indexOf('return {', createIdx));

    // El `create()` del KV crudo no aparece en ningun lado, ni en tests.
    for (const file of [...tests, ...FILES]) {
      expect(/\bkvm\s*\.\s*create\s*\(/.test(file.code), `${file.relativePath} crea un bucket con Kvm`).toBe(false);
    }
  });
});

describe('src/ el arranque, el apagado y la superficie del modulo del KV', () => {
  // TS-71 (CA-3, CA-18). Lo romperia "abrir el espacio antes de conectar" (no hay conexion sobre la
  // que abrirlo) o "despues de schedular el tick" (el primer mail descubriria el espacio roto y se
  // descartaria como `slug_no_consultable` en vez de impedir el arranque).
  it('TS-71: el espacio se abre entre la conexion y el tick, y lo del watch desaparecio', () => {
    const startup = readSource('startup.ts');
    const index = readSource('index.ts');
    const verify = readSource('verify.ts');
    const shutdown = readSource('shared/shutdown.ts');

    expect(startup.indexOf('connectToBus(')).toBeGreaterThan(-1);
    expect(startup.indexOf('openKvSpace(')).toBeGreaterThan(startup.indexOf('connectToBus('));

    expect(index.indexOf('runStartup(')).toBeGreaterThan(-1);
    expect(index.indexOf('scheduleTick(')).toBeGreaterThan(index.indexOf('runStartup('));
    expect(index).toContain('scheduleTick(config, logger, client, space)');

    for (const [name, code] of [
      ['startup.ts', startup],
      ['index.ts', index],
      ['verify.ts', verify],
      ['shared/shutdown.ts', shutdown],
    ] as const) {
      for (const gone of ['openKvStores', 'startTicketMapWatch', 'withTicketMap', 'ticketMapWatch', 'stopTicketMapWatch']) {
        expect(code.includes(gone), `${name} todavia nombra ${gone}`).toBe(false);
      }
    }

    expect(existsSync(join(SRC_ROOT, 'infra/kv/stores.ts'))).toBe(false);
    expect(existsSync(join(SRC_ROOT, 'infra/kv/ticket-map.ts'))).toBe(false);
  });

  // TS-73 (CA-18). Lo romperia "exportar un helper para crear el bucket en local": no tener el verbo
  // a mano es parte de que el conector no cree buckets.
  it('TS-73: la superficie del modulo es la nueva, sin ningun verbo de creacion', async () => {
    const surface = Object.keys(await import('#infra/kv/index.js'));

    for (const name of [
      'openKvSpace',
      'lookupTicket',
      'ticketKey',
      'threadKey',
      'isStorableSlug',
      'recordThreadEntry',
      'lookupThread',
      'sha256hex',
      'parsePositiveId',
    ]) {
      expect(surface).toContain(name);
    }
    for (const gone of ['openKvStores', 'startTicketMapWatch', 'isValidBucketName', 'KvBucketMissingError']) {
      expect(surface).not.toContain(gone);
    }
    expect(surface.filter((name) => /create/i.test(name))).toEqual([]);
  });
});
