---
date: 2026-09-08
story: S-024
request: REQ-005
service: jiku-mail-connector
---

# S-024 — Apertura de los dos buckets KV sobre la conexión única

## Qué cambió

El conector abre y **verifica** dos buckets KV de NATS al arrancar, sobre la conexión que ya tiene.
Es el primer paso de REQ-005: deja el estado disponible para que S-025 mude el Mapa de Tickets al KV
y S-026 agregue el Mapa de Hilos.

### Módulo nuevo: `src/infra/kv/`

- **`stores.ts`** — `openKvStores({ client, config, logger })`: construye el `Kvm` sobre
  `client.connection`, abre los dos buckets con `open()`, **verifica que existen con `status()`**,
  compara el TTL del bucket de hilos, y devuelve los dos handles.
- **`errors.ts`** — `KvBucketMissingError` (con `diagnosis`, `bucket`, `operation`, `errorClass` y
  `causes` como **campos**, no sólo en el mensaje), `diagnoseKvFailure()` con clasificación
  **estructural**, y `isValidBucketName()`.
- **`index.ts`** — la superficie pública. **No exporta nada que permita crear un bucket**, y eso es
  deliberado: no tener el verbo a mano es parte de que la decisión se sostenga.

### Cableado en el arranque

`runStartup()` gana el paso 5.5 (`openKvStores()`), **después** de conectar al bus y **antes** de que
el llamador schedule el tick. `Startup` gana `kv: KvStores`. `reportStartupFailure()` gana una rama
propia para `KvBucketMissingError` que sale por `logger.fatal` con un mensaje que **no** dice que
falló la conexión al bus — porque no falló.

### Configuración: cuatro claves nuevas

`KV_TICKETS_BUCKET` (default `TICKETS`), `KV_THREADS_BUCKET` (default `MAIL_THREADS`),
`KV_THREADS_TTL_DAYS` (default `90`, en **días**) y `KV_WATCH_RETRY_MS` (default `30000`, lo consume
S-025). Las cuatro son independientes: **ninguna** toca `createFinalSchema` ni agrega una regla
cross-field. `AppConfig` pasa de catorce a quince campos de primer nivel con el bloque `kv`.

Nada se eliminó todavía: `TICKET_MAP` y `TICKET_MAP_FILE` siguen ahí y se van en S-025.

## Hallazgos verificados que cambiaron el diseño

Dos de ellos **contradicen** lo que la story asumía, y quedaron registrados en el Paso 5.5 del flujo
de arranque además de en los comentarios del código:

1. **`open()` NO verifica que el bucket exista.** Su docstring —*"will fail on accessing the KV"*—
   se lee como "`open()` lanza", pero fija `bindOnly: true` y delega en `Bucket.bind()`, que
   **nunca llama a `streams.info`**. Resuelve feliz para un bucket inexistente. **La verificación es
   `status()`**, y sin ella el conector arrancaría contra un despliegue sin buckets y descartaría
   todos los mails en silencio — el modo de falla exacto que la story existe para cerrar.
2. **`status().ttl` viene en milisegundos**, y `0` significa "sin TTL". La configuración está en
   días, así que la comparación convierte explícitamente.
3. **Las clases de error del KV no son importables** desde el subpath del SDK, así que `instanceof`
   es imposible: la clasificación es por `name` y por `code` (`10059`), nunca por el texto del
   mensaje. El propio `Kvm.create()` de la librería compara `err.message === "stream not found"`,
   que es el bug que este módulo no replica.
4. **"Sin permisos de KV" es indistinguible de "JetStream deshabilitado"** desde el cliente: la
   violación de permisos llega como un `-ERR` asincrónico y la request se envuelve igual. Un solo
   diagnóstico `kv_no_disponible` cubre ambos, y su remedio nombra **las dos** cosas a revisar.

## Lo que el conector NO hace, y está afirmado por tests que escanean `src/`

- **No crea buckets.** Los crea el operador (`nats kv add`). Crearlos ante un typo dejaría un bucket
  vacío en silencio, con el mismo síntoma indiagnosticable de arriba.
- **No fija el TTL.** Lo compara y avisa con un `warn`; arranca igual si difiere.
- **No abre una segunda conexión.** El `Kvm` va sobre `client.connection` (ADR-002 intacta).

## Resolución del rango del SDK

`test/manifest.test.ts` estaba **en rojo en `dev` antes de esta story**: esperaba `^1.0.0` y
encontraba el tarball local que S-023 vendorizó. Resuelto así:

- El caso acepta **las dos** formas —un rango `^1.x` del registry o el `file:` del tarball— con el
  comentario que dice por qué el `file:` es transitorio. **No** se borró ni se convirtió en un
  `expect(true)`.
- Se **agregó** un caso que afirma sobre el SDK **instalado**: versión `>= 1.1.0` y
  `@nats-io/kv` pinneado exacto en `3.4.0`. Aceptar el `file:` sin verificar qué resolvió dejaría
  pasar un tarball viejo, y el síntoma sería un `Kvm` undefined en el arranque.

**Pendiente para cuando el minor 1.1.0 del SDK esté publicado:** volver el rango a `^1.1.0`,
eliminar `vendor/` y las tres copias del `Dockerfile` que lo acompañan.

### El `Dockerfile` estaba roto por el vendorizado, y se arregló

Verificado corriendo `docker build`: el `npm ci` de la etapa `test` fallaba con `ENOENT` sobre el
`.tgz`, porque las tres etapas copian `package*.json` **antes** de `COPY . .` y el tarball no
viajaba. Las tres etapas ahora copian `vendor/` junto al manifest, con la nota de que es temporal.
La imagen vuelve a construir, y se verificó que lleva el SDK `1.1.0` con `Kvm` resolvible.

## Tests

- **`test/infra/kv/errors.test.ts`** (17) — la clasificación en sus cuatro ramas y la forma del
  error. El caso más importante es el que verifica que un `Error` con el mensaje `'stream not found'`
  pero **sin** `name` ni `code` da `'desconocido'`: es el que protege la decisión de no leer prosa.
- **`test/infra/kv/stores.test.ts`** (9) — contra un **NATS real con JetStream**, incluidos los tres
  casos de bucket faltante (y que el error nombre el **correcto** cuando faltan los dos), las tres
  ramas del TTL y el nombre inválido. El escenario "JetStream deshabilitado" usa el contenedor
  compartido, que por no tener `-js` es el doble perfecto y gratis.
- **`test/infra/kv/startup-wiring.test.ts`** (7) — la rama nueva de `reportStartupFailure()` y que
  las tres preexistentes no cambiaron de comportamiento.
- **`test/infra/kv/source-properties.test.ts`** (6) — las propiedades de "no existe ningún camino de
  código que…". Se verificó que **muerden**: introduciendo un `create()` y un `ttl:` a propósito,
  los dos casos fallan.
- **`test/infra/kv/helpers.ts`** — infraestructura nueva: un contenedor NATS con `-js` por archivo
  de test, con su sembrador de buckets. El compartido no tiene JetStream y el camino feliz es
  inexpresable contra él; no se le agrega `-js` porque los buckets sembrados por un archivo serían
  visibles a los demás.

**Suite completa en verde: 69 archivos, 938 tests.**
