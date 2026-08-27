import { loadConfig } from '@gravadigital/jiku/node';

import { loadEnvFromProcess } from '#config/env.js';
import { type LOG_LEVELS } from '#config/schema.js';

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
  };
}
