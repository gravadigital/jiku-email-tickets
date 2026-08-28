import { AppError } from '#shared/errors/index.js';

/**
 * El diagnostico de un fallo de conexion IMAP.
 *
 * Union de literales, mismo criterio que `ConnectDiagnosis` en `infra/bus/errors.ts`: cada valor
 * nombra un sistema y un arreglo distinto (ADR-006), y una union hace que un `switch` en el punto
 * de log sea exhaustivo cuando se agregue un caso.
 *
 * - `credenciales_invalidas` -> el servidor rechazo el login. Usuario o password (App Password en
 *   Gmail).
 * - `host_inalcanzable`      -> nada contesto. Host, puerto, red, TLS.
 * - `desconocido`            -> no encaja en ninguna. Se loguea como tal, sin mapearse a otra.
 */
export type ImapConnectDiagnosis = 'credenciales_invalidas' | 'host_inalcanzable' | 'desconocido';

/** Los codigos de `errno` que significan "no se llego al servidor". */
const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
]);

/**
 * Los nombres de clase de `imapflow` que significan "credenciales invalidas".
 *
 * `AuthenticationFailure` es la clase que `imapflow` expone en su `.d.ts` para un login
 * rechazado por el servidor. Se compara por `name`, no por `instanceof`: mismo motivo que
 * `diagnoseConnectFailure()` en `infra/bus/errors.ts` — evitar depender de la identidad de
 * constructor entre copias del paquete.
 */
const AUTH_FAILURE_NAMES = new Set(['AuthenticationFailure']);

function codeOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

function nameOf(error: unknown): string | undefined {
  return error instanceof Error ? error.constructor.name : undefined;
}

/**
 * Clasifica un fallo de `connect()` de `imapflow` por ESTRUCTURA.
 *
 * Ninguna rama compara el texto del mensaje del cliente: se lee el `code` de `errno` y el nombre
 * del constructor del error, igual que `diagnoseConnectFailure()` en `infra/bus/errors.ts`. Un
 * diagnostico por texto es fragil ante un cambio de wording de la libreria, y ADR-006 pide
 * exactamente esto: distinguir el sistema que rechazo por estructura, nunca por interpolar el
 * mensaje crudo.
 */
export function diagnoseImapConnectFailure(error: unknown): ImapConnectDiagnosis {
  if (AUTH_FAILURE_NAMES.has(nameOf(error) ?? '')) {
    return 'credenciales_invalidas';
  }

  if (NETWORK_CODES.has(codeOf(error) ?? '')) {
    return 'host_inalcanzable';
  }

  return 'desconocido';
}

/** Que revisar para cada diagnostico. Es lo unico que el operador necesita del mensaje. */
const REMEDIES: Record<ImapConnectDiagnosis, string> = {
  credenciales_invalidas:
    'El servidor IMAP rechazo el login. Revisa el usuario y la password (en Gmail, un App ' +
    'Password, no la contrasena de la cuenta).',
  host_inalcanzable:
    'No se pudo llegar al servidor IMAP. Revisa el host, el puerto y la red hacia el servidor.',
  desconocido:
    'El fallo no encaja en ninguna causa conocida. La clase del error va en el contexto de esta ' +
    'linea, nunca su mensaje crudo.',
};

/**
 * No se pudo conectar (o abrir/usar) la casilla IMAP.
 *
 * Expone `diagnosis` y `sdkErrorClass` como CAMPOS, mismo patron que `BusConnectError`: el mensaje
 * y los campos NUNCA contienen la password ni el usuario. El `cause` original se conserva para
 * diagnostico interno (nunca se loguea completo; ver `infra/imap/client.ts`), pero ni `message` ni
 * `details` lo interpolan.
 */
export class ImapConnectError extends AppError {
  readonly code = 'IMAP_CONNECT_ERROR';
  readonly httpStatus = 500;

  readonly diagnosis: ImapConnectDiagnosis;
  readonly sdkErrorClass: string;

  constructor(diagnosis: ImapConnectDiagnosis, cause: unknown) {
    const sdkErrorClass = cause instanceof Error ? cause.constructor.name : typeof cause;

    super(`No se pudo conectar al servidor IMAP. ${REMEDIES[diagnosis]}`, {
      diagnosis,
      sdkErrorClass,
    });

    this.diagnosis = diagnosis;
    this.sdkErrorClass = sdkErrorClass;
    this.cause = cause;
  }
}
