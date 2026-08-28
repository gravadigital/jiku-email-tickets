import { loadConfig } from '@gravadigital/jiku/node';

import { loadEnvFromProcess } from '#config/env.js';
import { type LOG_LEVELS } from '#config/schema.js';

/**
 * La configuracion del adaptador IMAP, entera.
 *
 * Va anidada y no como cuatro campos sueltos porque el adaptador (S-009) la recibe completa: con
 * campos sueltos, cada firma nueva enumeraria los cuatro y cada consumidor tendria que recomponer
 * el subconjunto que le toca.
 */
export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

/** La configuracion del tick, entera. Mismo criterio: el scheduler (S-011) la recibe completa. */
export interface PollConfig {
  cron: string;
  enabled: boolean;
  maxPerTick: number;
}

/**
 * La configuracion unica del proceso: el entorno validado compuesto con lo que resuelve el SDK.
 *
 * Se escribe a mano y eso no contradice CA-9: CA-9 exige que los tipos del *schema* se infieran
 * (`Env` con z.infer), y asi es. `AppConfig` es un tipo de composicion entre `Env` y el
 * `LoadedConfig` del SDK — no duplica el schema, lo combina con un tipo externo. Definirlo
 * explicitamente es lo correcto: es el contrato que S-003, S-004 y S-005 consumen, y un tipo
 * inferido que cambiara en silencio les romperia los tests.
 */
export interface AppConfig {
  servers: string;
  instance: string;
  credsFile: string;
  keyFile: string;
  zitadelProjectId: string;
  issuer: string;
  timeoutMs: number;
  verifyProjectId: number;
  logLevel: (typeof LOG_LEVELS)[number];
  nodeEnv: 'development' | 'test' | 'production';

  // OJO con el anidamiento: `imap.password` queda a DOS niveles desde la raiz de este objeto, y a
  // TRES si alguien loguea el AppConfig entero dentro de un contexto. `redact.paths` de Pino NO
  // tiene comodin profundo (ver src/shared/log-redaction.ts): a esa profundidad el secreto saldria
  // EN CLARO, sin fallar y sin avisar. La defensa no es ampliar la lista de redaccion —seria
  // interminable y quedaria siempre un nivel atras— sino la regla estructural: NINGUN punto de log
  // emite el AppConfig completo, y hay un test de propiedad que lo afirma
  // (test/config/source-properties.test.ts).
  imap: ImapConfig;
  poll: PollConfig;
}

/**
 * Resuelve la configuracion del proceso.
 *
 * Invoca `loadConfig()` del SDK dentro de `src/config/`, que es lo que hace convivir CA-1 y CA-7:
 * el SDK lee el entorno por su cuenta, pero lo hace adentro del SDK, asi que el `grep process.env`
 * del conector sigue devolviendo un solo archivo, y sus defaults no se duplican a mano.
 */
export async function loadAppConfig(): Promise<AppConfig> {
  // El orden es intencional. El env se valida PRIMERO: loadConfig() lee el filesystem buscando
  // ~/.config/jiku/config.yaml y puede lanzar JikuError si ese archivo esta mal formado. CA-2 pide
  // que un entorno incompleto falle sin intentar nada antes.
  const env = loadEnvFromProcess();
  const sdk = await loadConfig();

  return {
    // El schema manda: loadConfig() no aplica el default de servers (lo hace resolveOptions() en
    // el connect(), que en esta story no corre) y el conector lo necesita ya resuelto.
    servers: env.JIKU_SERVERS,

    // El SDK ya defaultea instance a 'dev'. Redeclararlo violaria CA-7.
    instance: sdk.instance,

    // El valor del SDK va primero porque expande `~` en las rutas, que el schema no hace. El `??`
    // preserva el valor ya validado en vez de propagar un undefined a S-004.
    credsFile: sdk.credsFile ?? env.JIKU_CREDS,
    keyFile: sdk.zitadel.keyFile ?? env.JIKU_KEY_FILE,
    zitadelProjectId: sdk.zitadel.projectId ?? env.JIKU_PROJECT_ID,

    // Aca la logica es la inversa: el SDK deliberadamente NO defaultea el issuer, asi que si el
    // operador no configuro JIKU_ISSUER este viene undefined y el `??` cae al default del schema.
    issuer: sdk.zitadel.issuer ?? env.JIKU_ISSUER,

    // El piso de 15000 es del conector, no del SDK: resolveOptions() solo reemplaza valores <= 0.
    timeoutMs: env.JIKU_TIMEOUT,

    // El SDK no conoce ninguna de estas dos.
    verifyProjectId: env.JIKU_VERIFY_PROJECT_ID,
    logLevel: env.LOG_LEVEL,

    // La consume el logger para decidir formato (JSON vs pino-pretty). Llega por parametro, no por
    // lectura del entorno: el logger no toca process.env.
    nodeEnv: env.NODE_ENV,

    // Los siete valores salen ENTEROS del env validado: ninguno viene del SDK, que no conoce la
    // casilla. Sin `??` ni fallbacks — el schema ya aplico los defaults.
    imap: {
      host: env.IMAP_HOST,
      port: env.IMAP_PORT,
      user: env.IMAP_USER,
      password: env.IMAP_PASSWORD,
    },
    poll: {
      cron: env.POLL_CRON,
      enabled: env.POLL_ENABLED,
      maxPerTick: env.POLL_MAX_PER_TICK,
    },
  };
}
