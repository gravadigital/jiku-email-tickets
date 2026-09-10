import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * S-029 Task 6: verificaciones de CONTENIDO de la documentacion del servicio que esta story cierra
 * — no de comportamiento.
 *
 * Mismo criterio que `test/story-028-docs.test.ts` y `test/deployment-docs.test.ts`: se ancla por
 * PALABRAS CLAVE ESTRUCTURALES, no por prosa completa. Afirmar frases enteras es fragil y no vale
 * la pena: cualquier reescritura legitima rompe el test y el siguiente que lo vea lo borra. Lo que
 * estos casos protegen es otra cosa —que BORRAR la seccion rompa la suite—.
 *
 * Y HAY UN CASO QUE NO ES SOBRE ESTA STORY SINO SOBRE LA SIGUIENTE: el que afirma que ADR-003
 * **sigue diciendo** "MUST NOT publicar en el plano de consultas". Es lo que hace VISIBLE que la
 * derogacion documental esta **pendiente en S-030** en vez de perdida. Si alguien reescribe la ADR
 * antes de S-030 —o si S-030 la reescribe— ese caso falla, y el fallo es el recordatorio de que
 * este archivo tiene que actualizarse junto con ella. Un test que se rompe cuando el trabajo
 * pendiente se hace es exactamente lo que se quiere para un trabajo pendiente que de otro modo
 * nadie recuerda.
 */

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

const E2E_DOC = 'docs/architectures/jiku-mail-connector/verificacion-e2e-manual.md';
const OVERVIEW = 'docs/architectures/jiku-mail-connector/overview.md';
const CATALOG_INDEX = 'docs/reusable-code/jiku-mail-connector/index.md';
const SERVICES = 'docs/reusable-code/jiku-mail-connector/services.md';
const TEST_HELPERS = 'docs/reusable-code/jiku-mail-connector/test-helpers.md';
const ADR_003 = 'docs/adrs/ADR-003-escritura-solo-por-comandos.md';

function read(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, `file://${PROJECT_ROOT}/`), 'utf8');
}

describe('overview.md registra la consulta y la derogacion parcial de ADR-003', () => {
  let overview: string;
  /**
   * El bloque del modulo `publicacion`, aislado: varios de estos terminos aparecen en otras partes
   * del documento, asi que buscarlos en todo el archivo daria un FALSO VERDE si el parrafo se
   * borrara.
   */
  let publicacion: string;

  beforeAll(async () => {
    overview = await read(OVERVIEW);

    const start = overview.indexOf('- **publicacion**');
    expect(start, 'el overview debe tener el bloque del modulo publicacion').toBeGreaterThan(-1);
    const rest = overview.slice(start);
    const next = rest.indexOf('## Notas adicionales');
    publicacion = next === -1 ? rest : rest.slice(0, next);
  });

  it('sanity: el documento se leyo y el bloque de publicacion tiene contenido real', () => {
    // Sin esto, un `indexOf` que devolviera un slice vacio haria pasar todo lo de abajo en verde.
    expect(overview.length).toBeGreaterThan(5_000);
    expect(publicacion.length).toBeGreaterThan(2_000);
  });

  it('nombra la consulta, su recurso y su unico archivo', () => {
    expect(publicacion).toContain('attachments.list');
    expect(publicacion).toContain('lookup-attachment.ts');
    expect(publicacion).toContain('lookupAttachmentByChecksum()');
  });

  it('registra los cuatro filtros, que son lo que hace segura la consulta', () => {
    // Los cuatro juntos: es lo que documenta que ninguno es opcional. Si alguien "simplificara" el
    // filtro a `checksum` + `uploadedBy`, la doc seguiria diciendo cuatro y el contraste saltaria.
    for (const filtro of ['entityType', 'entityId', 'checksum', 'uploadedBy']) {
      expect(publicacion, `el overview debe nombrar el filtro ${filtro}`).toContain(filtro);
    }
  });

  it('declara la derogacion parcial y QUE MITAD queda intacta', () => {
    expect(publicacion).toContain('ADR-003');
    expect(publicacion).toMatch(/deroga/i);
    // La distincion entre las DOS mitades de la regla es el punto entero: sin ella la doc sugiere
    // que la ADR quedo derogada de plano.
    expect(publicacion).toMatch(/INTACTA|intacta/);
    expect(publicacion).toMatch(/suscrib/i);
  });

  it('remite a S-030 para la reescritura del texto de la ADR', () => {
    // Es lo que hace que el trabajo pendiente sea RASTREABLE en vez de perdido.
    expect(publicacion).toContain('S-030');
  });

  it('registra que la degradacion deja el comportamiento anterior', () => {
    expect(publicacion).toMatch(/degrada/i);
    expect(publicacion).toContain('diagnosePublishFailure()');
  });
});

