import { ServiceUser } from '@gravadigital/jiku/node';

import type { AppConfig } from '#config/index.js';
import { KeyLoadError } from '#infra/bus/errors.js';

/**
 * La identidad del conector, construida desde la key del machine user.
 *
 * Es el Paso 3 del flujo de arranque. Su valor no esta en la linea que llama al SDK —esa es una—
 * sino en dos propiedades:
 *
 * 1. Los CUATRO fallos de la key producen un error legible que nombra la RUTA y jamas el
 *    CONTENIDO (CA-4).
 * 2. El `user-id` queda disponible DERIVADO DE LA KEY, cerrando la puerta a que alguien lo tome
 *    del entorno mas adelante (CA-2).
 *
 * Este modulo no lee `process.env` —`src/config/env.ts` es el unico lector del servicio— y no
 * llama a `getLogger()`: recibe la configuracion por parametro, igual que el logger de S-003. Eso
 * es lo que lo hace testeable sin tocar ningun singleton.
 */

/**
 * Construye la identidad del conector desde el archivo de key montado.
 *
 * `ServiceUser` valida la key EN EL CONSTRUCTOR, no de forma perezosa: lee el archivo, parsea el
 * JSON, verifica que traiga `key`/`keyId`/`userId`, y carga la private key con `createPrivateKey`.
 * De ahi que un solo `try` cubra los cuatro modos de fallo — no hace falta —ni serviria— separar
 * "fallos de lectura" de "fallos de forma": salen todos por esta misma llamada.
 *
 * Lo que NO hace, y es deliberado:
 *
 * - **No pasa `scopes`.** El default del SDK ya es `['openid', 'profile']`, y `profile` es
 *   OBLIGATORIO aunque parezca innecesario para un servicio: el auth-callout publica un evento de
 *   autenticacion que core convierte en la fila de `users`, y core EXIGE un nombre en ese evento.
 *   El nombre del machine user llega al callout por el endpoint de userinfo, que solo lo devuelve
 *   si se pidio `profile`. Un token minteado con `openid` solo produce un evento sin nombre, core
 *   lo descarta, la fila no se crea, y todo pedido posterior se rechaza con `caller_not_authorized`
 *   — un fallo silencioso que aparece TRES SERVICIOS mas alla de su causa. No lo "optimices" a
 *   `['openid']`: romperia CA-9.
 * - **No hace ninguna llamada de red.** `userId` y `subject()` salen de la key directamente. El
 *   token recien se pide al conectar.
 */
export async function buildServiceUser(config: AppConfig): Promise<ServiceUser> {
  try {
    return await ServiceUser.fromKeyFile(config.keyFile, {
      issuer: config.issuer,
      projectId: config.zitadelProjectId,
    });
  } catch (cause) {
    // El mensaje del SDK NO se interpola en el propio: se encadena por `cause`. Los mensajes del
    // SDK son buenos y hoy no filtran el contenido del archivo —verificado contra los cuatro modos
    // de fallo— pero encadenarlos en vez de interpolarlos es lo que mantiene la garantia de CA-4
    // ESTRUCTURAL, en lugar de depender de que una version futura siga comportandose bien.
    //
    // La ruta si va al mensaje: es el dato que el operador necesita para arreglar el montaje, y no
    // es el secreto. A `details` no va, porque `details` termina en el contexto del log y ahi una
    // ruta a un secreto es informacion sobre donde esta el secreto (ADR-006).
    throw new KeyLoadError(
      `No se pudo cargar la key del machine user desde ${config.keyFile}. Revisa que el archivo ` +
        'este montado, sea legible y sea el JSON que Zitadel genero para el machine user ' +
        '(no un PEM suelto).',
      undefined,
      { cause },
    );
  }
}
