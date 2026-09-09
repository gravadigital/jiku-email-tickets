import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * S-028 Tarea 7 (CA-15), TS-57 a TS-61: verificaciones de CONTENIDO de la documentacion operativa
 * que esta story cierra — no de comportamiento.
 *
 * Mismo criterio que `test/deployment-docs.test.ts` y `test/story-011-docs.test.ts`: se ancla por
 * PALABRAS CLAVE ESTRUCTURALES, no por prosa completa. Afirmar frases enteras es fragil y no vale la
 * pena: cualquier reescritura legitima rompe el test y el siguiente que lo vea lo borra. Lo que
 * estos casos protegen es otra cosa —que BORRAR la seccion rompa la suite— y para eso alcanza con
 * anclar los terminos que no pueden desaparecer sin que el procedimiento deje de servirle a U-02:
 * `nats kv add`, `--ttl=90d`, `nats kv put`, `nats kv get`, `visibilityLevel`, `public`, `Opus`, y
 * las palabras clave del apartado del hex.
 *
 * El fallo que previene es concreto: un procedimiento manual que nadie vuelve a leer se pudre en
 * silencio, y su ausencia solo se descubre cuando alguien tiene que verificar un despliegue de cero.
 *
 * Las aserciones de CA-16 (las precondiciones del `README.md`) NO viven aca: se extendieron
 * `test/deployment-docs.test.ts`, que es donde vive esa responsabilidad. No se duplican.
 */

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

const E2E_DOC = 'docs/architectures/jiku-mail-connector/verificacion-e2e-manual.md';

