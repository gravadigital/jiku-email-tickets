// El KV entra SOLO por el subpath del SDK, nunca de `@nats-io/kv` ni de `nats` (ADR-002 / S-023):
// garantiza UNA SOLA copia de `nats-core` en el arbol, sin la cual un `instanceof` contra una clase
// de error del SDK falla contra la copia que lo lanzo. Hay un test de propiedad que escanea todo
// `src/infra/kv/` para afirmarlo, y este archivo cae dentro de su alcance.
import type { KV, KvWatchEntry, QueuedIterator } from '@gravadigital/jiku/nats';
import type { Logger } from 'pino';

import type { AppConfig } from '#config/index.js';

/**
 * El Mapa de Tickets seguido con `watch()` sobre una copia en memoria.
 *
 * El modulo no lee `process.env` y no llama a `getLogger()`: la configuracion y el logger llegan
 * por parametro, igual que `openKvStores()` y `connectToBus()`. Eso es lo que permite que los tests
 * le inyecten un logger de captura sin tocar el singleton del proceso.
 *
 * NO construye ningun `Kvm`, NO abre ninguna conexion, NO llama a `create()` ni a `put()`: el
 * `watch()` va sobre el handle que `openKvStores()` ya abrio y verifico sobre la conexion UNICA del
 * proceso (ADR-002).
 *
 * ============================================================================================
 * LOS CINCO HALLAZGOS QUE HACEN QUE ESTO FUNCIONE. Se verificaron EMPIRICAMENTE contra
 * `nats:2.11-alpine` con `-js` y `@nats-io/kv@3.4.0`; no se dedujeron de la documentacion. Cada
 * uno invalida una implementacion que parece obviamente correcta. NO los borres al "simplificar":
 * el proximo que toque el archivo los redescubre por la via dolorosa.
 * ============================================================================================
 *
 * HALLAZGO 1 — El fin de la carga inicial se detecta con `isUpdate`, y el ULTIMO entry inicial YA
 * lo trae en `true`.
 *
 * `watch()` emite primero las entradas existentes y despues las novedades. La marca es el campo
 * `isUpdate` de `KvWatchEntry`, y la libreria lo calcula asi (`lib/kv.js:728-738`):
 *
 *     const count = info.num_pending;
 *     let isUpdate = content === KvWatchInclude.UpdatesOnly || count === 0;
 *     let i = 0;
 *     ... if (!isUpdate) { i++; isUpdate = i >= count; }
 *
 * O sea que con 3 entradas se emite `false, false, true`: el tercero —el ultimo de la carga
 * inicial— ya viene en `true`. "La carga inicial termino" es *"ya vi la entrada con
 * `isUpdate: true`, INCLUYENDOLA"*. Por eso el orden de abajo es **aplicar primero, resolver
 * despues**: un `if (entry.isUpdate) resolver()` colocado antes de aplicar se saltearia la ultima
 * entrada de la carga inicial.
 *
 * HALLAZGO 2 — Un bucket VACIO no emite NUNCA ningun entry, asi que esperar un entry cuelga para
 * siempre.
 *
 * Es la trampa central del modulo. Con `count === 0`, `isUpdate` arranca en `true` (linea 729 de
 * arriba) pero **el callback no se invoca jamas**, porque no hay nada que entregar. Una espera
 * implementada como *"resolver cuando llegue el primer entry con `isUpdate: true`"* NO RESUELVE
 * NUNCA contra un bucket vacio, y `runStartup()` cuelga para siempre: el proceso queda vivo, sin
 * loguear nada, sin schedular el tick y sin morirse. **No hay sintoma** — el modo de falla exacto
 * que ADR-006 no puede diagnosticar. Y un bucket vacio es un estado VALIDO y esperado: es el
 * estado de todo despliegue nuevo, o sea el PRIMER ARRANQUE DE PRODUCCION.
 *
 * La solucion: `status().values` trae la cuenta de entradas ANTES de arrancar el watch. Con `0`, la
 * carga inicial esta completa por definicion y se resuelve de inmediato, sin esperar ningun entry.
 *
 * NO lo "simplifiques" a un `Promise.race` con un timeout: convertiria el bucket vacio en una
 * espera inutil de N ms en cada arranque y —peor— haria que un bucket grande sobre una red lenta
 * arranque con el mapa a medio llenar, que es exactamente lo que la espera existe para prohibir.
 *
 * HALLAZGO 3 — Cuando el watch se cae, el `for await` TERMINA NORMALMENTE; no lanza.
 *
 * En `lib/kv.js` el propio watch se arma con `iter.closed().then(() => { qi.push(() => qi.stop()) })`:
 * el `stop()` empuja un centinela que termina el `QueuedIterator` LIMPIAMENTE. O sea que un
 * `try { for await (...) } catch { reintentar() }` **NO detecta la caida mas comun**: el loop sale
 * por la puerta de adelante, la funcion `async` resuelve, y nadie reintenta nada — el mapa queda
 * congelado para siempre y en silencio.
 *
 * Por eso la deteccion va DESPUES del loop, en el camino normal, y el `catch` cubre solo el caso
 * adicional de que ademas lance.
 *
 * HALLAZGO 4 — Un `delete` llega como `operation: 'DEL'` y hay que BORRAR la clave de la copia.
 *
 * Aplicar toda entrada como un `set()` deja una clave borrada por el operador viviendo para siempre
 * en memoria: el operador saca un slug del bucket, ve que el comando funciono, y los mails de ese
 * slug SIGUEN RUTEANDO. `DEL` y `PURGE` hacen `delete` en el `Map`.
 *
 * Y el detalle que se pasa por alto: una entrada `DEL` tiene el `value` VACIO, asi que parsear su
 * valor antes de mirar `operation` produce un `NaN` y —con los `if` en el orden equivocado— un
 * `warn` de "valor invalido" por cada borrado legitimo. De ahi que el `operation` se mire PRIMERO.
 *
 * HALLAZGO 5 — El valor llega como bytes; `string()` lo decodifica y no valida nada.
 *
 * `entry.json<T>()` **LANZA** si el payload no es JSON parseable, asi que NO se usa: un valor
 * tipeado a mano por un operador con `nats kv put` no es JSON confiable, y una excepcion dentro del
 * loop de background mataria el watch entero por un dato malo de UNA sola clave.
 *
 * El parseo es propio, explicito y tolerante: `string()` -> entero positivo. Un valor no parseable
 * se saltea con un `warn` que NOMBRA LA CLAVE y no detiene el watch ni el arranque. El mapa mal
 * formado deja de ser un modo de falla del PROCESO; lo que queda es una ENTRADA mal formada, que
 * degrada a `slug_no_mapeado` para ese slug y nada mas.
 */

