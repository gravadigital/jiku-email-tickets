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
 * La configuracion del ruteo, entera. Mismo criterio que `imap` y `poll`: el lookup del proyecto
 * (S-013) y el alta del requisito (S-015) reciben cada uno lo que les toca sin recomponerlo.
 *
 * # EL `ticketMap` CAMBIO DE DUENO, NO DE TIPO (S-025)
 *
 * Sigue siendo un `ReadonlyMap<string, number>` con las claves ya normalizadas a minusculas, y
 * `routeMail()` sigue haciendo el mismo `Map.get()` sin transformar nada. Lo que cambio es de donde
 * VIENE: hasta S-024 lo construia el schema desde `TICKET_MAP`/`TICKET_MAP_FILE`; desde S-025 es la
 * copia en memoria VIVA que `startTicketMapWatch()` mantiene sobre el bucket KV de slugs.
 *
 * **Ese Map es EL MISMO OBJETO durante toda la vida del proceso**: el watch lo muta con
 * `set`/`delete` y nunca lo reemplaza, que es lo que permite que este campo sea una referencia fija
 * y vea las actualizaciones en caliente sin que nadie reasigne nada. Un `new Map(...)` defensivo, un
 * spread o un `structuredClone` en el camino romperian esa vivacidad SIN FALLAR EN COMPILACION: el
 * conector rutearia bien los slugs iniciales y nunca veria uno nuevo.
 *
 * El tipo es `ReadonlyMap` y no `Map` por lo mismo que antes: no impide que el DUENO lo mute —el
 * modulo del watch—, solo impide que lo muten los consumidores, que es exactamente lo que se quiere.
 */
export interface RuteoConfig {
  ticketMap: ReadonlyMap<string, number>;
  subaddressPrefix: string;
  placeholderTitle: string;
  placeholderBody: string;
}

/**
 * La configuracion de la politica local de archivos (adjuntos, FG-4). Mismo criterio que `imap` /
 * `poll` / `ruteo`: interfaz anidada, no campos sueltos -- `particionar()` (S-017) la recibe
 * completa (o el subconjunto que necesita via `Pick`).
 */
export interface AdjuntosConfig {
  allowedExtensions: readonly string[];
  allowedMimeTypes: readonly string[];
  maxSizeBytes: number;
  putTimeoutMs: number;
}

/**
 * La configuracion del KV de NATS: los dos buckets, el TTL esperado del de hilos y el reintento
 * del watch (REQ-005 / S-024).
 *
 * Mismo criterio estructural que `imap` / `poll` / `ruteo` / `adjuntos`: interfaz anidada y no
 * cuatro campos sueltos, porque `openKvStores()` (src/infra/kv/stores.ts) la recibe completa o via
 * `Pick`, y con campos sueltos cada firma nueva enumeraria los cuatro.
 *
 * `threadsTtlDays` es el valor ESPERADO, no el que se fija: el conector compara y avisa, nunca
 * escribe limites del stream (CA-8 de S-024). `watchRetryMs` lo consume `startTicketMapWatch()`
 * (S-025): es el intervalo del reintento del watch caido.
 */
export interface KvConfig {
  ticketsBucket: string;
  threadsBucket: string;
  threadsTtlDays: number;
  watchRetryMs: number;
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
  /**
   * El proyecto de prueba del modo de verificacion. OPCIONAL: lo lee UN SOLO consumidor
   * (`src/verify.ts`), y el worker nunca lo toca — por eso un despliegue que solo corre el worker
   * no tiene por que declarar un proyecto de prueba que no usa.
   *
   * `undefined` NO es un fallo de configuracion: es el estado normal de ese despliegue. El unico
   * que lo convierte en error es `verify`, que sale distinto de cero si lo necesita y no esta.
   */
  verifyProjectId: number | undefined;
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

  // El bloque del ruteo entra bajo la MISMA regla estructural que el comentario de arriba: ningun
  // punto de log emite el AppConfig completo. Agrega una razon propia — el `ticketMap` es la
  // topologia comercial del despliegue, los projectId de todos los clientes habilitados, y no tiene
  // por que estar en stdout. El escaner de `test/config/source-properties.test.ts` lo cubre.
  ruteo: RuteoConfig;

  // La politica local de archivos de FG-4 (S-017). No lleva ningun secreto, pero se mantiene
  // anidada por el mismo criterio estructural que los bloques de arriba.
  adjuntos: AdjuntosConfig;

