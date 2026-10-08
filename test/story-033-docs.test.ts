import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { kvKey, requiredKVPermissions } from '@gravadigital/jiku';
import { beforeAll, describe, expect, it } from 'vitest';

import { sha256hex, threadKey, ticketKey, TICKETS_KEY_PREFIX } from '#infra/kv/keys.js';

import {
  fillTemplate,
  readmeTicketMapSection,
  readmeTicketTemplate,
  TEMPLATE_PREFIX,
  ticketTemplateIn,
} from './infra/kv/operator.js';

/**
 * S-033 (CA-11 a CA-14): la documentacion de OPERACION del Espacio KV — la precondicion 8 y el Mapa
 * de Tickets del `README.md`, el `.env.example`, y la Parte 2 y el cierre de REQ-008 de
 * `verificacion-e2e-manual.md`.
 *
 * Mismo criterio que `test/deployment-docs.test.ts` y `test/story-028-docs.test.ts`: se ancla por
 * PALABRAS CLAVE ESTRUCTURALES y se aisla la SECCION (no el archivo entero), para que BORRARLA
 * rompa la suite. Lo que no es palabra clave sino CONTRATO —la plantilla de la clave que el
 * operador escribe y los grants que el deploy agrega— se cruza contra el CODIGO y el SDK, no
 * contra una constante del test: si el SDK cambia los grants o el conector cambia la forma de la
 * clave, la documentacion tiene que cambiar con ellos, y es este archivo el que lo obliga.
 */

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

const E2E_DOC = 'docs/architectures/jiku-email-tickets/verificacion-e2e-manual.md';

const PREFIX_DEV = 'dev.387842544790142978.';
const PREFIX_PROD = 'prod.387842544790142978.';

async function read(relPath: string): Promise<string> {
  return readFile(new URL(relPath, `file://${PROJECT_ROOT}/`), 'utf8');
}

/** De `## <titulo>` hasta el siguiente `\n## `. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, `falta la seccion "${heading}"`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Las tres lineas `- "…"` del bloque `pub.allow` del texto de `requiredKVPermissions()`. */
function sdkGrants(instance: string): string[] {
  const text = requiredKVPermissions(instance);
  const pub = text.slice(text.indexOf('pub:'), text.indexOf('sub:'));
  return [...pub.matchAll(/- "([^"]+)"/g)].map((m) => m[1] ?? '');
}

