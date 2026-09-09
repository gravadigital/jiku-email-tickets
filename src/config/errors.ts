import { SERVICE_NAME } from '#shared/service-info.js';
import { AppError } from '#shared/errors/index.js';

/**
 * Que se esperaba de cada variable, en palabras propias del conector.
 *
 * Esta tabla es lo que hace imposible filtrar un secreto (CA-10): el formateador toma solo
 * `issue.path` y describe la variable desde aca. El `message` de Zod no se interpola nunca, asi que
 * un valor no puede llegar al mensaje ni siquiera si una version futura de Zod empieza a incluir el
 * input en el issue.
 *
 * Se exporta para que un test pueda afirmar la correspondencia BIDIRECCIONAL con `envSchema`: una
 * variable futura sin entrada rompe la suite en vez de quedar muda en UNKNOWN_EXPECTATION.
 */
export const EXPECTATIONS: Record<string, string> = {
  JIKU_CREDS: 'se esperaba una ruta no vacia al archivo creds del sentinel',
  JIKU_KEY_FILE: 'se esperaba una ruta no vacia a la key JSON del machine user',
  JIKU_PROJECT_ID: 'se esperaba el project id de Zitadel, no vacio',
  JIKU_VERIFY_PROJECT_ID: 'se esperaba un entero positivo (el proyecto de Jiku del modo de verificacion)',
  JIKU_INSTANCE: 'se esperaba un nombre de instancia no vacio',
  JIKU_SERVERS: 'se esperaba una URL de servidores no vacia',
  JIKU_ISSUER: 'se esperaba una URL valida del issuer de Zitadel',
  JIKU_TIMEOUT: 'se esperaba un entero positivo de milisegundos',
  LOG_LEVEL: 'se esperaba uno de: trace, debug, info, warn, error, fatal, silent',
  NODE_ENV: 'se esperaba uno de: development, test, production',

  // --- Casilla IMAP (S-007) ---
  IMAP_HOST: 'se esperaba el host del servidor IMAP de la casilla, no vacio',
  IMAP_PORT: 'se esperaba un entero entre 1 y 65535 (el puerto IMAP, por default 993)',
  IMAP_USER: 'se esperaba el usuario de la casilla IMAP, no vacio',

  // El texto NO describe el formato de un password ni da ninguna pista sobre su contenido. Es la
  // primera variable del servicio cuyo VALOR es un secreto, asi que es el caso de mayor
  // consecuencia de toda la tabla.
  IMAP_PASSWORD: 'se esperaba la password de la casilla IMAP, no vacia',

  // --- Poll (S-007) ---
  POLL_CRON: 'se esperaba una expresion cron valida (la valida node-cron), por ejemplo */5 * * * *',
  POLL_ENABLED: 'se esperaba uno de: true, false',
  POLL_MAX_PER_TICK: 'se esperaba un entero mayor o igual a 1 (el maximo de mails por tick)',

  // --- Ruteo (S-012, con el Mapa de Tickets removido en S-025) ---
  // Las dos entradas del Mapa de Tickets se eliminaron junto con sus claves: su fuente es el bucket
  // KV de slugs, no la configuracion. Con ellas se fue la unica entrada de toda esta tabla que
  // describia una REGLA y no un formato — no quedo ninguna, porque el schema ya no tiene ninguna
  // regla cross-field que explicar.
  SUBADDRESS_PREFIX:
    'se esperaba el prefijo del subaddress, no vacio (por default tickets)',
  // A diferencia de las otras dos, esta entrada NO cita su default literal, y es a proposito: el
  // texto del default ("Ticket recibido por mail") contiene la palabra "recibido", y toda la tabla
  // sostiene la propiedad de describir QUE se esperaba y nunca que se recibio — hay un test que la
  // afirma sobre las cinco entradas. Citar el literal aca convertiria esa propiedad en una excepcion
  // que despues nadie sabe distinguir de una fuga real. El default vive en DEFAULT_PLACEHOLDER_TITLE
  // y esta documentado en .env.example y en el README, que es donde el operador lo busca.
  PLACEHOLDER_TITLE:
    'se esperaba el titulo con el que se da de alta un mail sin asunto, no vacio ' +
    '(hay un default, ver DEFAULT_PLACEHOLDER_TITLE)',
  PLACEHOLDER_BODY:
    'se esperaba el cuerpo con el que se da de alta un mail sin contenido, no vacio ' +
    '(por default (mail sin contenido))',

  // --- Politica local de archivos (adjuntos, S-017) ---
  ATTACHMENT_ALLOWED_EXTENSIONS:
    'se esperaba una lista de extensiones separadas por coma, no vacia (por ejemplo .png,.pdf)',
  ATTACHMENT_ALLOWED_MIME_TYPES:
    'se esperaba una lista de tipos MIME separados por coma, no vacia ' +
    '(por ejemplo image/png,application/pdf)',
  ATTACHMENT_MAX_SIZE_BYTES:
    'se esperaba un entero positivo de bytes (el tamano maximo por adjunto)',
  PUT_TIMEOUT_MS:
    'se esperaba un entero positivo de milisegundos (el timeout del PUT del byte del adjunto)',

  // --- KV (S-024) ---
  // Los cuatro textos describen QUE se esperaba y NUNCA que se recibio, igual que el resto de la
  // tabla, y no interpolan ningun valor. Los dos de TTL/retry nombran su unidad, que es lo unico
  // que un operador puede equivocar aca: KV_THREADS_TTL_DAYS esta en DIAS (es la unidad de
  // `nats kv add --ttl=90d`) y KV_WATCH_RETRY_MS en milisegundos.
  KV_TICKETS_BUCKET:
    'se esperaba el nombre del bucket KV del Mapa de Tickets, no vacio ' +
    '(por default TICKETS, y el conector no lo crea: lo crea el operador)',
  KV_THREADS_BUCKET:
    'se esperaba el nombre del bucket KV del Mapa de Hilos, no vacio ' +
    '(por default MAIL_THREADS, y el conector no lo crea: lo crea el operador)',
  KV_THREADS_TTL_DAYS:
    'se esperaba un entero positivo de DIAS (el TTL esperado del bucket de hilos, que el ' +
    'conector compara contra el del bucket y no fija)',
  KV_WATCH_RETRY_MS:
    'se esperaba un entero positivo de milisegundos (el intervalo del reintento del watch del KV)',
};