  // El KV de NATS (S-024). Tampoco lleva ningun secreto —dos nombres de bucket y dos numeros— y
  // entra igual bajo la MISMA regla estructural que los bloques de arriba: NINGUN punto de log
  // emite el AppConfig completo, y hay un test de propiedad que lo afirma
  // (test/config/source-properties.test.ts). Los logs del modulo de KV enumeran a mano los campos
  // que necesitan (`ticketsBucket`, `threadsBucket`) en un contexto PLANO, no el bloque entero.
  kv: KvConfig;
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

    // El SDK no conoce ninguna de estas dos. `verifyProjectId` puede venir undefined y se propaga
    // asi a proposito: el compositor no decide si eso es un error — lo decide su unico consumidor.
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

    // Los tres valores restantes salen ENTEROS del env validado, sin `??` ni fallbacks: el schema
    // ya aplico los defaults.
    ruteo: {
      // EL MAPA NO VIENE DEL ENTORNO (S-025). `loadAppConfig()` corre en el paso 1 del arranque,
      // mucho antes de que exista una conexion al bus, asi que NO PUEDE tener el mapa del KV: la
      // copia viva la produce `startTicketMapWatch()` en el paso 5.6, y `runStartup()` construye el
      // `AppConfig` FINAL con ella (ver `withTicketMap()` abajo).
      //
      // Este `Map` vacio es el valor del config PARCIAL que sale de aca. No es un default
      // "razonable" del mapa y no hay ninguno: el mapa ya no es configuracion del proceso.
      ticketMap: new Map<string, number>(),
      subaddressPrefix: env.SUBADDRESS_PREFIX,
      placeholderTitle: env.PLACEHOLDER_TITLE,
      placeholderBody: env.PLACEHOLDER_BODY,
    },

    // Los cuatro valores salen ENTEROS del env validado, sin `??` ni fallbacks: el schema ya
    // aplico los defaults y ya parseo las dos listas.
    adjuntos: {
      allowedExtensions: env.ATTACHMENT_ALLOWED_EXTENSIONS,
      allowedMimeTypes: env.ATTACHMENT_ALLOWED_MIME_TYPES,
      maxSizeBytes: env.ATTACHMENT_MAX_SIZE_BYTES,
      putTimeoutMs: env.PUT_TIMEOUT_MS,
    },

    // Los cuatro valores salen ENTEROS del env validado, sin `??` ni fallbacks: el schema ya
    // aplico los cuatro defaults. Ninguno es cross-field, asi que ninguno paso por
    // `createFinalSchema` y no hay nada que recomponer aca.
    kv: {
      ticketsBucket: env.KV_TICKETS_BUCKET,
      threadsBucket: env.KV_THREADS_BUCKET,
      threadsTtlDays: env.KV_THREADS_TTL_DAYS,
      watchRetryMs: env.KV_WATCH_RETRY_MS,
    },
  };
}

/**
 * Compone el `AppConfig` FINAL con el Mapa de Tickets vivo del KV.
 *
 * Es la mitad que le falta a `loadAppConfig()`: el mapa no puede existir todavia cuando la
 * configuracion se valida (paso 1), porque viene de un bucket que se abre sobre una conexion que
 * todavia no existe (paso 5.5). `runStartup()` llama a esta funcion en el paso 5.6, con el `Map`
 * que `startTicketMapWatch()` acaba de poblar.
 *
 * # POR QUE SE CONSTRUYE Y NO SE ASIGNA
 *
 * La alternativa era mutar `config.ruteo.ticketMap` despues de armar el config. Se descarto: el
 * `AppConfig` es un valor que el resto del servicio trata como inmutable una vez armado, y una
 * asignacion tardia hace que un `readonly` mal puesto o un clon intermedio rompan la vivacidad del
 * mapa **sin fallar en compilacion**. Construirlo hace que `config.ruteo.ticketMap` NAZCA apuntando
 * al `Map` vivo y que nadie lo reasigne nunca.
 *
 * # LA REGLA DURA
 *
 * El `ticketMap` se propaga **POR REFERENCIA**. Ningun `new Map(ticketMap)`, ningun spread, ninguna
 * copia defensiva: la copia quedaria congelada en el estado del arranque y el conector no veria
 * nunca un slug agregado en caliente — el valor central de S-025 fallando en silencio.
 */
export function withTicketMap(
  config: AppConfig,
  ticketMap: ReadonlyMap<string, number>,
): AppConfig {
  return { ...config, ruteo: { ...config.ruteo, ticketMap } };
}
