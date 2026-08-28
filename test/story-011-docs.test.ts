import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * TS-17, TS-18, TS-19, TS-21 (Tarea 4 del Story Plan de S-011): verificaciones de CONTENIDO de la
 * documentacion tecnica que esta story cierra — no de comportamiento. Mismo criterio que
 * `test/deployment-docs.test.ts` y `test/manifest.test.ts`: se ancla por palabras clave
 * estructurales, no por prosa completa, para no romper con cualquier reescritura legitima pero SI
 * romper si la seccion entera desaparece o queda contradictoria.
 *
 * TS-20 (README) ya vive en `test/deployment-docs.test.ts`, junto al resto de precondiciones de
 * despliegue — no se duplica aca.
 */

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

async function readDoc(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, `file://${PROJECT_ROOT}/`), 'utf8');
}

describe('TS-17: el flujo de arranque documenta el Paso 8', () => {
  let flow: string;

  beforeAll(async () => {
    flow = await readDoc('docs/flows/arranque-y-conexion-al-bus.md');
  });

  it('tiene un Paso 8 despues del Paso 7 y antes de Manejo de Errores', () => {
    const paso7 = flow.indexOf('### Paso 7');
    const paso8 = flow.indexOf('### Paso 8');
    const manejoDeErrores = flow.indexOf('## Manejo de Errores');

    expect(paso7).toBeGreaterThan(-1);
    expect(paso8).toBeGreaterThan(paso7);
    expect(manejoDeErrores).toBeGreaterThan(paso8);
  });

  it('documenta las dos ramas de POLL_ENABLED y la ausencia de tick inmediato', () => {
    const paso8 = flow.slice(flow.indexOf('### Paso 8'), flow.indexOf('## Manejo de Errores'));

    expect(paso8).toMatch(/scheduleTick/);
    expect(paso8).toMatch(/poll deshabilitado: no se schedula ningún tick/);
    expect(paso8).toMatch(/[Ss]in tick inmediato/);
  });

  it('el frontmatter y "Resultado" incluyen esta story y el estado final del tick', () => {
    expect(flow).toMatch(/stories:\s*\[.*S-011.*\]/);
    expect(flow).toContain('S-011 implementada');

    const resultado = flow.slice(flow.indexOf('## Resultado'));
    expect(resultado).toMatch(/scheduleado/);
    expect(resultado).toMatch(/POLL_ENABLED=false/);
  });
});

describe('TS-18: el flujo de ingesta queda completo y consistente con el codigo', () => {
  let flow: string;

  beforeAll(async () => {
    flow = await readDoc('docs/flows/ingesta-y-normalizacion-del-mail.md');
  });

  it('el Paso 1 nombra el archivo y la funcion reales del scheduler', () => {
    expect(flow).toContain('src/domain/ingesta/scheduler.ts');
    expect(flow).toContain('tickInFlight');
  });

  it('ya no anuncia que falta S-011', () => {
    expect(flow.toLowerCase()).not.toContain('falta s-011');
  });

  it('el status pasa a Active y el frontmatter incluye S-011', () => {
    expect(flow).toMatch(/status:\s*Active/);
    expect(flow).toMatch(/stories:\s*\[.*S-011.*\]/);
  });
});

describe('TS-19: overview.md marca ingesta como implementado', () => {
  let overview: string;

  beforeAll(async () => {
    overview = await readDoc('docs/architectures/jiku-mail-connector/overview.md');
  });

  it('el modulo ingesta tiene una nota de estado equivalente a la de publicacion', () => {
    expect(overview).toMatch(/\*\*Estado \(S-011\):\*\*.*implementado/);
  });

  it('el hueco conocido del catalogo registra que el poll y el cron ya se estabilizaron', () => {
    expect(overview).toContain('Hueco conocido del catalogo');
    expect(overview).toMatch(/ya se estabilizaron/);
  });
});

describe('TS-21: el catalogo de codigo reusable suma el scheduler', () => {
  let index: string;
  let services: string;

  beforeAll(async () => {
    index = await readDoc('docs/reusable-code/jiku-mail-connector/index.md');
    services = await readDoc('docs/reusable-code/jiku-mail-connector/services.md');
  });

  it('index.md lista triggerTick, waitForCurrentTick, scheduleTick y createShutdownHandler', () => {
    for (const name of ['triggerTick', 'waitForCurrentTick', 'scheduleTick', 'createShutdownHandler']) {
      expect(index).toContain(name);
    }
  });

  it('services.md trae la entrada detallada de cada funcion nueva', () => {
    for (const heading of [
      '## triggerTick()',
      '## waitForCurrentTick()',
      '## scheduleTick()',
      '## createShutdownHandler()',
    ]) {
      expect(services).toContain(heading);
    }
  });
});
