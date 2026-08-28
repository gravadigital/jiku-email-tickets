import { validate as isValidCron } from 'node-cron';
import { z } from 'zod';

// El servidor corta a los 10 s y PostgreSQL a los 8 s. Un timeout mas corto que el del servidor
// convierte un error explicado en un timeout mudo: el cliente se rinde antes de que el sistema
// alcance a decir que fallo. Por eso 15000 es piso y no default — bajarlo parece una mejora y
// empeora exactamente lo que protege (ADR-006, NFR-P03).
export const MIN_TIMEOUT_MS = 15_000;

// El SDK deliberadamente NO defaultea el issuer: una libreria generica que adivinara apuntaria a
// la instancia de otro o a un host inexistente. Este conector no es generico — es de Grava y
// apunta a la instancia de Grava — asi que el default es legitimo aca y sale del schema propio,
// no del SDK. No se toca `loadConfig()` (CA-7 sigue valiendo: no duplica ningun default del SDK,
// porque el SDK no tiene uno para este valor).
export const DEFAULT_ISSUER = 'https://id.grava.io';

// El SDK tiene este mismo default pero lo aplica `resolveOptions()` en el `connect()`, no
// `loadConfig()`. El conector necesita el valor resuelto antes de conectar, asi que lo declara aca.
export const DEFAULT_SERVERS_URL = 'nats://localhost:4222';

// 993 es IMAPS (IMAP sobre TLS implicito), que es lo que expone Gmail y lo que la casilla usa. Va
// como constante nombrada y no como literal suelto para que S-009 pueda referirlo sin copiarlo,
// siguiendo el precedente de MIN_TIMEOUT_MS / DEFAULT_ISSUER / DEFAULT_SERVERS_URL.
export const DEFAULT_IMAP_PORT = 993;

// Cada cinco minutos. El tick NUNCA se dispara al arrancar (S-011): el primero llega con el cron.
export const DEFAULT_POLL_CRON = '*/5 * * * *';

// El tope de mails por tick. Acota el trabajo de un tick para que una casilla con backlog no se
// procese entera de una sola vez; lo consume el tick (S-010).
export const DEFAULT_POLL_MAX_PER_TICK = 50;

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;

export const envSchema = {
  // --- Requeridas ---
  // JIKU_CREDS y JIKU_KEY_FILE son RUTAS a archivos montados read-only (ADR-005), no contenido.
  // Esta capa solo valida que la ruta este declarada; que el archivo se pueda leer y parsear es S-004.
  JIKU_CREDS: z.string().min(1),
  JIKU_KEY_FILE: z.string().min(1),
  JIKU_PROJECT_ID: z.string().min(1),
  JIKU_VERIFY_PROJECT_ID: z.coerce.number().int().positive(),

  // --- Con default ---
  JIKU_INSTANCE: z.string().min(1).default('dev'),
  JIKU_SERVERS: z.string().min(1).default(DEFAULT_SERVERS_URL),
  JIKU_ISSUER: z.string().url().default(DEFAULT_ISSUER),

  // El .transform() va DESPUES del .default() para que el piso se aplique tanto al valor provisto
  // como al default: 5000 -> 15000, ausente -> 15000, 30000 -> 30000.
  JIKU_TIMEOUT: z.coerce
    .number()
    .int()
    .positive()
    .default(MIN_TIMEOUT_MS)
    .transform((ms) => Math.max(ms, MIN_TIMEOUT_MS)),

  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  // El default es `production`, NO `development`, y es deliberado aunque vaya contra lo que hace la
  // mayoria de los proyectos Node: el modo caro y bonito (`pino-pretty`) se pide EXPLICITAMENTE, no
  // se obtiene por olvido. Un despliegue que se olvido de declarar NODE_ENV emite JSON, que es lo
  // correcto; el error inverso —un contenedor de produccion intentando cargar un `pino-pretty` que
  // `--omit=dev` dejo afuera de la imagen— es peor. No lo "corrijas" a development.
  //
  // La consume el logger (S-003), que la recibe por parametro: NODE_ENV se declara aca porque el
  // logger no puede leer process.env por su cuenta (convencion `env-config`).
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),

  // --- Casilla IMAP ---
  // Las tres credenciales son REQUERIDAS incluso con el poll deshabilitado, y se declaran asi SIN
  // NINGUNA logica condicional: `pollEnabled` es un interruptor operativo, no un modo de despliegue
  // distinto. Un schema condicional convertiria un interruptor en dos configuraciones validas
  // distintas, y la segunda no la ejercita nadie.
  //
  // Desde S-007 dejan de ser opcionales por ausencia: con la ingesta en alcance, un despliegue sin
  // casilla no arranca en vez de quedar vivo sin ingestar nada y sin sintoma.
  IMAP_HOST: z.string().min(1),
  IMAP_PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_IMAP_PORT),
  IMAP_USER: z.string().min(1),

  // El unico secreto que este servicio recibe EN EL VALOR de una variable: las dos del bus
  // (JIKU_CREDS, JIKU_KEY_FILE) son rutas a archivos montados read-only. De ahi que su entrada en
  // EXPECTATIONS no sea opcional — sin ella el fallo caeria en UNKNOWN_EXPECTATION, que es correcto
  // pero mudo.
  IMAP_PASSWORD: z.string().min(1),

  // --- Poll (comportamiento del tick) ---
  // Se valida con `validate()` de la propia libreria que despues lo schedula, NO con un regex
  // propio: un regex que acepte lo que node-cron rechaza reintroduce el fallo diferido en el peor
  // lugar posible — ya con el logger construido y la conexion abierta, que es exactamente lo que
  // este modulo existe para evitar.
  POLL_CRON: z.string().min(1).default(DEFAULT_POLL_CRON).refine(isValidCron),

  // NO usar z.coerce.boolean(): aplica Boolean(value), y `Boolean('false')` es TRUE. O sea que
  // POLL_ENABLED=false HABILITARIA el poll, en silencio y sin error. La coercion va explicita, y un
  // valor que no sea 'true' ni 'false' NO ARRANCA — que es lo correcto para un interruptor
  // operativo: POLL_ENABLED=si debe fallar, no interpretarse.
  POLL_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // .min(1) y no .positive(): son equivalentes para enteros, pero .min(1) es lo que el criterio dice
  // literalmente ("el minimo es 1") y hace que el mensaje de EXPECTATIONS se lea igual que el
  // criterio.
  POLL_MAX_PER_TICK: z.coerce.number().int().min(1).default(DEFAULT_POLL_MAX_PER_TICK),
};

export type Env = z.infer<z.ZodObject<typeof envSchema>>;
