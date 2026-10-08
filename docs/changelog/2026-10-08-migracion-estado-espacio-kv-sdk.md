---
date: 2026-10-08
story: S-032
request: REQ-008
service: jiku-email-tickets
---

# S-032 — Migración del estado al Espacio KV del SDK

## Qué cambió

Todo el estado del conector —el Mapa de Tickets y el Mapa de Hilos— pasa del KV crudo de
`@nats-io/kv` (que entraba por el re-export del build 1.1.0 vendoreado) al **Espacio KV del SDK**:
`client.kv()`, el espacio por identidad dentro del bucket compartido `JIKU_KV`, con las claves bajo
el prefijo `{instance}.{userId}.` que agrega el SDK. El comportamiento observable no cambia, salvo
dos decisiones de la story: un motivo de descarte nuevo (`slug_no_consultable`) y que **los hilos
dejan de expirar**.

### El SDK: el build de `jiku-ts@edd1064`

- `vendor/gravadigital-jiku-1.0.0-edd1064.tgz` es el `npm pack` de `jiku-ts` en el commit `edd1064`
  (árbol limpio), con el commit en el nombre. `package.json` lo declara con `file:vendor/…` y el
  lockfile fija su integrity. `vendor/gravadigital-jiku-1.1.0.tgz` se borró.
- El build declara la versión `1.0.0`, igual que el paquete publicado que **no** tiene `client.kv()`,
  así que `npm ls` no los distingue: un test afirma sobre lo **instalado** que trae `client.kv()`,
  `KV_BUCKET`, `assertValidKVKey`, `kvKey` y las clases de error del KV, y que
  `@gravadigital/jiku/nats` **no** re-exporta `Kvm`.
- `@nats-io/kv` y `@nats-io/jetstream` salen del árbol; `@nats-io/nats-core` sigue en **una** copia.
  Ninguna dependencia directa nueva.
- El comentario *TEMPORAL* del `Dockerfile` nombra el build de `jiku-ts@edd1064` y la misma
  condición de vencimiento: cuando el SDK con el Espacio KV se publique, el rango vuelve al registry
  y `vendor/` se borra con sus tres copias.

### El módulo `src/infra/kv/`

| Antes | Después |
|---|---|
| `stores.ts`: `openKvStores()` con `new Kvm(client.connection)`, dos buckets y `warnOnTtlMismatch()` | **`space.ts`**: `openKvSpace({ client, logger })`, `client.kv()` **una vez** (el único lugar de `src/`), línea `info` `'espacio KV abierto'` con `bucket` y `kvPrefix` |
| `ticket-map.ts`: `startTicketMapWatch()`, carga inicial, `watch()`, reintento y copia en memoria | **`tickets.ts`**: `lookupTicket({ space, slug, logger })`, **un** `get` por mail nuevo, un intento, sin caché, que **nunca lanza** y devuelve tres estados |
| `threads.ts` sobre el `KV` de `@nats-io/kv` | El mismo archivo y las mismas reglas, sobre el espacio: clave `hilos.<sha256>`, `undefined` como "no está", y `errorClass` en el `warn` del write fallido |
| `errors.ts`: `KvBucketMissingError`, diagnóstico por `name` y `code` (`10059`) | **`KvSpaceUnavailableError`** (`KV_SPACE_UNAVAILABLE_ERROR`), diagnóstico por **`instanceof`** contra `JikuNoBucket` y `JikuKVPermissionDenied`: `bucket_no_usable`, `kv_sin_permisos`, `desconocido` |
| — | **`keys.ts`**: `ticketKey()`, `threadKey()`, `isStorableSlug()` (sobre `assertValidKVKey()` del SDK), los prefijos fijos `tickets.` y `hilos.`, y `sha256hex()`, que se muda desde `threads.ts` |

El handle se tipa **`KvSpace = Pick<KV, 'get' | 'put'>`**: el `KV` del SDK es una clase con campos
privados (TypeScript la trata nominalmente y un doble de test no le es asignable), y el `Pick` deja
`delete()` fuera del alcance del conector en tiempo de compilación.

### El ruteo y el tick

- `routeMail()` sigue pura y sincrónica, pero ya no resuelve el proyecto: devuelve
  `{ ok: false, intencion: 'alta', slug }`, la misma forma con la que REQ-005 sacó el lookup del
  hilo. `RuteoConfig` pierde `ticketMap`.
- El tick resuelve la intención con `lookupTicket()` **antes** de `procesarAdjuntosDelMail()`: un
  mail que se descarta no sube ningún byte. `found` → alta; `consultable` → `slug_no_mapeado`;
  `!consultable` → **`slug_no_consultable`**, que suma en `descartados` (la línea del tick conserva
  sus seis contadores).