export interface StartTicketMapWatchOptions {
  /** El handle que `openKvStores()` ya abrio y verifico. NO se abre ninguna conexion nueva. */
  readonly tickets: KV;
  /** `ticketsBucket` para el contexto de log y `watchRetryMs` para el reintento. */
  readonly config: Pick<AppConfig, 'kv'>;
  readonly logger: Logger;
  /**
   * El alta del `watch()`, inyectable.
   *
   * Existe SOLO para los tests, y sigue el precedente del servicio (`imapFlowCtor` en
   * `infra/imap/client.ts`, `Normalize` en `tick.ts`, `cronScheduleFn` en `scheduler.ts`): permite
   * conservar el `QueuedIterator` y llamarle `stop()` para provocar la caida limpia del HALLAZGO 3
   * de forma determinista, sin mockear el paquete del KV a nivel de modulo.
   *
   * En produccion nadie lo pasa y el default —`tickets.watch()`— es el que corre.
   */
  readonly watchFn?: () => Promise<QueuedIterator<KvWatchEntry>>;
}

export interface TicketMapWatch {
  /**
   * La copia en memoria VIVA del Mapa de Tickets.
   *
   * Es **EL MISMO OBJETO** durante toda la vida del proceso: se muta con `set`/`delete` y NUNCA se
   * reemplaza por uno nuevo. Es lo que permite que `config.ruteo.ticketMap` sea una referencia fija
   * y vea las actualizaciones sin que nadie reasigne nada.
   *
   * Si alguna vez se reemplazara el `Map` en cada cambio, `config.ruteo.ticketMap` quedaria
   * apuntando al primero: el conector arrancaria bien, rutearia bien los slugs iniciales, y NUNCA
   * VERIA UNO NUEVO — el valor central de la story fallando EN SILENCIO. Es el bug mas probable de
   * todo este modulo, y hay un test que lo detecta (`the Map reference is STABLE`).
   *
   * El tipo es `ReadonlyMap` y no `Map`: no impide que el dueno lo mute —este modulo—, solo impide
   * que lo muten los consumidores, que es exactamente lo que se quiere.
   */
  readonly ticketMap: ReadonlyMap<string, number>;
  /** Detiene el watch y cancela cualquier reintento pendiente. Para el apagado ordenado y los tests. */
  readonly stop: () => void;
}