describe('verificacion-e2e-manual.md cubre las tres ramas de la consulta', () => {
  let doc: string;
  /** La Parte 3, aislada, por la misma razon que la Parte 2 se aisla en `story-028-docs`. */
  let reuso: string;

  beforeAll(async () => {
    doc = await read(E2E_DOC);

    const start = doc.indexOf('# Parte 3: el reuso de adjuntos contra el hilo');
    expect(
      start,
      'el documento debe tener una seccion "Parte 3: el reuso de adjuntos contra el hilo"',
    ).toBeGreaterThan(-1);
    // El corte se ancla al titulo SIGUIENTE por su texto y no a un `\n# ` generico: la seccion trae
    // bloques `jsonc` cuyos comentarios empiezan con `//`, pero tambien tablas y ejemplos, y un
    // corte generico ya se demostro fragil en `story-028-docs.test.ts`.
    const rest = doc.slice(start + 1);
    const next = rest.indexOf('# Contraste de capabilities');
    reuso = next === -1 ? rest : rest.slice(0, next);
  });

  it('sanity: el documento se leyo y la Parte 3 tiene contenido real', () => {
    expect(doc.length).toBeGreaterThan(2_000);
    expect(reuso.length).toBeGreaterThan(1_500);
  });

  it('contiene los TRES valores de `resultado` que confirman cada rama por log', () => {
    // ADR-006: el log es la unica salida del servicio, asi que estos tres literales SON el
    // instrumento de verificacion. Sin ellos el procedimiento no le sirve al operador.
    //
    // Se buscan SIN comillas y no como `'reusado'`: las lineas de ejemplo del procedimiento son
    // JSON —comillas dobles— y anclarlas a las simples del codigo fuente haria fallar el test
    // contra un documento correcto. Lo que tiene que estar es el VALOR, no su sintaxis.
    for (const resultado of ['reusado', 'sin_match', 'consulta_fallida']) {
      expect(reuso, `el procedimiento debe nombrar resultado: ${resultado}`).toContain(resultado);
    }
    // Y el nombre de la clave, para que los tres valores no puedan quedar como prosa suelta.
    expect(reuso).toContain('"resultado"');
  });

  it('nombra las tres ramas y la que se verifica por AUSENCIA', () => {
    expect(reuso).toMatch(/Rama 1/);
    expect(reuso).toMatch(/Rama 2/);
    expect(reuso).toMatch(/Rama 3/);
    // La degradacion se confirma por la AUSENCIA del warn, no por provocarla: es el unico modo
    // practico, y perderlo dejaria el procedimiento sin la verificacion del whitelist.
    expect(reuso).toMatch(/AUSENCIA|ausencia/);
    expect(reuso).toContain('core_rechazo_por_forma');
    expect(reuso).toContain('invalid_fields');
  });

  it('explica por que la suite no alcanza: `Client.fromConnection()` saltea el auth', () => {
    // Es la razon de existir de toda la parte. Sin ella, el proximo lector la borra por
    // "redundante con los tests".
    expect(reuso).toContain('Client.fromConnection()');
    expect(reuso).toMatch(/internal-app/);
    expect(reuso).toMatch(/whitelist/i);
  });

  it('registra el cross-check del whitelist como paso MANUAL, no como codigo', () => {
    expect(reuso).toContain('contract()');
    expect(reuso).toContain('describe()');
    // Y explicitamente que NO se agrega al arranque: seria un segundo consumo del plano de lectura
    // que esta story no autoriza.
    expect(reuso).toMatch(/manual/i);
  });
});

