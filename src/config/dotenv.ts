import { config } from 'dotenv';

/**
 * La carga del archivo `.env`, con el unico caso en que NO debe ocurrir.
 *
 * POR QUE ESTE MODULO EXISTE. `import 'dotenv/config'` es un side-effect de tope de modulo: se
 * ejecuta al importarlo, antes que cualquier linea del entry point. Escrito asi en `index.ts` y
 * `verify.ts` —como estaba— el `.env` del desarrollador se cargaba TAMBIEN durante `npm test`, y
 * como `dotenv` no pisa lo que ya existe, terminaba rellenando huecos del entorno de cada caso: un
 * `LOG_LEVEL=debug` en el disco hacia fallar el caso que afirma que la linea de arranque sale en
 * `info`. La suite pasaba o no segun el contenido de un archivo NO VERSIONADO de la maquina que la
 * corre, que es la peor clase de test inestable: verde en CI, rojo en local, y el diff no explica
 * nada.
 *
 * LA REGLA. El `.env` NO se carga cuando `NODE_ENV=test`, NI cuando `DOTENV_DISABLED=true`. El
 * entorno de un test lo declara el test —los de este repo pasan objetos literales o un `env`
 * explicito al hijo— y nada del disco tiene por que completarlo.
 *
 * POR QUE DOS INTERRUPTORES Y NO SOLO NODE_ENV. Son dos preguntas distintas que se veian como una:
 * "que soy" (un test, un worker de produccion) y "cargo el archivo". `NODE_ENV` responde la
 * primera, y alcanza para la suite de vitest, que corre con `NODE_ENV=test`.
 *
 * No alcanza para los tests que lanzan el `dist/` como PROCESO HIJO y necesitan declararle un
 * NODE_ENV propio: el caso que afirma que la linea de arranque sale en JSON le pasa
 * `NODE_ENV=production` —porque eso es lo que esta probando, que solo `development` activa
 * pino-pretty— y con un solo interruptor eso REACTIVABA la carga del `.env`, que es justo lo que el
 * hijo no quiere. El sintoma era exacto y confuso: un `LOG_LEVEL=debug` en el `.env` del
 * desarrollador se colaba como `logLevel` de una linea que el caso esperaba en `info`.
 *
 * `DOTENV_DISABLED` responde la segunda pregunta sola, sin obligar a mentir sobre la primera.
 *
 * POR QUE UN MODULO Y NO DOS LINEAS EN CADA ENTRY POINT. Son dos (`index.ts` y `verify.ts`), y dos
 * copias de una condicion divergen: la que se olvidaria de actualizar es la de `verify.ts`, que
 * casi nunca se corre. Es el mismo argumento por el que `runStartup()` esta extraida.
 *
 * ESTA FUNCION NO VIOLA CA-1 (una sola lectura de `process.env` en todo `src/`, afirmada por
 * test/config/source-properties.test.ts). Lo que CA-1 protege es que la CONFIGURACION DEL SERVICIO
 * se lea en un unico lugar validado; esto no lee ninguna variable de configuracion, lee el
 * interruptor que decide si un archivo se carga, y ocurre ANTES de que exista configuracion alguna.
 * El escaner exceptua este archivo explicitamente y por nombre.
 */
export function loadDotenvUnlessTest(): void {
  if (process.env.NODE_ENV === 'test') return;

  // La comparacion es contra el literal 'true' y no un truthy: un `DOTENV_DISABLED=false` que
  // DESHABILITARA la carga seria el mismo error que POLL_ENABLED evita en el schema.
  if (process.env.DOTENV_DISABLED === 'true') return;

  // `config()` de la API programatica, y no el side-effect `import 'dotenv/config'`, porque es lo
  // unico que se puede poner detras de una condicion: un import de tope de modulo corre siempre,
  // que es exactamente el problema que este modulo resuelve. La llamada es SINCRONICA, asi que
  // cuando esta funcion retorna el entorno ya esta poblado y el entry point puede seguir.
  //
  // Busca `.env` en el cwd y NO PISA lo que ya este definido en el entorno real, que sigue ganando:
  // el mismo comportamiento que tenia `import 'dotenv/config'`.
  //
  // `quiet: true` NO es cosmetico. Desde dotenv v17 la carga imprime un banner
  // (`◇ injected env (N) from .env`) por stdout, y el side-effect `import 'dotenv/config'` que este
  // modulo reemplaza lo suprime solo. Sin esto, la PRIMERA LINEA de stdout del worker deja de ser
  // la linea de arranque en JSON y pasa a ser texto decorativo: rompe a quien parsee el stream
  // linea por linea —el recolector de logs del cluster, y los tests que afirman ese contrato— por
  // una salida que el servicio nunca decidio emitir. La observabilidad de este servicio es
  // EXCLUSIVAMENTE sus logs (ADR-006): nada mas escribe en sus streams.
  config({ quiet: true });
}