/**
 * Parsea el `projectId` de una entrada del bucket.
 *
 * `Number.parseInt` y NO `Number()` a secas: `Number('4.5')` da `4.5` y `Number('')` da `0`, asi
 * que la validacion posterior tendria que atrapar los dos casos igual, pero `parseInt` deja el
 * intento explicito. La validacion es la que decide: entero seguro y estrictamente positivo.
 *
 * `Number.isSafeInteger` y no `Number.isInteger`: un id que no sobrevive el ida y vuelta a `double`
 * no es un id, es un valor corrupto.
 *
 * Devuelve `undefined` para todo lo que no sea un `projectId` valido: el `0`, los negativos, los no
 * enteros, y cualquier cosa que no sea numerica. El llamador loguea y saltea.
 */
function parseProjectId(raw: string): number | undefined {
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;

  // `parseInt('4.5')` devuelve `4`, que es un entero positivo valido y pasaria el chequeo de
  // arriba. La comparacion contra el texto original es lo que rechaza `'4.5'`, `'42abc'` y `'0x2a'`:
  // un valor que no se re-serializa identico no era un entero, era otra cosa que empezaba con uno.
  if (String(parsed) !== raw.trim()) return undefined;

  return parsed;
}

/**
 * Da de alta el `watch()` del bucket de slugs, mantiene la copia en memoria, ESPERA la carga
 * inicial antes de devolver, y REINTENTA en background si el watch se cae.
 *
 * La espera de la carga inicial no es una comodidad: sin ella el primer tick podria correr con el
 * mapa a medio llenar y descartar como `slug_no_mapeado` mails que rutean bien — y esos mails ya
 * quedaron `\Seen`, o sea que se pierden.
 *
 * Leer los cinco HALLAZGOS de la cabecera del modulo ANTES de tocar el orden de este algoritmo.
 */
