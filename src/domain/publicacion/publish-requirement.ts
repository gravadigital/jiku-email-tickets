import type { Client } from '@gravadigital/jiku';
import type { Logger } from 'pino';

import {
  PublishError,
  diagnosePublishFailure,
} from '#domain/publicacion/publish-errors.js';
import { newRequirementReplySchema } from '#domain/publicacion/requirement.schema.js';
import { buildVerificationPayload, parseNewRequirement } from '#domain/publicacion/verification-payload.js';

/**
 * La publicacion de `requirements.new`: el primer codigo del repositorio que ESCRIBE en Jiku.
 *
 * Es el corazon del walking skeleton. Publica el comando reusando la conexion unica de S-004,
 * valida la respuesta, loguea el exito con `{ projectId, requirementId }` en UNA linea, y en caso
 * de fallo produce el diagnostico de quien rechazo. SIN REINTENTO, en ningun caso (ADR-001,
 * NFR-R03): si `core` no respondio, la escritura no ocurrio, y volver a intentar sin idempotencia
 * es como se crean dos requisitos donde tenia que haber uno.
 */

/** El nombre del comando. El SDK arma el subject completo a partir de esto. */
const COMMAND = 'requirements.new';

export interface PublishVerificationRequirementDeps {
  /** El cliente conectado. Uno por proceso, el de `connectToBus()`. */
  readonly client: Client;
  /** El proyecto de prueba, de `config.verifyProjectId`. */
  readonly projectId: number;
  readonly logger: Logger;
}

/**
 * Publica el requisito de verificacion y devuelve su `id`.
 *
 * Las dependencias llegan POR PARAMETRO y no por import de un singleton: es lo que permite
 * inyectar el logger de captura y el cliente de test sin tocar el estado del proceso — el mismo
 * criterio que `connectToBus()` de S-004.
 *
 * El logueo va en ESTA funcion y no en el entry point. Es lo que garantiza que la linea exista
 * independientemente de quien llame, y es lo que FG-3 hereda cuando el llamador pase a ser el tick
 * en vez del script.
 */
export async function publishVerificationRequirement({
  client,
  projectId,
  logger,
}: PublishVerificationRequirementDeps): Promise<{ requirementId: number }> {
  // El payload se valida ANTES de publicar, con `safeParse` adentro de `parseNewRequirement()`. Un
  // payload invalido NO se publica: publicarlo gastaria un round-trip para que `core` conteste
  // `invalid_fields` sobre algo que el conector ya sabia que estaba mal, y ensuciaria el
  // diagnostico (un rechazo de `core` por forma significa "el plano esta abierto", y aca no
  // probaria nada).
  const payload = parseNewRequirement(buildVerificationPayload(projectId));

  let data: unknown;

  try {
    // DOS ARGUMENTOS, no tres. El tercero (`options`) es donde se bajaria el timeout por accidente,
    // y ADR-006 lo prohibe explicitamente: el efectivo tiene que ser el del cliente (15000 ms,
    // con piso garantizado por el schema de S-002). Un timeout mas corto que el del servidor
    // convierte los errores explicados de PostgreSQL —que corta a los 8 s— en timeouts mudos. El
    // `options` se usa SOLO desde los tests, para no gastar 15 s de suite provocando un timeout.
    //
    // Y el SDK hace todo lo demas: arma el subject `{instance}.{userId}.jiku-commands.v1.
    // requirements.new`, arma y parsea el envelope, y fija el `inboxPrefix`. El conector NO hace
    // ninguna de las tres (ADR-002).
    //
    // `await` dentro del `try` y no un `return client.command(...)`: el error tiene que traducirse
    // DONDE OCURRE. Una promesa rechazada sin capturar sale por `unhandledRejection`, fuera de Pino
    // y por lo tanto SIN REDACCION — en un servicio cuyo unico borde es el log.
    data = await client.command(COMMAND, payload);
  } catch (cause) {
    // El diagnostico se calcula por CLASE del SDK y por CODIGO, nunca por el texto del mensaje.
    const error = new PublishError(diagnosePublishFailure(cause), cause);

    // Se loguea aca, con `error` (no `fatal`): que el modo de verificacion no pueda escribir no
    // hace que el proceso no pueda continuar — de hecho continua, cierra la conexion y sale con
    // codigo != 0. El contexto NO lleva el payload ni `title`/`description`.
    logger.error(error.logContext(projectId), 'fallo la publicacion de requirements.new');

    // Traduce y RELANZA, no traga. El modo de verificacion tiene que fallar con codigo de salida
    // distinto de cero: loguear y devolver un exito parcial haria que el script saliera con 0 y el
    // operador concluyera que el plano de escritura esta abierto cuando no lo esta.
    //
    // Y no hay reintento: ni `for`, ni `while`, ni backoff. Una sola invocacion de
    // `client.command()` por llamada a esta funcion.
    throw error;
  }

  // La respuesta SE VALIDA. `command<T>()` devuelve `reply.data` tal cual, sin comprobar que
  // coincida con `T` (verificado en el codigo del SDK): el generico es una asercion del llamador,
  // no una garantia. Un `core` que respondiera `{ status: 'success', data: {} }` produciria la
  // linea que CA-1 exige con `requirementId: undefined` —formalmente presente, materialmente
  // inutil— y sin que nada falle. Una respuesta de exito sin `id` usable es un FALLO.
  const reply = newRequirementReplySchema.safeParse(data);

  if (!reply.success) {
    const error = new PublishError('respuesta_ilegible', undefined);

    logger.error(error.logContext(projectId), 'fallo la publicacion de requirements.new');

    throw error;
  }

  // La linea de exito. `projectId` y `requirementId` van EN EL MISMO OBJETO porque CA-1 pide
  // explicitamente "en la misma linea": son los dos identificadores que permiten encontrar el
  // requisito en Jiku, y separados en dos lineas obligan a correlacionar por timestamp.
  //
  // Objeto de contexto primero, mensaje estatico segundo (convencion `logging`). Y solo
  // identificadores: nada de `title` ni `description`, que no estan en REDACT_PATHS.
  //
  // `messageId` NO va, y no es un olvido: la regla de ADR-006 nombra tres campos, pero en esta
  // story NO HAY MAIL — el trigger es un script con payload fijo. El `messageId` llega con FG-3,
  // que introduce el mail como origen del payload.
  logger.info(
    { projectId, requirementId: reply.data.id },
    'requisito creado en Jiku',
  );

  // El tipo de retorno nombra el campo en vez de devolver el `data` crudo: asi el `id` desnudo no
  // se propaga y nadie lo confunde con el id de otra cosa.
  return { requirementId: reply.data.id };
}