describe('el catalogo de codigo reutilizable suma las dos piezas de esta story', () => {
  it('el index nombra lookupAttachmentByChecksum y respondToQuery', async () => {
    const index = await read(CATALOG_INDEX);

    expect(index.length).toBeGreaterThan(5_000);
    expect(index).toContain('lookupAttachmentByChecksum');
    expect(index).toContain('respondToQuery');
    // Y la entrada del orquestador registra el cuarto parametro, que es lo que hace CA-5
    // estructural.
    expect(index).toContain('ContextoHilo');
  });

  it('services.md trae la entrada completa del lookup, con lo que no puede perderse', async () => {
    const services = await read(SERVICES);

    expect(services).toContain('## lookupAttachmentByChecksum()');
    expect(services).toContain('src/domain/publicacion/lookup-attachment.ts');
    // Las dos variantes de retorno y la ausencia de una de error.
    expect(services).toContain("tipo: 'reusado'");
    expect(services).toContain("tipo: 'sin_match'");
    // Que NUNCA lanza: es el contrato, y perderlo de la doc invita a "no tragarse el error".
    expect(services).toMatch(/NEVER THROWS|never throws/);
    // Los cuatro filtros y su justificacion individual.
    for (const filtro of ['entityType', 'entityId', 'checksum', 'uploadedBy']) {
      expect(services, `services.md debe justificar el filtro ${filtro}`).toContain(filtro);
    }
    // Y el cuarto parametro del orquestador.
    expect(services).toContain('hilo?: ContextoHilo');
  });

  it('test-helpers.md trae respondToQuery y POR QUE es una funcion separada', async () => {
    const helpers = await read(TEST_HELPERS);

    expect(helpers).toContain('## respondToQuery');
    expect(helpers).toContain('jiku-queries.v1');
    // La razon de la separacion es la parte que no puede perderse: sin ella alguien "simplifica"
    // las dos funciones en una con un parametro `plane`, que es la superposicion de subjects que el
    // SDK evita a proposito.
    expect(helpers).toMatch(/separate subject tokens on purpose/);
    expect(helpers).toContain('attachResponder');
  });
});

describe('la derogacion DOCUMENTAL de ADR-003 YA OCURRIO (S-030)', () => {
  // ESTE BLOQUE ERA LA DEUDA DOCUMENTAL REGISTRADA, y S-030 la salda.
  //
  // S-029 implemento el CAMBIO DE COMPORTAMIENTO; S-030 reescribio el TEXTO. Mientras las dos
  // estuvieron separadas hubo una inconsistencia real entre el codigo y la ADR, y este bloque
  // afirmaba que la ADR seguia prohibiendo el plano de consultas — precisamente para que la deuda
  // no se olvidara. Su comentario decia que cuando S-030 reescribiera la ADR el caso iba a fallar,
  // y que ese fallo era la señal de actualizar este archivo. Eso paso: los tres casos de abajo
  // invierten la afirmacion y ahora vigilan que la reescritura NO SE REVIERTA.
  //
  // Quien tiene razon sobre la frontera del plano de lectura sigue siendo
  // `test/publicacion/source-properties.test.ts`, que la mantiene EJECUTABLE sobre `src/`. Este
  // archivo vigila el TEXTO; aquel, el codigo.

  it('la prohibicion absoluta ya no es una regla vigente: solo sobrevive citada en su anotacion', async () => {
    const adr = await read(ADR_003);

    expect(adr.length).toBeGreaterThan(500);
    // El literal derogado NO puede aparecer como bullet de Implementation Rule. Si aparece, es
    // dentro de la anotacion de reescritura, citando el texto anterior — nunca al inicio de un
    // item de lista.
    expect(adr).not.toMatch(/^- El conector MUST NOT publicar en el plano de consultas/m);
    expect(adr).toMatch(/REESCRITA por REQ-006 \/ S-030/);
  });

  it('la regla nueva enumera el caso habilitado con los CUATRO filtros exactos del codigo', async () => {
    const adr = await read(ADR_003);

    // Los nombres se copian del codigo (`lookup-attachment.ts`), no se parafrasean: una regla
    // parafraseada no es verificable contra el contrato.
    expect(adr).toMatch(/La única consulta permitida en el plano de consultas/);
    expect(adr).toContain('`attachments.list`');
    for (const filtro of ['entityType', 'entityId', 'checksum', 'uploadedBy']) {
      expect(adr).toContain(filtro);
    }
    // Enumera de forma CERRADA: la habilitacion puntual va con su cierre explicito.
    expect(adr).toMatch(/MUST NOT publicarse ninguna otra consulta/);
  });

  it('la prohibicion de SUSCRIBIRSE sobrevive como regla propia e independiente', async () => {
    const adr = await read(ADR_003);

    // Es la mitad que NO se derogo, y quedo como item de lista separado a proposito: si siguiera
    // compartiendo bullet con la derogada, el proximo lector que borre el bullet se lleva las dos.
    expect(adr).toMatch(/^- El conector MUST NOT suscribirse a subjects de otros servicios$/m);
  });
});
