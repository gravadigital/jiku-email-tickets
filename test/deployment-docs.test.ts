import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * La documentacion de despliegue del README, verificada por PALABRAS CLAVE estructurales.
 *
 * Afirmar sobre prosa con oraciones completas es fragil y no vale la pena: cualquier reescritura
 * legitima rompe el test y el siguiente lo borra. Lo que estos casos protegen es otra cosa —que
 * BORRAR la seccion rompa la suite— y para eso alcanza con anclar los terminos que no pueden
 * desaparecer sin que la seccion deje de servirle a U-02: `internal-app`, `caller_not_authorized`,
 * `:ro`, `JIKU_PROJECT_ID`, "una sola vez", "ingress".
 *
 * El fallo que previene es concreto: una documentacion de despliegue que nadie vuelve a leer se
 * pudre en silencio, y su ausencia solo se descubre cuando alguien tiene que desplegar de cero.
 */

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('README deployment section', () => {
  let readme: string;
  let deployment: string;

  beforeAll(async () => {
    readme = await readFile(new URL('README.md', `file://${PROJECT_ROOT}`), 'utf8');

    // Se afirma sobre la SECCION, no sobre el README entero: varios de estos terminos ya aparecen
    // en la seccion de `verify`, asi que buscarlos en todo el archivo daria un falso verde si la
    // seccion de despliegue se borrara.
    const start = readme.indexOf('## Desplegar');
    expect(start, 'the README must have a "## Desplegar" section').toBeGreaterThan(-1);

    const rest = readme.slice(start + 1);
    const nextHeading = rest.search(/\n## /);
    deployment = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  });

  it('places the deployment section after the verification one', () => {
    // El orden importa porque la seccion de despliegue REMITE a la tabla de diagnosticos de
    // `verify` en vez de duplicarla, y una remision hacia atras se lee sola.
    expect(readme.indexOf('## Verificar el despliegue')).toBeLessThan(readme.indexOf('## Desplegar'));
  });

  // TS-29
  it('lists the five deployment preconditions', () => {
    // 1. Machine user en Zitadel con Access Token Type = JWT y rol internal-app.
    expect(deployment).toContain('internal-app');
    expect(deployment).toContain('JWT');

    // 2. La key JSON se descarga UNA SOLA VEZ.
    expect(deployment).toMatch(/una sola vez/i);

    // 3. Creds del sentinel + el project id de Zitadel.
    expect(deployment).toMatch(/sentinel/i);
    expect(deployment).toContain('JIKU_PROJECT_ID');

    // 4. Una instancia de Jiku alcanzable con al menos un projectId real.
    expect(deployment).toContain('JIKU_VERIFY_PROJECT_ID');

    // 5. Red al bus, que no esta expuesta al ingress.
    expect(deployment).toContain('ingress');
  });

  it('says who resolves the preconditions and that none of them is code', () => {
    expect(deployment).toContain('U-02');
  });

  // TS-30
  it('states that the connector resolves none of them and fails legibly instead', () => {
    expect(deployment).toMatch(/no puede resolver ninguna/i);
    // Tolerante al salto de linea y al `**` del markdown: la frase esta envuelta en negrita y el
    // README respeta el ancho de columna, asi que una regex que exija los espacios exactos se
    // rompe con cualquier reflow legitimo del parrafo.
    expect(deployment.replace(/[*\s]+/g, ' ')).toMatch(/fall[ae]r? de forma legible/i);
    // Y remite a la tabla existente en vez de duplicarla: dos copias divergen.
    expect(deployment).toMatch(/diagn[oó]sticos/i);
  });

  it('names the three systems that can reject, because each fix lives somewhere else', () => {
    expect(deployment).toMatch(/Zitadel/);
    expect(deployment).toMatch(/\bbus\b/i);
    expect(deployment).toMatch(/core/);
  });

  // TS-31
  it('declares the first run failing with caller_not_authorized as the correct outcome', () => {
    expect(deployment).toContain('caller_not_authorized');
    expect(deployment).toContain('users');
    // Nadie tiene que crear la fila a mano: una corrida posterior tiene exito sola.
    expect(deployment).toMatch(/a mano|manual/i);
  });

  // TS-32
  it('declares the two read-only mounts and that the variables carry paths, not contents', () => {
    expect(deployment).toContain(':ro');
    expect(deployment).toContain('JIKU_KEY_FILE');
    expect(deployment).toContain('JIKU_CREDS');
    expect(deployment).toMatch(/ruta/i);
    // ADR-001: sin volumen de escritura. Un montaje de escritura seria un error, no una opcion.
    expect(deployment).toMatch(/escritura/i);
  });

  it('documents the ten configuration variables the orchestrator injects', () => {
    for (const variable of [
      'JIKU_CREDS',
      'JIKU_KEY_FILE',
      'JIKU_PROJECT_ID',
      'JIKU_VERIFY_PROJECT_ID',
      'JIKU_INSTANCE',
      'JIKU_SERVERS',
      'JIKU_ISSUER',
      'JIKU_TIMEOUT',
      'LOG_LEVEL',
      'NODE_ENV',
    ]) {
      expect(deployment, `${variable} must be documented`).toContain(variable);
    }
  });

  // TS-33
  it('declares the single-instance-per-mailbox restriction', () => {
    expect(deployment).toMatch(/una sola instancia|exactamente 1 instancia|1 instancia/i);
    // Y que no hay guard tecnico: por eso mismo tiene que estar escrito.
    expect(deployment).toMatch(/guard|no hay nada que lo impida|restricci[oó]n operativa/i);
  });

  // TS-34
  it('explains why the image has no HEALTHCHECK and what that costs operationally', () => {
    expect(deployment).toContain('HEALTHCHECK');
    expect(deployment).toMatch(/siempre pasa|no prueba nada/i);
    // La consecuencia aceptada: lo que el orquestador SI detecta es el proceso muerto.
    expect(deployment).toMatch(/reinicia|reinicio/i);
  });

  it('documents how to build and run the image', () => {
    expect(deployment).toContain('docker build');
    expect(deployment).toContain('docker run');
    expect(deployment).toContain('--target production');
  });

  it('documents how to run verify against the deployment, outside the CMD', () => {
    expect(deployment).toContain('dist/verify.js');
    // Con la advertencia que ya existe: cada corrida deja un requisito PERMANENTE.
    expect(deployment).toMatch(/prueba|permanente/i);
  });

  it('documents how the test stage runs the suite and why the build does not', () => {
    expect(deployment).toContain('--target test');
    expect(deployment).toMatch(/Testcontainers/i);
  });

  it('keeps development preconditions distinguishable from deployment ones', () => {
    // Confundirlas es exactamente el error que la seccion previene: las de desarrollo las resuelve
    // quien programa, las de despliegue las resuelve U-02 en tres sistemas que no son este repo.
    expect(readme).toContain('## Precondiciones');
    expect(readme.indexOf('## Precondiciones')).toBeLessThan(readme.indexOf('## Desplegar'));
  });
});