- `MotivoDescarte` gana `slug_no_consultable` (siete literales): *arreglar el KV* frente a *cargar el
  slug*. Un slug que no puede ser clave y una entrada con valor mal formado son `slug_no_mapeado`.

### El arranque y el apagado

- El Paso 5.5 es `openKvSpace()`, entre `connectToBus()` y `scheduleTick()`. El Paso 5.6 (el
  `watch()`) desaparece, y con él `stopTicketMapWatch` del apagado, de `index.ts` y de `verify.ts`.
- `reportStartupFailure()` conserva una rama propia para el KV, separada de la del bus: `fatal`
  `'el arranque fallo: el espacio KV no esta usable'` con contexto plano
  `{ code, diagnosis, bucket, subject?, errorClass, causes }`. Con `bucket_no_usable` el log no
  sugiere grants.
- `scripts/local-worker.mjs` abre el espacio con `openKvSpace()`.

### Lo que se borró

- `src/infra/kv/stores.ts` y `src/infra/kv/ticket-map.ts`.
- Las variables `KV_TICKETS_BUCKET`, `KV_THREADS_BUCKET`, `KV_THREADS_TTL_DAYS` y
  `KV_WATCH_RETRY_MS`, con sus defaults y mensajes; `AppConfig.kv` (`KvConfig`),
  `config.ruteo.ticketMap` y `withTicketMap()`. **Una variable vieja en el entorno se ignora**: no
  hace fallar el arranque. El README y el `.env.example` ya no las declaran y lo avisan.
- Los diagnósticos `bucket_inexistente`, `kv_no_disponible` y `nombre_de_bucket_invalido`, y la
  comparación del TTL.

## Hallazgos verificados al planificar

1. **El truncado a primera línea de `causes` perdía los grants.** El mensaje de
   `JikuKVPermissionDenied` es multilínea y los grants de `requiredKVPermissions()` vienen después de
   la primera línea. `KvSpaceUnavailableError.causes` lleva el **mensaje completo** de cada error de
   la cadena (sólo subjects y el placeholder `{{user_id}}`, nunca credenciales).
2. **Diferencia de API fuera del KV entre el 1.1.0 y `edd1064`:** `LoadedConfig.zitadel.issuer` pasó
   de `string` con default a **opcional y sin default**, y el SDK dejó de exportar `DEFAULT_ISSUER`.
   No cambia el comportamiento: `loadAppConfig()` ya caía a `JIKU_ISSUER`, cuyo default es el mismo
   valor, y el conector importa su propio `DEFAULT_ISSUER`.

## Lo que el conector NO hace con el espacio, afirmado por tests que escanean `src/`

No importa `Kvm`, `@nats-io/kv`, `@nats-io/jetstream` ni `nats`; llama a `client.kv()` en un solo
lugar; no llama a `delete()`; no usa `watch`, ni `ttl`, ni lee `entry.created` (una entrada de
cualquier antigüedad matchea); no crea buckets; no guarda el resultado de `lookupTicket()`; no fija
un timeout propio. Y la consulta del slug va después del `\Seen` y antes de los adjuntos.

## Tests

- Nuevos: `test/infra/kv/{keys,space,tickets}.test.ts` y `test/ingesta/tick-mapa-tickets.test.ts`.
- El helper `test/infra/kv/helpers.ts` crea `KV_JIKU_KV` con `$JS.API.STREAM.CREATE.KV_JIKU_KV` y
  `allow_direct: true`, como el SDK en su test de integración, y es el **único** lugar del repo que
  crea un bucket. Un espacio fresco por identidad reemplaza al bucket por test.
- `test/ingesta/fake-kv-space.ts` reemplaza a `fake-threads-kv.ts`, y `test/infra/kv/space-doubles.ts`
  reúne las envolturas `spyOnSpace`, `withFailingGet` y `withFailingPut`.
- Se borraron, con su código, los tests del `watch()` y la copia en memoria
  (`ticket-map.test.ts`, `e2e-watch-tick.test.ts`), de los dos buckets (`stores.test.ts`) y del TTL;
  el Story Plan los inventaría uno por uno. Ningún test de un comportamiento que se conserva se
  borró ni se debilitó: `test/bus/source-properties.test.ts` y `test/ingesta/tick-memory.test.ts`
  no se modificaron.

**Fuera de alcance:** el E2E del espacio real y la documentación de operación (S-033); los ADRs, los
flujos y el PRD (S-034).
