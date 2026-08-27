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
 * archivo — exactamente el fallo diferido que esta story existe para evitar.
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
  });
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