const UNKNOWN_EXPECTATION = 'no paso la validacion declarada en el schema';

export class ConfigValidationError extends AppError {
  readonly code = 'CONFIG_VALIDATION_ERROR';

  // El servicio no expone HTTP (ADR-001), pero la convencion `error-handling` declara httpStatus
  // abstracto y no se diverge de ella. 500 porque una config invalida es un fallo del despliegue,
  // no del input de un cliente. Su valor no se consume en ningun lado.
  readonly httpStatus = 500;

  readonly variables: string[];

  constructor(message: string, variables: string[]) {
    super(message, { variables });
    this.variables = variables;
  }
}

/** Forma minima de un issue de Standard Schema: solo se lee `path`. */
interface ValidationIssueLike {
  readonly path?: PropertyKey[] | readonly unknown[] | undefined;
}

function variableNameOf(issue: ValidationIssueLike): string | undefined {
  const segment = issue.path?.[0];
  if (typeof segment === 'string') return segment;
  // Standard Schema permite segmentos como { key }.
  if (typeof segment === 'object' && segment !== null && 'key' in segment) {
    const { key } = segment as { key: unknown };
    if (typeof key === 'string') return key;
  }
  return undefined;
}

/**
 * Traduce los issues agregados de la validacion en un unico error con la lista completa.
 *
 * `@t3-oss/env-core` invoca `onValidationError` una sola vez con todos los issues, asi que este es
 * el unico lugar donde se construye el reporte que U-02 lee para arreglar el despliegue en una sola
 * pasada (CA-2).
 */
export function toConfigValidationError(issues: readonly ValidationIssueLike[]): ConfigValidationError {
  const variables = [...new Set(issues.map(variableNameOf).filter((name): name is string => name !== undefined))].sort();

  const count = variables.length;
  const subject = count === 1 ? '1 variable' : `${String(count)} variables`;
  const closing = count === 1 ? 'Corregila' : `Corregi las ${String(count)}`;
  const lines = [
    `${SERVICE_NAME}: la configuracion es invalida. Faltan o son invalidas ${subject}:`,
    ...variables.map((name) => `  - ${name}: ${EXPECTATIONS[name] ?? UNKNOWN_EXPECTATION}`),
    `El proceso no arranca. ${closing} y volve a intentar.`,
  ];

  return new ConfigValidationError(lines.join('\n'), variables);
}
