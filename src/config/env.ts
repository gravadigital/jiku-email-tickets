import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

import { toConfigValidationError } from '#config/errors.js';
import { envSchema, type Env } from '#config/schema.js';

/**
 * La regla cross-field del Mapa de Tickets: EXACTAMENTE UNA de las dos fuentes.
 *
 * Vive aca y no en el schema por una razon concreta y verificada, que es la parte contraintuitiva
 * de todo el modulo: `z.object(shape).superRefine(...)` —y `.check(...)`— NO corren si alguna clave
 * del objeto ya fallo, porque Zod corta ahi. Escrita de la forma obvia, la regla desaparece en
 * silencio en el caso que mas importa: un despliegue al que le falta IMAP_HOST y ademas no declaro
 * el mapa informaria solo lo primero, y el operador arreglaria una cosa para descubrir la otra en la
 * corrida siguiente. Eso es exactamente lo que CA-3 prohibe.
 *
 * Por eso el schema final es un Standard Schema propio que corre el objeto y la regla por separado
 * y CONCATENA las dos listas de issues, sin cortar nunca.
 */
function ticketMapSourceIssues(value: Record<string, unknown>): { message: string; path: string[] }[] {
  const inline = value.TICKET_MAP !== undefined && value.TICKET_MAP !== '';
  const file = value.TICKET_MAP_FILE !== undefined && value.TICKET_MAP_FILE !== '';

  // Los dos issues van al path de TICKET_MAP y no al de TICKET_MAP_FILE a proposito:
  // `variableNameOf()` en errors.ts toma `issue.path[0]` y lo busca en EXPECTATIONS, y es la entrada
  // de TICKET_MAP la que explica la regla de las dos fuentes. Un operador que declaro las dos tiene
  // que leer esa entrada, no una que solo describa un formato.
  if (!inline && !file) {
    return [{ message: 'el Mapa de Tickets es requerido', path: ['TICKET_MAP'] }];
  }
  if (inline && file) {
    return [{ message: 'se declararon las dos fuentes del Mapa de Tickets', path: ['TICKET_MAP'] }];
  }
  return [];
}

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

    // Con `createFinalSchema` declarado, la libreria deja de usar `parseWithDictionary()` y delega
    // la validacion entera en este schema. Eso obliga a reponer aca lo que aquella funcion hacia:
    // acumular los issues de TODAS las claves antes de reportar, con la clave como primer segmento
    // del path. `z.object()` ya hace las dos cosas, asi que alcanza con no cortar despues.
    createFinalSchema: (shape) => {
      const object = z.object(shape);

      return {
        '~standard': {
          version: 1,
          vendor: 'jiku-mail-connector',
          validate: (value: unknown) => {
            const input = (value ?? {}) as Record<string, unknown>;
            const parsed = object.safeParse(input);

            const issues = parsed.success
              ? []
              : parsed.error.issues.map((i) => ({ message: i.message, path: [...i.path] }));

            // La regla corre SIEMPRE, haya fallado o no una clave. Ese "siempre" es literalmente
            // CA-3: con un superRefine de Zod esta linea no se ejecutaria cuando mas hace falta.
            issues.push(...ticketMapSourceIssues(input));

            if (issues.length > 0) return { issues };

            // Inalcanzable con issues vacios: si `parsed` hubiera fallado, sus issues estarian en la
            // lista y ya habriamos vuelto arriba. El chequeo existe para que el tipo del resultado
            // sea el del schema y no una union con undefined, que rompe StandardSchemaV1.
            if (!parsed.success) return { issues: [{ message: 'configuracion invalida', path: [] }] };
            return { value: parsed.data };
          },
        },
      };
    },

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
