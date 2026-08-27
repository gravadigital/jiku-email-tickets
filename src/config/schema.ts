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
};

export type Env = z.infer<z.ZodObject<typeof envSchema>>;
