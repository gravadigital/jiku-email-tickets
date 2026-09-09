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
  it('lists the six deployment preconditions', () => {
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

    // 6 (S-011, CA-14). La casilla acepta subaddress y tiene IMAP habilitado.
    expect(deployment).toMatch(/subaddress/i);
    expect(deployment).toMatch(/IMAP habilitado/i);
  });

  // TS-20/CA-14 (S-011): las tres precondiciones de la casilla, ancladas por palabra clave para
  // que una reescritura futura no las borre en silencio.
  it('documents the three mailbox preconditions: subaddress, IMAP enabled, and App Password', () => {
    expect(deployment).toMatch(/subaddress/i);
    expect(deployment).toMatch(/IMAP habilitado/i);
    expect(deployment).toMatch(/App Password/i);
    // Nunca la contraseña de la cuenta: es la distincion que evita el error mas comun al desplegar.
    expect(deployment).toMatch(/no.*la contrase[ñn]a de la cuenta/i);
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

  // TS-47. ACTUALIZADO VARIAS VECES, y la cuenta es parte del rastro: eran diez hasta S-006; S-007
  // sumo las cuatro de la casilla y las tres del poll; S-012 las cinco del ruteo; S-024 las cuatro
  // del KV; y S-025 SACO las dos del Mapa de Tickets, que se mudo al bucket. Un operador que
  // despliega de cero tiene que poder hacerlo leyendo esta seccion, sin abrir el codigo.
  it('documents the twenty-four configuration variables the orchestrator injects', () => {
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
      'IMAP_HOST',
      'IMAP_PORT',
      'IMAP_USER',
      'IMAP_PASSWORD',
      'POLL_CRON',
      'POLL_ENABLED',
      'POLL_MAX_PER_TICK',
      'SUBADDRESS_PREFIX',
      'PLACEHOLDER_TITLE',
      'PLACEHOLDER_BODY',
      'KV_TICKETS_BUCKET',
      'KV_THREADS_BUCKET',
      'KV_THREADS_TTL_DAYS',
      'KV_WATCH_RETRY_MS',
    ]) {
      expect(deployment, `${variable} must be documented`).toContain(variable);
    }

    // Y las dos que S-025 elimino NO siguen documentadas como si existieran: un operador que las
    // encuentre en el README las va a declarar, y no van a hacer nada.
    for (const gone of ['TICKET_MAP=', 'TICKET_MAP_FILE=']) {
      expect(deployment, `${gone} must be gone from the docs`).not.toContain(gone);
    }
  });

  // TS-48, INVERTIDO EN S-025. Afirmaba que el README explicaba las DOS FUENTES EXCLUYENTES del
  // Mapa de Tickets y el tercer montaje read-only del archivo. S-025 elimino las dos fuentes y el
  // montaje: el mapa vive en un bucket KV. Lo que el operador necesita ahora es el comando que lo
  // carga y saber que el cambio es EN CALIENTE — que es justo lo contrario de lo que decia antes.
  it('explains the KV bucket that holds the map, and that it loads without a redeploy', () => {
    // El comando exacto, porque es lo que el operador ejecuta.
    expect(deployment).toContain('nats kv put');
    expect(deployment).toContain('nats kv add');
    // Y la propiedad que REQ-005 compra: sin redeploy.
    expect(deployment).toMatch(/sin redeploy|no necesita redeploy|en caliente/i);
    // Los dos montajes read-only que SI quedan (la key y el creds) siguen documentados.
    expect(deployment).toContain(':ro');
  });

  // CA-10 desde el lado de la documentacion: para que un operador no busque una variable de
  // carpeta que no existe.
  it('states that INBOX is fixed and not configurable', () => {
    expect(deployment).toContain('INBOX');
    expect(deployment).toMatch(/no es configurable|fija/i);
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

/**
 * TS-40 (S-007). `.env.example` es la lista canonica que se commitea, exigida por la convencion
 * `env-config`. Es donde el proximo desarrollador busca que hay que configurar, asi que una
 * variable declarada en el schema y ausente de aca es una variable invisible.
 */
describe('.env.example', () => {
  let example: string;

  beforeAll(async () => {
    example = await readFile(new URL('.env.example', `file://${PROJECT_ROOT}`), 'utf8');
  });

  it('declares the three IMAP credentials as required', () => {
    for (const name of ['IMAP_HOST', 'IMAP_USER', 'IMAP_PASSWORD']) {
      const line = example.split('\n').find((l) => l.trimStart().startsWith(`${name}=`));

      expect(line, `${name} must be declared`).toBeDefined();
      expect(line, `${name} must be marked required`).toMatch(/REQUERIDA/);
    }
  });

  it('declares the four optional variables with their literal default', () => {
    for (const [name, fallback] of [
      ['IMAP_PORT', '993'],
      ['POLL_CRON', '*/5 * * * *'],
      ['POLL_ENABLED', 'true'],
      ['POLL_MAX_PER_TICK', '50'],
    ] as const) {
      const line = example.split('\n').find((l) => l.trimStart().startsWith(`${name}=`));

      expect(line, `${name} must be declared`).toBeDefined();
      expect(line, `${name} must state its default`).toMatch(/default/i);
      expect(line, `${name} must name ${fallback}`).toContain(fallback);
    }
  });

  it('notes that the IMAP password is an App Password that arrives by environment', () => {
    expect(example).toMatch(/App Password/i);
  });

  // CA-10: la ausencia se lee como decision, no como olvido.
  it('states that there is no folder variable because INBOX is fixed', () => {
    expect(example).toContain('INBOX');
    expect(example).not.toMatch(/^\s*IMAP_(FOLDER|MAILBOX|INBOX)=/m);
  });

  // TS-44, ACOTADO EN S-025: eran cinco y quedan TRES. Las dos del Mapa de Tickets ya no se
  // declaran en el `.env` porque el mapa se mudo al bucket KV. Las tres que quedan son opcionales y
  // cada una tiene que nombrar su default literal.
  it('declares the three routing variables, each with its default', () => {
    for (const [name, fallback] of [
      ['SUBADDRESS_PREFIX', 'tickets'],
      ['PLACEHOLDER_TITLE', 'Ticket recibido por mail'],
      ['PLACEHOLDER_BODY', '(mail sin contenido)'],
    ] as const) {
      const line = example.split('\n').find((l) => l.trimStart().startsWith(`${name}=`));

      expect(line, `${name} must be declared`).toBeDefined();
      expect(line, `${name} must state its default`).toMatch(/default/i);
      expect(line, `${name} must name ${fallback}`).toContain(fallback);
    }

    // Y las dos del mapa NO vuelven a declararse: declararlas no haria nada, y un `.env.example`
    // que las ofrece manda al operador a configurar algo que el conector ya no lee.
    for (const gone of ['TICKET_MAP', 'TICKET_MAP_FILE'] as const) {
      const line = example.split('\n').find((l) => l.trimStart().startsWith(`${gone}=`));

      expect(line, `${gone} must NOT be declared any more`).toBeUndefined();
    }
  });

  // TS-45, INVERTIDO EN S-025. Afirmaba que el `.env.example` documentaba las dos fuentes
  // excluyentes y que declarar las dos no arranca. Esa regla ya no existe.
  //
  // La que un operador puede equivocar AHORA es otra: buscar TICKET_MAP en el `.env.example`, no
  // encontrarla, y no saber donde se configura el mapa. Por eso el archivo tiene que decir
  // explicitamente adonde se mudo y con que comando se carga — no simplemente omitirla.
  it('says where the ticket map moved to, instead of silently dropping it', () => {
    expect(example).toMatch(/TICKET_MAP/);
    expect(example).toMatch(/KV|bucket/);
    expect(example).toContain('nats kv put');
    // Y el nombre de la variable que SI configura algo del mapa hoy.
    expect(example).toContain('KV_TICKETS_BUCKET');
  });

  it('carries no real value: every declaration is an empty assignment', () => {
    const declarations = example
      .split('\n')
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line.trimStart()));

    expect(declarations.length).toBeGreaterThan(10);
    for (const line of declarations) {
      const [, afterEquals = ''] = line.trimStart().split(/=(.*)/s);
      const value = afterEquals.split('#')[0] ?? '';

      expect(value.trim(), `${line} must not carry a value`).toBe('');
    }
  });
});

