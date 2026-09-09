import { createEnv } from '@t3-oss/env-core';

import { toConfigValidationError } from '#config/errors.js';
import { envSchema, type Env } from '#config/schema.js';

/**
 * Valida un entorno contra el schema y devuelve el objeto tipado.
 *
 * Recibe el entorno como parametro en vez de leer `process.env` por dentro porque la convencion
 * `testing` exige que los tests no dependan de las env vars del host: asi pasan objetos literales
 * y no hay mutacion del entorno global que se filtre entre archivos que comparten worker.
 *
 * `emptyStringAsUndefined` es necesario, no cosmetico: `JIKU_CREDS=` en un `.env` mal armado tiene
 * que contar como ausente. Sin esta opcion pasaria la validacion y fallaria mas tarde al abrir el
 * archivo — exactamente el fallo diferido que esta capa existe para evitar.
 *
 * ---
 *
 * # POR QUE NO HAY `createFinalSchema` (decision de S-025, verificada)
 *
 * Hasta S-025 este modulo declaraba un `createFinalSchema` propio, y existia por UNA sola razon: el
 * schema tenia una regla CROSS-FIELD —"el Mapa de Tickets declarado en exactamente una de sus dos
 * fuentes"— y esa regla NO puede vivir en el schema. La parte contraintuitiva, que sigue siendo
 * cierta y por eso queda anotada acá: **`z.object(shape).superRefine(...)` —y `.check(...)`— NO
 * corren si alguna clave del objeto ya fallo**, porque Zod corta ahi. Escrita de la forma obvia, una
 * regla cross-field desaparece EN SILENCIO justo en el caso que mas importa: un despliegue al que le
 * falta `IMAP_HOST` y ademas viola la regla informaria solo lo primero, y el operador arreglaria una
 * cosa para descubrir la otra en la corrida siguiente. El `createFinalSchema` existia para correr el
 * objeto y la regla por separado y CONCATENAR las dos listas de issues, sin cortar nunca.
 *
 * S-025 movio el Mapa de Tickets al bucket KV de slugs, y con el desaparecio **la unica regla
 * cross-field de todo el schema**. Sin regla, el envoltorio quedaba haciendo *"correr
 * `z.object(shape)` y devolver sus issues"*, que es EXACTAMENTE lo que `@t3-oss/env-core` hace por su
 * cuenta con `parseWithDictionary()` cuando `createFinalSchema` no esta declarado.
 *
 * Que quitarlo conserva las dos propiedades que importan se VERIFICO, no se supuso:
 *
 * 1. **Acumula los issues de TODAS las claves** en una sola invocacion de `onValidationError`, que
 *    es la propiedad de S-002 —el despliegue mal configurado se arregla en UNA pasada— y sigue
 *    afirmada por un test.
 * 2. **La forma del `path`** es la que `variableNameOf()` lee en `src/config/errors.ts`: la clave
 *    como primer segmento (`path: ['IMAP_HOST']`).
 *
 * **Si alguna vez hace falta OTRA regla cross-field**, esto es lo que hay que saber antes de
 * escribirla: no la pongas en un `superRefine` del objeto —se saltea cuando otra clave ya fallo— sino
 * en un `createFinalSchema` que corra las dos validaciones por separado y concatene sus issues. El
 * historial de este archivo tiene la implementacion que lo hacia.
 */
export function loadEnv(source: Record<string, string | undefined>): Env {
  return createEnv({
    server: envSchema,
    runtimeEnv: source,
    emptyStringAsUndefined: true,

    // El handler por defecto parte el reporte en un console.error con el array crudo de issues y un
    // Error generico sin ningun nombre adentro: no es "la lista completa en un solo mensaje" (CA-2)
    // y volcaria el issue entero (CA-10).
    onValidationError: (issues) => {
      throw toConfigValidationError(issues);
    },
  }) as Env;
}

/**
 * La UNICA lectura de process.env de todo el servicio (CA-1).
 *
 * Es una funcion y no una constante de modulo para que importar este archivo no dispare la
 * validacion: cuando arranca la validacion lo decide el arranque (src/index.ts), no el import.
 */
export function loadEnvFromProcess(): Env {
  return loadEnv(process.env);
}
