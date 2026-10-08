import { KV_BUCKET, kvKey, type Client, type KV } from '@gravadigital/jiku';
import type { Logger } from 'pino';

import { KvSpaceUnavailableError, diagnoseKvFailure } from '#infra/kv/errors.js';

/**
 * La apertura del Espacio KV: el UNICO lugar de `src/` que llama a `client.kv()` (REQ-008, CA-3).
 *
 * =============================================================================================
 * LAS RAZONES DE ESTE MODULO. Un refactor bienintencionado borra cualquiera de ellas.
 * =============================================================================================
 *
 * UNA SOLA LLAMADA, Y EL HANDLE VIAJA POR PARAMETRO.
 *
 * El SDK cachea la promesa de `client.kv()` por cliente, asi que llamarlo en cada mail "funcionaria".
 * No se hace: el arranque tiene que fallar ACA si el espacio no esta usable (antes de schedular el
 * tick), y un `client.kv()` desperdigado por el codigo convertiria ese fallo de arranque en un fallo
 * en caliente de cada mail. Hay un test de propiedad que afirma que `.kv(` aparece una sola vez.
 *
 * VIAJA POR LA CONEXION UNICA.
 *
 * `client.kv()` usa `client.connection`: no abre ninguna conexion nueva (ADR-002, "`connect()`
 * exactamente una vez"). Por eso va DESPUES de `connectToBus()`.
 *
 * EL SDK VERIFICA EL BUCKET; EL CONECTOR NUNCA LO CREA.
 *
 * `client.kv()` hace el `$JS.API.STREAM.INFO.KV_JIKU_KV` y rechaza un bucket sin `allow_direct` (sin
 * el, los gets irian a un subject que el rol no tiene). Si el bucket no existe, el arreglo es del
 * deploy de Jiku: crearlo aca escondería un despliegue roto detras de un bucket vacio.
 *
 * `Pick<KV, 'get' | 'put'>` Y NO `KV`.
 *
 * El `KV` del SDK es una clase con campos privados ES y constructor privado: TypeScript la trata
 * NOMINALMENTE, asi que un doble de test no es asignable a `KV` sin un cast. Y el conector no borra
 * entradas (CA-17): con el `Pick`, `delete()` deja de ser invocable sobre el handle EN TIEMPO DE
 * COMPILACION, no solo por convencion.
 *
 * EL CAMPO DEL LOG NO SE LLAMA `key`.
 *
 * `REDACT_PATHS` (`#shared/log-redaction.js`) incluye `'key'` para cubrir la clave privada RSA del
 * machine user: un campo `key` saldria `[REDACTED]` en silencio. Es `kvPrefix`, y es el dato que el
 * operador copia para cargar un slug (`nats kv put JIKU_KV <kvPrefix>tickets.<slug> <projectId>`).
 */

/** El handle que viaja por parametro. Sin `delete()`: el conector no borra (CA-17). */
export type KvSpace = Pick<KV, 'get' | 'put'>;

export interface OpenKvSpaceOptions {
  readonly client: Client;
  readonly logger: Logger;
}

/**
 * Paso 5.5 del arranque: abre el espacio de la identidad del conector.
 *
 * Sin `timeoutMs` ni `signal`: rige el del cliente (15000 ms, ADR-002). Rechaza con
 * `KvSpaceUnavailableError` si el espacio no esta usable, y en ese caso no emite la linea `info`.
 */
export async function openKvSpace({ client, logger }: OpenKvSpaceOptions): Promise<KvSpace> {
  let space: KV;
  try {
    space = await client.kv();
  } catch (error) {
    throw new KvSpaceUnavailableError({ diagnosis: diagnoseKvFailure(error), cause: error });
  }

  // El prefijo sale de `kvKey()` del SDK, no de concatenar a mano: el del log no puede divergir del
  // que arma el SDK para las claves.
  logger.info(
    { bucket: KV_BUCKET, kvPrefix: kvKey(client.instance, client.userId, '') },
    'espacio KV abierto',
  );
  return space;
}
