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

  // --- Ruteo (S-012) ---
  // Esta entrada es la unica de la tabla que describe una REGLA y no solo un formato, y es
  // deliberado: los dos issues cross-field de las dos fuentes excluyentes aterrizan en el path de
  // TICKET_MAP, asi que esto es lo unico que el operador va a leer cuando se equivoque. Si dijera
  // solo "se esperaba un JSON de objeto", quien declaro las dos fuentes no tendria forma de saber
  // que el problema es haber declarado tambien el archivo.
  TICKET_MAP:
    'se esperaba el Mapa de Tickets como JSON de objeto slug -> projectId entero positivo, ' +
    'declarado en EXACTAMENTE UNA de las dos fuentes: esta variable o TICKET_MAP_FILE. ' +
    'Declarar las dos, o ninguna, no arranca. Un mapa vacio ({}) es valido',
  TICKET_MAP_FILE:
    'se esperaba la ruta a un archivo legible con el Mapa de Tickets, con el mismo JSON que ' +
    'TICKET_MAP y excluyente con ella',
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