export async function startTicketMapWatch({
  tickets,
  config,
  logger,
  watchFn,
}: StartTicketMapWatchOptions): Promise<TicketMapWatch> {
  const bucket = config.kv.ticketsBucket;

  // EL MAPA SE CREA UNA SOLA VEZ, ACA, y no se reemplaza nunca mas. Ver el docstring de
  // `TicketMapWatch.ticketMap`.
  const ticketMap = new Map<string, number>();

  /** El iterador vivo, para poder detenerlo desde `stop()`. */
  let iterator: QueuedIterator<KvWatchEntry> | undefined;
  /** El `setTimeout` del reintento en vuelo, para poder cancelarlo desde `stop()`. */
  let retryTimer: NodeJS.Timeout | undefined;
  /** Un solo watch y un solo reintento a la vez: `stop()` lo baja y ningun reintento vuelve. */
  let running = true;

  const openWatch = watchFn ?? ((): Promise<QueuedIterator<KvWatchEntry>> => tickets.watch());

  /**
   * Aplica una entrada del watch a la copia en memoria.
   *
   * El orden de los `if` es parte del contrato, no estilo: el `operation` se mira ANTES de tocar el
   * valor (HALLAZGO 4), porque una entrada `DEL` viene con el valor vacio.
   *
   * NUNCA lanza. Una excepcion aca mataria el loop de background —y con el, el watch entero— por un
   * dato malo de una sola clave (HALLAZGO 5).
   */
  function applyEntry(entry: KvWatchEntry): void {
    // La normalizacion a minusculas va en las DOS puntas del mapa: aca al poblarlo, y en
    // `routeMail()` al buscar. Un `nats kv put TICKETS ALFA 42` tiene que rutear un mail a
    // `tickets+alfa@`.
    const slug = entry.key.trim().toLowerCase();

    if (entry.operation === 'DEL' || entry.operation === 'PURGE') {
      ticketMap.delete(slug);
      return;
    }

    const projectId = parseProjectId(entry.string());

    if (projectId === undefined) {
      // Contexto PLANO de un nivel (convencion `logging`): la redaccion de Pino no tiene comodin
      // profundo, asi que un contexto anidado podria dejar un valor sin redactar sin avisar.
      //
      // El `slug` VIAJA en el contexto a proposito, y no se redacta: es exactamente el dato que
      // ADR-006 exige para que el problema sea accionable. El VALOR crudo, en cambio, NO viaja —
      // no aporta al arreglo y no hay razon para volcar contenido del bucket al log.
      logger.warn(
        { slug, bucket },
        'una entrada del Mapa de Tickets tiene un projectId invalido y se saltea',
      );
      return;
    }

    ticketMap.set(slug, projectId);
  }

  /**
   * Consume el iterador hasta que se agote, y programa el reintento.
   *
   * `resolveInitialLoad` se invoca cuando la carga inicial termino de APLICARSE (HALLAZGO 1).
   * Puede ser `undefined` en un reintento: ahi ya nadie espera.
   */
  async function consume(
    iter: QueuedIterator<KvWatchEntry>,
    resolveInitialLoad: (() => void) | undefined,
  ): Promise<void> {
    let initialLoadDone = resolveInitialLoad === undefined;

    try {
      for await (const entry of iter) {
        if (!running) break;

        // APLICAR PRIMERO. El ultimo entry de la carga inicial ya viene con `isUpdate: true`
        // (HALLAZGO 1): resolver antes de aplicarlo se saltearia esa entrada, y el primer tick
        // correria con el mapa incompleto.
        applyEntry(entry);

        if (!initialLoadDone && entry.isUpdate) {
          initialLoadDone = true;
          resolveInitialLoad?.();
        }
      }
    } catch (error) {
      // El `catch` es el caso ADICIONAL, no el principal: la caida que ocurre de verdad sale por la
      // puerta de adelante (HALLAZGO 3) y cae en el codigo de abajo. Este `catch` solo evita un
      // rechazo no manejado si ademas lanza.
      if (running) {
        logger.warn(
          { bucket, reason: error instanceof Error ? error.message : String(error) },
          'el watch del Mapa de Tickets lanzo; se conserva el mapa en memoria y se reintenta',
        );
      }
    }

    // Si el iterador se agoto ANTES de que la carga inicial terminara —un bucket que desaparece a
    // mitad del arranque, por ejemplo— hay que resolver igual: dejar la promesa colgada colgaria
    // `runStartup()` para siempre, que es el modo de falla sin sintoma del HALLAZGO 2 por otra
    // puerta. El mapa queda como quedo, y el reintento de abajo se encarga.
    if (!initialLoadDone) {
      initialLoadDone = true;
      resolveInitialLoad?.();
    }

    if (!running) return;

    // ==== LA DETECCION DE LA CAIDA (HALLAZGO 3) ====
    //
    // Va ACA, en el camino NORMAL de salida del loop, y no solo en el `catch`: cuando el watch se
    // cae de verdad el `for await` termina limpiamente. Un modulo que solo tuviera el `catch` no
    // emitiria ningun `warn`, no reintentaria nada, y el mapa quedaria congelado para siempre en
    // silencio.
    //
    // El `warn` es el UNICO sintoma disponible de esto (ADR-006: no hay healthcheck ni metricas).
    // Contexto plano, mensaje estatico.
    logger.warn(
      { bucket, retryMs: config.kv.watchRetryMs },
      'el watch del Mapa de Tickets se cayo; se conserva el mapa en memoria y se reintenta',
    );

    // NUNCA `ticketMap.clear()`. Ni aca ni al reintentar: el ruteo tiene que seguir funcionando con
    // los slugs conocidos mientras el watch esta caido. La degradacion es a `slug_no_mapeado` para
    // los slugs agregados durante el corte, que es la falla SEGURA y nombra el slug buscado.
    //
    // CONSECUENCIA ACEPTADA Y DECLARADA: una clave BORRADA del bucket durante el corte queda en la
    // copia hasta el proximo `DEL` que se observe. Es coherente con que el mapa congelado degrade
    // seguro, y esta anotado para que no se descubra despues.
    scheduleRetry();
  }

  /** Programa UN solo reintento. Si ya hay uno en vuelo, no apila otro. */
  function scheduleRetry(): void {
    if (!running || retryTimer !== undefined) return;

    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (!running) return;
      // Deliberadamente sin `await`: es el mismo fire-and-forget del loop de arranque, y por la
      // misma razon.
      void attach(undefined);
    }, config.kv.watchRetryMs);

    // `unref()` para que un reintento pendiente no mantenga el proceso vivo por si solo. El apagado
    // ordenado llama a `stop()` de todas formas; esto es el cinturon adicional.
    retryTimer.unref();
  }

  /**
   * Da de alta el watch y arranca su loop de consumo.
   *
   * El ALTA se `await`ea —para que un fallo del `watch()` mismo se propague— pero el LOOP DE
   * CONSUMO **NO**, y esa asimetria es la parte estructural del modulo:
   *
   * - Un `await` sobre el loop **colgaria para siempre**. El iterador de un watch vivo no se agota
   *   nunca, asi que la promesa de `consume()` no resuelve mientras el watch funciona. Es el mismo
   *   modo de falla sin sintoma del HALLAZGO 2, por otra puerta.
   * - Por eso el loop va con `void` y es la EXCEPCION AUTORIZADA a la regla `_base` de "ninguna
   *   promesa sin `await` en un flujo critico". Sin este comentario, el proximo lector "arregla" el
   *   `void` y rompe el arranque entero sin que ningun tipo se queje.
   *
   * Lo que sostiene la espera de la carga inicial no es este `await`, es la promesa
   * `resolveInitialLoad` que el loop resuelve desde adentro.
   *
   * Al reintentar NO se vacia el mapa: con `include` en su default (`LastValue`) el watch nuevo
   * trae el ultimo valor de CADA clave, asi que la copia converge repoblandose encima. Ver la
   * consecuencia aceptada arriba.
   */
  async function attach(resolveInitialLoad: (() => void) | undefined): Promise<void> {
    let iter: QueuedIterator<KvWatchEntry>;

    try {
      // Sin opciones, y cada una de las que NO se pasan es una decision:
      //
      // - `include`: queda en su default (`LastValue`). `AllHistory` traeria todas las revisiones
      //   viejas de cada clave —trabajo y memoria por nada—, y `UpdatesOnly` se saltearia la carga
      //   inicial ENTERA, que es justo lo que la espera de abajo existe para garantizar.
      // - `ignoreDeletes`: NO usarla. Filtraria las entradas `DEL` del iterador, y entonces un slug
      //   borrado por el operador quedaria vivo en la copia para siempre (HALLAZGO 4).
      // - `resumeFromRevision`: seria la forma "elegante" de reanudar sin releer todo. Exigiria
      //   mantener la revision vista, y un reintento con carga inicial completa es correcto, barato
      //   (decenas de entradas) y mucho mas simple de razonar. Mejora futura anotada, no deuda.
      iter = await openWatch();
    } catch (error) {
      // El alta misma fallo (el servidor no responde, el bucket dejo de estar usable). En el
      // ARRANQUE esto se propaga —el llamador tiene que enterarse, y `reportStartupFailure()` lo
      // reporta—, pero en un REINTENTO no hay nadie a quien propagarselo: se loguea y se vuelve a
      // intentar.
      if (resolveInitialLoad !== undefined) throw error;
      if (!running) return;

      logger.warn(
        { bucket, reason: error instanceof Error ? error.message : String(error) },
        'el reintento del watch del Mapa de Tickets fallo; se vuelve a reintentar',
      );
      scheduleRetry();
      return;
    }

    iterator = iter;

    // FIRE-AND-FORGET a proposito. Ver el docstring de esta funcion antes de "arreglarlo".
    // `consume()` nunca lanza: atrapa todo por dentro, asi que este `void` no puede dejar un
    // rechazo sin manejar.
    void consume(iter, resolveInitialLoad);
  }

  // ==== PASO 1: DIMENSIONAR LA CARGA INICIAL ANTES DE ARRANCAR EL WATCH (HALLAZGO 2) ====
  //
  // `openKvStores()` YA llamo a `status()` para verificar el bucket, pero no propaga el resultado.
  // Se pide de nuevo aca: un round-trip adicional, UNA SOLA VEZ, en el arranque, sobre una conexion
  // ya abierta y ya autorizada. El costo es despreciable y el acoplamiento es cero.
  //
  // La alternativa —que `openKvStores()` propague el `KvStatus` en su retorno— queda ANOTADA como
  // opcion: ensancharia su superficie publica y obligaria a tocar sus tests de propiedad en una
  // story que no lo necesita.
  const status = await tickets.status();
  const initialCount = status.values;

  if (initialCount === 0) {
    // Con el bucket vacio la carga inicial esta COMPLETA POR DEFINICION y no hay nada que esperar:
    // el watch no va a emitir ningun entry (HALLAZGO 2). El watch se da de alta igual —hace falta
    // para las novedades— y su alta SI se espera, para que un `watch()` que falla lo haga en el
    // arranque; lo que no se espera (y no se puede esperar) es su loop.
    //
    // Un mapa vacio es un estado VALIDO: el conector arranca normalmente y descarta todo mail como
    // `slug_no_mapeado` con su log. Es el estado de todo despliegue nuevo.
    await attach(undefined);
    logger.info({ bucket, entradas: 0 }, 'watch del Mapa de Tickets activo; el bucket esta vacio');
    return { ticketMap, stop };
  }

  // Con entradas, se espera a que la carga inicial se APLIQUE completa. La promesa la resuelve el
  // loop desde adentro, al aplicar la entrada con `isUpdate: true` (HALLAZGO 1).
  let resolveInitialLoad!: () => void;
  const initialLoad = new Promise<void>((resolve) => {
    resolveInitialLoad = resolve;
  });

  // El ALTA se espera: un `watch()` que falla tiene que fallar el arranque, donde
  // `reportStartupFailure()` lo reporta. El LOOP no — ver el docstring de `attach()`.
  await attach(resolveInitialLoad);
  await initialLoad;

  logger.info(
    { bucket, entradas: ticketMap.size },
    'watch del Mapa de Tickets activo con la carga inicial completa',
  );

  return { ticketMap, stop };

  /**
   * Detiene el loop y cancela cualquier reintento pendiente.
   *
   * `running = false` PRIMERO: es lo que impide que el `stop()` del iterador —que hace salir el
   * `for await` por la puerta normal— se interprete como una caida y programe un reintento.
   */
  function stop(): void {
    running = false;

    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }

    iterator?.stop();
    iterator = undefined;
  }
}