/**
 * TS-44 (S-007), TS-49 (S-012). Los tests que cambiaron de sentido se INVIRTIERON, no se borraron:
 * un test borrado no deja rastro de que la regla cambio a proposito, y el proximo que lea el archivo
 * no tiene forma de distinguir "esto se decidio" de "esto se perdio".
 *
 * El describe ya no dice "two": S-012 sumo sus propias inversiones a los mismos dos archivos, sin
 * perder las de S-007. Los dos rastros conviven porque documentan dos decisiones distintas.
 */
describe('the inverted test cases', () => {
  const TEST_ROOT = fileURLToPath(new URL('.', import.meta.url));

  it('keeps both cases alive, each naming the story that inverted the rule', async () => {
    for (const [file, caseName] of [
      ['config/schema.test.ts', 'declares the four IMAP and three POLL variables'],
      ['config/env.test.ts', 'does not resolve when no IMAP variable is present'],
    ] as const) {
      const source = await readFile(new URL(file, `file://${TEST_ROOT}`), 'utf8');

      expect(source, `${file} must keep the inverted case`).toContain(caseName);
      // Los enunciados viejos ya no pueden estar: si estuvieran, el caso se duplico en vez de
      // invertirse, y la suite afirmaria las dos reglas opuestas a la vez.
      expect(source).not.toContain('declares no IMAP or ticket-map variable in this scope');
      expect(source).not.toContain('resolves without throwing when no IMAP');
    }
  });

  // Las inversiones de S-007 SIGUEN ahi: la de schema.test.ts quedo absorbida en el comentario del
  // caso que S-012 volvio a invertir, y la de env.test.ts conserva su rastro propio.
  it('keeps the S-007 inversions on record', async () => {
    const schemaSource = await readFile(new URL('config/schema.test.ts', `file://${TEST_ROOT}`), 'utf8');
    const envSource = await readFile(new URL('config/env.test.ts', `file://${TEST_ROOT}`), 'utf8');

    for (const source of [schemaSource, envSource]) {
      expect(source).toContain('S-007');
    }
  });

  // TS-49. Las de S-012 (el mapa pasa a ser requerido y sus claves se declaran) y las de S-025, que
  // las vuelve a invertir al mudar el mapa al KV y sacar las dos claves del schema.
  //
  // Lo que se exige es que la inversion quede REGISTRADA, no una cadena literal concreta: el texto
  // de S-012 ya no existe tal cual porque S-025 lo reescribio para contar las dos vueltas
  // ("INVERTIDO DOS VECES, nunca borrado"). Pedir el literal viejo obligaria a conservar una
  // redaccion que quedo incompleta, que es lo contrario de lo que este caso quiere.
  it('records the S-012 and S-025 inversions in the same two files', async () => {
    for (const file of ['config/schema.test.ts', 'config/env.test.ts'] as const) {
      const source = await readFile(new URL(file, `file://${TEST_ROOT}`), 'utf8');

      expect(source, `${file} must record that a case was INVERTED, not deleted`).toMatch(
        /INVERTID[OA]/,
      );
      // Y las dos stories que lo invirtieron quedan nombradas, para que el rastro diga CUANDO.
      expect(source, `${file} must name S-012`).toContain('S-012');
      expect(source, `${file} must name S-025`).toContain('S-025');
    }
  });

  // El caso de schema.test.ts que S-012 ACOTA en vez de invertir: la prohibicion de `superRefine`
  // sobre config/schema.ts se levanta, pero la del interruptor POLL_ENABLED sigue viva.
  it('keeps the narrowed POLL_ENABLED rule alive after S-012 lifted the superRefine ban', async () => {
    const source = await readFile(new URL('config/schema.test.ts', `file://${TEST_ROOT}`), 'utf8');

    expect(source).toContain('implements that requirement with no conditional logic at all');
    expect(source).toContain('POLL_ENABLED');
  });
});