describe('CA-15: verificacion-e2e-manual.md cubre el alcance del KV', () => {
  let doc: string;
  /** La Parte 2, aislada: varios de estos terminos ya aparecen en la Parte 1 o en la tabla de
   * capabilities, asi que buscarlos en todo el archivo daria un FALSO VERDE si la seccion se
   * borrara. */
  let kv: string;

  beforeAll(async () => {
    doc = await readFile(new URL(E2E_DOC, `file://${PROJECT_ROOT}/`), 'utf8');

    const start = doc.indexOf('# Parte 2: el alcance del KV');
    expect(start, 'el documento debe tener una seccion "Parte 2: el alcance del KV"').toBeGreaterThan(
      -1,
    );
    // El corte se ancla al titulo SIGUIENTE por su texto, no a un `\n# ` generico: la seccion
    // trae bloques `bash` cuyos comentarios empiezan con `# ` al principio de linea (los hashes de
    // ejemplo), y un corte generico se comeria la mitad del apartado del hex — dejando el test en
    // verde por no encontrar lo que ya no estaba mirando.
    const rest = doc.slice(start + 1);
    const next = rest.indexOf('# Contraste de capabilities');
    kv = next === -1 ? rest : rest.slice(0, next);
  });

  it('sanity: el documento se leyo y la Parte 2 tiene contenido real', () => {
    // Sin esto, un `indexOf` que devolviera un slice vacio haria pasar todo lo de abajo en verde.
    expect(doc.length).toBeGreaterThan(2_000);
    expect(kv.length).toBeGreaterThan(1_500);
  });

  it('la cabecera nombra a S-028 sin borrar el rastro de S-022', () => {
    // El documento lo escribio S-022 para el camino del adjunto, y esa parte SIGUE siendo valida y
    // sigue siendo de esa story. Actualizar la cabecera no es borrar el rastro.
    expect(doc).toContain('S-028');
    expect(doc).toContain('S-022');
    expect(doc).toMatch(/Parte 1: el camino del adjunto/);
  });

  // TS-57
  it('TS-57: documenta la creacion de los DOS buckets con el CLI, y el de hilos con --ttl=90d', () => {
    const adds = kv.match(/nats kv add/g) ?? [];
    expect(adds.length, 'tienen que estar los DOS `nats kv add`').toBeGreaterThanOrEqual(2);

    // Los dos nombres de bucket por defecto, y el TTL literal en el del de hilos.
    expect(kv).toContain('nats kv add TICKETS');
    expect(kv).toMatch(/nats kv add MAIL_THREADS[^\n]*--ttl=90d/);

    // Y la nota de que los nombres son los defaults, configurables por variable — igual que el
    // README, para que los dos documentos no divergan.
    expect(kv).toContain('KV_TICKETS_BUCKET');
    expect(kv).toContain('KV_THREADS_BUCKET');
  });

  it('dice que el operador los crea y que el conector NO los crea ni fija el TTL', () => {
    expect(kv).toMatch(/no crea (los )?buckets?/i);
    // El porque: un typo crearia un bucket VACIO en silencio.
    expect(kv).toMatch(/vac[ií]o/i);
    expect(kv).toMatch(/silencio/i);
    // Y el TTL se compara y avisa, no se fija.
    expect(kv).toMatch(/no fija el TTL|No fija el TTL/);
    expect(kv).toMatch(/compara/i);
    expect(kv).toContain('KV_THREADS_TTL_DAYS');
  });

  // TS-58
  it('TS-58: documenta la siembra del mapa con nats kv put, con un slug y un projectId de ejemplo', () => {
    expect(kv).toContain('nats kv put');
    // Sobre el bucket de slugs, con un slug de ejemplo y su projectId.
    expect(kv).toMatch(/nats kv put TICKETS\s+\w+\s+\d+/);
    // Y la normalizacion a minusculas, que es el error mas facil de cometer con el CLI.
    expect(kv).toMatch(/min[uú]sculas/i);
  });

  // TS-59
  it('TS-59: documenta que un slug nuevo rutea SIN redesplegar, con el conector corriendo', () => {
    expect(kv).toMatch(/sin redesplegar|sin redespliegue|sin reiniciar/i);
    // Con el conector CORRIENDO: es la condicion que hace que el paso pruebe algo.
    expect(kv).toMatch(/corriendo|vivo/i);
    // El descarte previo, con el slug en la linea: es lo que hace observable el "antes".
    expect(kv).toContain('slug_no_mapeado');
    // Y que el mail anterior NO se recupera: quedo \Seen. Sin esto, U-02 esperaria que aparezca.
    expect(kv).toMatch(/\\Seen|Seen/);
  });

  // TS-60
  it('TS-60: documenta el camino de la respuesta con el comentario publico visible en Opus', () => {
    // Los tres puntos que el CA pide: el comentario en Jiku, la visibilidad en Opus, y la linea de
    // log.
    expect(kv).toMatch(/comentario/i);
    expect(kv).toContain('Opus');
    expect(kv).toContain('visibilityLevel');
    expect(kv).toContain('public');
    // El porque de que `public` importe: el default del contrato es `internal`, que es el OPUESTO.
    expect(kv).toContain('internal');
    // Que NO crea un requisito nuevo.
    expect(kv).toMatch(/no.{0,40}requisito nuevo|No.{0,20}un requisito nuevo/i);
    // La linea de log con los contadores que distinguen el efecto.
    expect(kv).toContain('comentados');
    expect(kv).toMatch(/creados: 0|`creados: 0`|\*\*`comentados: 1` y `creados: 0`\*\*/);
    // Y la respuesta a la respuesta, que es lo que verifica el SEGUNDO write.
    expect(kv).toMatch(/respuesta a la respuesta/i);
    expect(kv).toContain('References');
    // Y el caso que debe DESCARTAR, para que U-02 no lea el descarte como un fallo.
    expect(kv).toContain('hilo_desconocido');
  });

  // TS-61
  it('TS-61: documenta como inspeccionar el bucket de hilos, sabiendo que las claves son hex', () => {
    // Que `nats kv ls` muestra hashes ilegibles.
    expect(kv).toContain('nats kv ls MAIL_THREADS');
    expect(kv).toMatch(/ilegibles?|64 chars|hex/i);

    // EL PORQUE: `validKeyRe` rechaza `<`, `>` y `@`.
    expect(kv).toContain('validKeyRe');
    expect(kv).toMatch(/rechaza/i);
    // Y que normalizar permitiria COLAPSAR dos Message-Id distintos y rutear un comentario al
    // requisito EQUIVOCADO. Es la razon por la que el riesgo se acepta en vez de "arreglarse".
    expect(kv).toMatch(/colapsen|colapsar/i);
    expect(kv).toMatch(/equivocado/i);
    expect(kv).toContain('G-04');

    // COMO CRUZAR una linea de log con el bucket: el `messageIdHash` que el log ya emite.
    expect(kv).toContain('messageIdHash');
    expect(kv).toContain('nats kv get MAIL_THREADS');
    // Y que el campo no se llama `key` a proposito (saldria [REDACTED] sin avisar).
    expect(kv).toMatch(/\[REDACTED\]/);
    // Que el hash SI se puede loguear porque es un hash, no contenido del cliente. El texto se
    // normaliza antes de buscar: el documento respeta el ancho de columna, asi que la frase viene
    // partida por un salto de linea y por el `**` del markdown — una regex que exija los espacios
    // exactos se rompe con cualquier reflow legitimo del parrafo.
    expect(kv.replace(/[*\s]+/g, ' ')).toMatch(/es un hash,? no contenido del cliente/i);
  });

  it('las precondiciones del documento pasan de siete a OCHO, con la del KV incluida', () => {
    const start = doc.indexOf('## Precondición');
    expect(start).toBeGreaterThan(-1);
    const rest = doc.slice(start + 1);
    const next = rest.indexOf('\n## ');
    const precondiciones = next === -1 ? rest : rest.slice(0, next);

    // OCHO, no siete: S-024 a S-027 sumaron la del KV.
    expect(precondiciones).toMatch(/\bocho\b|\b8\b/i);
    expect(precondiciones).toMatch(/JetStream/);
    expect(precondiciones).toMatch(/--ttl=90d/);
    // Y el mapa ya NO es la variable `TICKET_MAP`: decirlo evita que U-02 la busque.
    expect(precondiciones).toContain('TICKET_MAP');
    expect(precondiciones).toMatch(/ya no existe|no existe/i);
  });

  it('la tabla de capabilities registra que REQ-005 no agrego ninguna y no deja nada pendiente', () => {
    // CA-7 de la tarea: si el REQ no agrego capabilities, se deja constancia de que las 30 siguen
    // cubiertas, y se agregan las filas de los tests nuevos.
    expect(doc).toMatch(/30 capabilities/);
    expect(doc).toMatch(/no agreg[oó] ninguna capability|no agreg[oó] capabilities/i);
    expect(doc).toMatch(/no deja nada pendiente/i);

    // Y las suites nuevas de esta story figuran en el contraste.
    for (const suite of [
      'test/ingesta/tick-propiedades-kv.test.ts',
      'test/infra/kv/e2e-kv.test.ts',
      'test/infra/kv/e2e-watch-tick.test.ts',
      'test/infra/kv/preservacion-req-005.test.ts',
    ]) {
      expect(doc, `${suite} debe figurar en el contraste`).toContain(suite);
    }
  });
});