describe('README: la precondicion 8 y el Mapa de Tickets del Espacio KV (CA-11)', () => {
  let readme: string;
  let deployment: string;
  let row8: string;
  let ticketMap: string;

  beforeAll(async () => {
    readme = await read('README.md');
    deployment = section(readme, '## Desplegar');
    row8 = deployment.split('\n').find((line) => line.startsWith('| 8 |')) ?? '';
    ticketMap = readmeTicketMapSection();
  });

  it('sanity: la seccion, la fila 8 y la subseccion del Mapa de Tickets tienen contenido real', () => {
    expect(deployment.length).toBeGreaterThan(5_000);
    expect(row8.length, 'la tabla de precondiciones tiene que tener la fila 8').toBeGreaterThan(200);
    expect(ticketMap.length).toBeGreaterThan(1_000);
  });

  it('TS-27: la precondicion 8 es JIKU_KV del deploy de Jiku, con allow_direct y sin TTL, y los grants de internal-app', () => {
    expect(row8).toContain('JIKU_KV');
    expect(row8).toContain('allow_direct');
    expect(row8).toContain('sin TTL');
    expect(row8).toContain('internal-app');
    expect(row8).toContain('deploy de Jiku');
    expect(row8).toMatch(/no la crea[n]? U-02 ni el conector|ni U-02 ni el conector/i);
    // El mecanismo viejo no puede quedar como origen de la precondicion.
    expect(row8).not.toContain('los dos buckets');
    expect(row8).not.toContain('REQ-005');
  });

  it('TS-28: la columna "Si falta" nombra el error y los tres diagnosis', () => {
    expect(row8).toContain('KV_SPACE_UNAVAILABLE_ERROR');
    for (const diagnosis of ['bucket_no_usable', 'kv_sin_permisos', 'desconocido']) {
      expect(row8, `la fila 8 tiene que nombrar ${diagnosis}`).toContain(diagnosis);
    }
    // Los diagnosticos de REQ-005, que el codigo ya no emite.
    expect(row8).not.toContain('bucket_inexistente');
    expect(row8).not.toContain('kv_no_disponible');
  });

  it('TS-29: los tres grants del README son los de requiredKVPermissions() del SDK', () => {
    // Se generan con una instancia CENTINELA y se reemplaza por el placeholder del README: si el SDK
    // cambia un grant, esta lista cambia y el README tiene que acompanar.
    const grants = sdkGrants('INSTANCIA').map((grant) => grant.replaceAll('INSTANCIA', '<instance>'));
    expect(grants).toEqual([
      '$JS.API.STREAM.INFO.KV_JIKU_KV',
      '$KV.JIKU_KV.<instance>.{{user_id}}.>',
      '$JS.API.DIRECT.GET.KV_JIKU_KV.$KV.JIKU_KV.<instance>.{{user_id}}.>',
    ]);
    for (const grant of grants) {
      expect(deployment, `el README tiene que nombrar el grant ${grant}`).toContain(grant);
    }
  });

  it('TS-30: el sintoma de un JIKU_KV con TTL: slug_no_mapeado sin que nadie haya borrado nada', () => {
    const paragraphs = deployment.split(/\n\s*\n/).filter((p) => p.includes('TTL'));
    const symptom = paragraphs.find(
      (p) => p.includes('slug_no_mapeado') && /nadie (los )?(haya )?borr/i.test(p),
    );
    expect(symptom, 'un parrafo con TTL tiene que describir el sintoma de un bucket con TTL').toBeDefined();
  });

  it('TS-31: la seccion del Mapa de Tickets trae los tres comandos con la clave completa y de donde sale el <sub>', () => {
    expect(ticketMap).toContain('nats kv put JIKU_KV <instance>.<sub>.tickets.<slug> <projectId>');
    expect(ticketMap).toContain('nats kv del JIKU_KV <instance>.<sub>.tickets.<slug>');
    expect(ticketMap).toContain('nats kv get JIKU_KV <instance>.<sub>.tickets.<slug>');
    // De donde sale el prefijo: la linea de arranque, campo `kvPrefix`.
    expect(ticketMap).toContain('kvPrefix');
    expect(ticketMap).toContain('espacio KV abierto');
    // Por instancia.
    expect(ticketMap).toMatch(/por instancia/i);
    expect(ticketMap).toContain('dev');
    expect(ticketMap).toContain('prod');
    // Desde el mail siguiente, sin redesplegar.
    expect(ticketMap).toMatch(/mail siguiente/i);
    expect(ticketMap).toMatch(/sin redesplegar/i);
    // Minusculas, el warn del valor malo, el espacio vacio.
    expect(ticketMap).toMatch(/min[uú]sculas/i);
    expect(ticketMap).toContain('warn');
    expect(ticketMap).toMatch(/vac[ií]o/i);
    // La caida del KV y como reconstruir lo descartado.
    expect(ticketMap).toContain('slug_no_consultable');
    expect(ticketMap).toContain('casilla');
  });

  it('TS-32: la credencial de U-02 se nombra por su clase, nunca por un valor', () => {
    expect(deployment).toMatch(/credencial/i);
    expect(deployment).toContain('{{user_id}}');
    expect(deployment.replace(/[*\s]+/g, ' ')).toMatch(/no puede ser (la de )?un usuario com[uú]n/i);
    // Ningun valor: ni un JWT, ni una password asignada.
    expect(deployment).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(deployment).not.toMatch(/password\s*[:=]\s*["']?[A-Za-z0-9]/i);
  });

  it('TS-33: desaparecen los dos buckets, el watch(), su reintento y el TTL esperado', () => {
    expect(readme).not.toContain('nats kv add');
    expect(readme).not.toContain('MAIL_THREADS');
    expect(readme).not.toContain('--ttl');
    expect(readme).not.toContain('nats kv put TICKETS');

    // `watch()` y `KV_WATCH_RETRY_MS` sobreviven SOLO en la nota de variables eliminadas (S-032).
    const noteStart = readme.indexOf('> **Variables eliminadas (REQ-008):**');
    expect(noteStart).toBeGreaterThan(-1);
    const noteEnd = readme.indexOf('\n\n', noteStart);
    const withoutNote = readme.slice(0, noteStart) + readme.slice(noteEnd);
    expect(withoutNote).not.toContain('watch()');
    expect(withoutNote).not.toContain('KV_WATCH_RETRY_MS');

    // Ningun "en caliente" atribuido a un watch.
    for (const line of readme.split('\n')) {
      if (/en caliente/i.test(line)) {
        expect(line, 'un "en caliente" no puede atribuirse a un watch').not.toMatch(/watch/i);
      }
    }

    // La tercera linea del arranque es la del espacio, no la del mapa cargado.
    expect(readme).toContain('espacio KV abierto');
    expect(readme).not.toMatch(/Mapa de Tickets cargado/i);
  });

  it('TS-41: la plantilla de clave documentada y la del codigo producen la misma clave', () => {
    const template = readmeTicketTemplate();
    expect(template.startsWith(TEMPLATE_PREFIX)).toBe(true);
    expect(template.endsWith(`${TICKETS_KEY_PREFIX}<slug>`)).toBe(true);

    const fromDocs = fillTemplate(template, { kvPrefix: PREFIX_PROD, slug: 'alfa' });
    const fromCode = kvKey('prod', '387842544790142978', ticketKey('alfa'));
    expect(kvKey('prod', '387842544790142978', '')).toBe(PREFIX_PROD);
    expect(fromDocs).toBe(fromCode);
    expect(fromDocs).toBe('prod.387842544790142978.tickets.alfa');
  });

  it('TS-42 (mitad README): las tres plantillas de tickets del README son la misma', () => {
    const template = readmeTicketTemplate();
    for (const verb of ['del', 'get']) {
      const match = new RegExp(`nats kv ${verb} JIKU_KV (\\S+)`).exec(ticketMap);
      expect(match?.[1], `la plantilla de nats kv ${verb}`).toBe(template);
    }
    // Y la clave del hilo, si el operador la arma igual, es la que escribe el conector.
    const hash = sha256hex('<abc@cliente.com>');
    expect(fillTemplate('<instance>.<sub>.hilos.<messageIdHash>', { kvPrefix: PREFIX_DEV, messageIdHash: hash })).toBe(
      kvKey('dev', '387842544790142978', threadKey('<abc@cliente.com>')),
    );
  });
});

describe('.env.example deja de explicar el mecanismo viejo (CA-12)', () => {
  let example: string;

  beforeAll(async () => {
    example = await read('.env.example');
  });

  it('TS-34: remite a la precondicion 8 y no declara ninguna variable nueva del KV', () => {
    expect(example).not.toContain('nats kv add');
    expect(example).not.toContain('MAIL_THREADS');
    expect(example).not.toContain('--ttl');
    expect(example).not.toContain('watch()');

    expect(example).toMatch(/precondici[oó]n 8/i);
    expect(example).toContain('README');

    expect(example).not.toMatch(/^\s*#?\s*(KV_\w+|JIKU_KV)\s*=/m);

    // Lo que los casos de `deployment-docs.test.ts` siguen exigiendo.
    expect(example).toContain('TICKET_MAP');
    expect(example).toContain('nats kv put');
    expect(example).toMatch(/se ignora/i);
    // Y el `nats kv put` lleva la clave completa, no el bucket viejo.
    expect(example).toContain('nats kv put JIKU_KV <instance>.<sub>.tickets.');
  });
});

describe('verificacion-e2e-manual.md: la Parte 2 rehecha y el cierre de REQ-008 (CA-13, CA-14)', () => {
  let doc: string;
  /** La Parte 2, cortada en el titulo de la Parte 3 (el prefijo del titulo se conserva: Hallazgo 7). */
  let parte2: string;

  /** De `## <titulo>` hasta el siguiente `\n## ` dentro de la Parte 2. */
  function paso(heading: string): string {
    const start = parte2.indexOf(heading);
    expect(start, `la Parte 2 tiene que tener "${heading}"`).toBeGreaterThan(-1);
    const rest = parte2.slice(start + 1);
    const next = rest.indexOf('\n## ');
    return next === -1 ? rest : rest.slice(0, next);
  }

  beforeAll(async () => {
    doc = await read(E2E_DOC);
    const start = doc.indexOf('# Parte 2: el alcance del KV');
    expect(start).toBeGreaterThan(-1);
    const rest = doc.slice(start + 1);
    const next = rest.indexOf('# Parte 3');
    parte2 = next === -1 ? rest : rest.slice(0, next);
  });

  it('sanity: la Parte 2 tiene contenido real y la cabecera nombra a S-033 sin borrar a S-022 ni S-028', () => {
    expect(parte2.length).toBeGreaterThan(5_000);
    const header = doc.slice(0, doc.indexOf('# Parte 1'));
    expect(header).toContain('S-033');
    expect(header).toContain('S-028');
    expect(header).toContain('S-022');
  });

  it('TS-35: el Paso 1 verifica JIKU_KV (allow_direct, sin TTL) en vez de crear buckets', () => {
    const paso1 = paso('## Paso 1');
    expect(paso1).toMatch(/nats (kv|stream) info (JIKU_KV|KV_JIKU_KV)/);
    expect(paso1).toContain('allow_direct');
    expect(paso1).toMatch(/TTL|max_age/);
    expect(paso1).toContain('espacio KV abierto');
    // Que hacer si no arranca: los tres diagnosis.
    for (const diagnosis of ['bucket_no_usable', 'kv_sin_permisos', 'desconocido']) {
      expect(paso1).toContain(diagnosis);
    }
    expect(parte2).not.toContain('nats kv add');
    // La precondicion de la parte ya no nombra los errores de REQ-005.
    expect(parte2).not.toContain('KV_BUCKET_MISSING_ERROR');
    expect(parte2).not.toContain('kv_no_disponible');
  });

  it('TS-36: los Pasos 2 y 3 siembran, verifican, agregan y borran un slug con la clave completa', () => {
    expect(parte2).toContain('nats kv put JIKU_KV <instance>.<sub>.tickets.');
    expect(parte2).toContain('nats kv get JIKU_KV <instance>.<sub>.tickets.');
    expect(parte2).toContain('nats kv del JIKU_KV <instance>.<sub>.tickets.');
    expect(parte2).toContain('kvPrefix');
    expect(parte2).toContain('slug_no_mapeado');
    expect(parte2).toMatch(/sin redesplegar/i);
    expect(parte2).toContain('\\Seen');
    // La degradacion del watch() desaparece.
    expect(parte2).not.toContain('KV_WATCH_RETRY_MS');
    expect(parte2).not.toMatch(/copia buena/);
  });

  it('TS-37: el Paso 4 conserva su logica y hilo_desconocido tiene dos casos, sin la expiracion', () => {
    for (const term of ['visibilityLevel', 'public', 'internal', 'Opus', 'comentados', 'hilo_desconocido']) {
      expect(parte2).toContain(term);
    }
    expect(parte2).toMatch(/respuesta a la respuesta/i);
    expect(parte2.replace(/[*\s]+/g, ' ')).not.toMatch(/entrada expirada por el TTL/i);
  });

  it('TS-38: el Paso 5 inspecciona una entrada del hilo con la clave completa y el hash del log', () => {
    expect(parte2).toContain('nats kv get JIKU_KV <instance>.<sub>.hilos.<messageIdHash>');
    expect(parte2).toContain('messageIdHash');
    expect(parte2).toContain('[REDACTED]');
    expect(parte2).toContain('G-04');
    expect(parte2).toMatch(/colapsen|colapsar/);
    expect(parte2).not.toContain('nats kv ls MAIL_THREADS');
    expect(parte2).not.toContain('nats kv get MAIL_THREADS');
  });

  it('TS-39: el cierre de REQ-008 va despues del de REQ-005, con la tabla de propiedades y sus suites', () => {
    const req005 = doc.indexOf('## Cierre de REQ-005 (S-028)');
    const req008 = doc.indexOf('## Cierre de REQ-008 (S-033)');
    expect(req005).toBeGreaterThan(-1);
    expect(req008).toBeGreaterThan(req005);
    const cierre = doc.slice(req008);
    expect(cierre).toContain('| Propiedad verificada | Suite |');
    for (const suite of [
      'test/infra/kv/e2e-operador.test.ts',
      'test/infra/kv/e2e-kv.test.ts',
      'test/infra/kv/e2e-permisos.test.ts',
      'test/ingesta/tick-propiedades-espacio.test.ts',
      'test/ingesta/tick-propiedades-kv.test.ts',
      'test/ingesta/tick-memory.test.ts',
      'test/story-033-docs.test.ts',
    ]) {
      expect(cierre, `el cierre de REQ-008 tiene que nombrar ${suite}`).toContain(suite);
    }
  });

  it('TS-40: el cierre de REQ-005 conserva su historia, con la nota de lo que reemplazo REQ-008', () => {
    const start = doc.indexOf('## Cierre de REQ-005 (S-028)');
    const cierre = doc.slice(start, doc.indexOf('## Cierre de REQ-008'));
    expect(cierre).toContain('test/infra/kv/e2e-watch-tick.test.ts');
    // La NOTA, aislada (el blockquote que abre el cierre): la tabla conservada tambien nombra el
    // watch, asi que buscarlo en todo el cierre daria verde aunque la nota no lo dijera.
    const noteStart = cierre.indexOf('> **Nota de S-033 (REQ-008).**');
    expect(noteStart).toBeGreaterThan(-1);
    const note = cierre.slice(noteStart, cierre.indexOf('\n\n', noteStart));
    expect(note).toContain('REQ-008');
    expect(note).toMatch(/watch en caliente/);
    expect(note).toContain('e2e-watch-tick.test.ts');
    expect(note).toMatch(/TTL/);
  });

  it('TS-42 (mitad Parte 2): las plantillas de la Parte 2 son las del README y producen las claves del codigo', () => {
    expect(ticketTemplateIn(parte2, 'la Parte 2 de verificacion-e2e-manual.md')).toBe(readmeTicketTemplate());

    const hilos = /nats kv get JIKU_KV (\S+hilos\.<messageIdHash>)/.exec(parte2)?.[1];
    expect(hilos).toBe('<instance>.<sub>.hilos.<messageIdHash>');
    expect(
      fillTemplate(hilos ?? '', { kvPrefix: PREFIX_DEV, messageIdHash: sha256hex('<abc@cliente.com>') }),
    ).toBe(kvKey('dev', '387842544790142978', threadKey('<abc@cliente.com>')));
  });
});
