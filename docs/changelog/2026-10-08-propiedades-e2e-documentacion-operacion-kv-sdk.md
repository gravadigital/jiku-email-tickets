---
date: 2026-10-08
story: S-033
request: REQ-008
service: jiku-email-tickets
---

# S-033 — Propiedades del sistema, verificación E2E y documentación de operación del Espacio KV

## Qué cambió

**Ningún comportamiento nuevo, y ningún cambio en `src/`.** Esta story prueba contra un JetStream
real y sobre el `runTick()` cableado lo que S-032 sólo conservó, y reescribe la documentación de
**operación** del Espacio KV. Ningún test de propiedad ni E2E encontró un defecto de S-032.

### Lo que se verificó

- `test/infra/kv/e2e-operador.test.ts` (nuevo) — el **operador** escribe con la clave completa
  (`nats kv put/del JIKU_KV <instance>.<sub>.tickets.<slug>`), armada desde la **plantilla del README**
  y el `kvPrefix` leído de la línea `'espacio KV abierto'`, y el tick la ve desde el mail siguiente
  sin reabrir el espacio: alta, cambio, baja, clave en mayúsculas, valor malo. Y el **aislamiento**
  por instancia e identidad, mirado desde el **stream** (`lastSequences()`), no desde el SDK.
- `test/infra/kv/e2e-kv.test.ts` (extendido) — `JIKU_KV` **sin `allow_direct`**: `bucket_no_usable`,
  sin `subject` ni mención de grants en el texto del conector, y el bucket sigue sin arreglar.
- `test/infra/kv/e2e-permisos.test.ts` (nuevo) — un rol **sin los grants** del Espacio KV contra un
  `nats-server` con permisos estáticos: `kv_sin_permisos`, con el `subject` rechazado
  (`$JS.API.STREAM.INFO.KV_JIKU_KV`) y los tres grants en `causes`; el control con permisos
  completos; y un rol que abre el espacio pero no lee claves, que descarta en caliente como
  `slug_no_consultable` con `errorClass: 'JikuKVPermissionDenied'`.
- `test/ingesta/tick-propiedades-espacio.test.ts` (nuevo) — sobre el tick cableado: el hilo de 91
  días (y de 10 años) que comenta, la caída del KV con recuperación **sobre el mismo handle**, sin
  séptimo contador, el costo que no crece con 300 slugs cargados, los dos orígenes de
  `hilo_desconocido`, y la redacción sobre el log completo del proceso (arranque + ticks) con un
  valor crudo del KV sembrado a propósito.

Los tests de S-028 que ya cubrían redacción, contadores, idempotencia y dedup se **conservan sin
modificar** (sólo se corrigió un comentario de `tick-propiedades-kv.test.ts` que todavía nombraba la
expiración). `tick-memory.test.ts` y `test/bus/source-properties.test.ts` no se tocaron.

### Infraestructura de test nueva

- `test/infra/kv/operator.ts` — `operatorPut()` / `operatorDel()` / `operatorTicketKey()` y el parser
  de la plantilla del README. El único lugar que arma un subject `$KV.JIKU_KV.…` a mano, a propósito.
- `test/infra/kv/permission-helpers.ts` — la **tercera excepción autorizada** a "un contenedor por
  suite": un `nats:2.11-alpine` con usuarios con permisos estáticos.
- `test/infra/kv/helpers.ts` — `bucketConfig()`, `lastSequences()`, y `createBucket()` /
  `connectWithRetry()` exportados (el bucket se sigue creando en un solo lugar del repo).
- `test/infra/kv/space-doubles.ts` — `switchableSpace()` y `withEntryCreated()`.

## Documentación de operación

- **`README.md`:** la precondición 8 pasa a ser `JIKU_KV` del deploy de Jiku con `allow_direct` y
  sin TTL, más los tres grants de `internal-app` (que **no** crean ni U-02 ni el conector), con los
  tres `diagnosis` y su arreglo; los grants copiados de `requiredKVPermissions()` del SDK y las
  formas anchas que no se otorgan; el síntoma de un bucket con TTL. La sección del Mapa de Tickets
  documenta los tres comandos con la clave completa, de dónde sale `<instance>.<sub>.` (el
  `kvPrefix` del arranque), y la credencial de U-02 por su clase. Desaparecen los `nats kv add`, los
  dos buckets, el `--ttl=90d` y el `watch()`.
- **`.env.example`:** deja de explicar los dos buckets y el `watch()`; remite a la precondición 8.
- **`verificacion-e2e-manual.md`:** la Parte 2 rehecha (verificar `JIKU_KV` en vez de crear,
  sembrar/agregar/borrar con la clave completa, `nats kv get` de la entrada del hilo con el
  `messageIdHash`), el nuevo *Cierre de REQ-008*, y una nota en el cierre de REQ-005 sobre las filas
  que REQ-008 reemplazó. La precondición de la Parte 1 deja de nombrar los dos buckets y el
  `--ttl=90d` (lo exige el caso de precondiciones de `story-028-docs.test.ts`). La tabla de
  capabilities no se tocó (S-034).
- `test/story-033-docs.test.ts` ata la plantilla de clave documentada (README y Parte 2) a la que
  arma el código (`kvKey()` + `ticketKey()`/`threadKey()`), y los grants del README a los del SDK.
  `deployment-docs.test.ts` y `story-028-docs.test.ts` invirtieron sus casos de los dos buckets
  (`INVERTIDO EN S-033`).

## Hallazgos del plan, y su desenlace

- **Hallazgo 2 (el rechazo de permisos nunca se había probado contra un servidor real):** probado. Un
  `nats-server` real con permisos estáticos rechaza el `STREAM.INFO`, `nats-core` rechaza el request
  en vuelo, y el SDK lo entrega como `JikuKVPermissionDenied` con el subject. Lo mismo en caliente
  con el `DIRECT.GET`.
- **Hallazgo 3 (el mensaje del SDK para un bucket sin `allow_direct` contiene "grant"):** confirmado;
  la ausencia de grants se afirma sobre el texto del conector, el campo `subject` y el `diagnosis`,
  no sobre la línea serializada.
- **Hallazgo 4 (el rechazo podría llegar como timeout):** **no ocurrió**. No hizo falta `it.fails`
  ni hay nada que reportar a los dueños del SDK.
- **Hallazgo 8 (listar las claves desde el stream):** `STREAM.INFO` con `subjects_filter` devuelve
  `state.subjects` en `nats:2.11-alpine`; no hizo falta el fallback.

## Fuera de alcance: S-034

ADR-001/002/004/006, los cuatro flujos de `docs/flows/`, `overview.md`, el PRD y la tabla *"Contraste
de capabilities del PRD"* de `verificacion-e2e-manual.md` siguen describiendo los dos buckets y el
`watch()`: los reescribe S-034.

**Suite completa: 90 archivos, 1254 tests en verde** (`npm run test:teardown`).
