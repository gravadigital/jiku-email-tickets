# jiku-email-tickets — Overview

## Proposito

Worker que hace poll de la casilla IMAP de tickets, normaliza cada mail, lo rutea a un proyecto de
Jiku por el slug del subaddress, y publica los comandos de creacion de requisito y subida de
adjuntos al bus de Jiku. Sin persistencia propia: la idempotencia es el flag `\Seen` de IMAP.

## Tipo de servicio

worker en node

## Modulos del dominio

- **ingesta** — Poll IMAP con cap por tick y sin solapamiento, los mails mas nuevos primero.
  Normalizacion del mail (headers, cuerpo, adjuntos) a una forma interna. Marcado de `\Seen`.
  **Estado (S-011):** **implementado** de punta a punta — el poll (S-007), el adaptador IMAP
  (S-009), el tick con cap/orden/marcado/aislamiento de fallos (S-010), y el scheduler con el guard
  de no solapamiento y el apagado ordenado (S-011). El proceso schedula el tick con `cron.schedule()`
  segun `POLL_CRON` (o queda vivo sin schedular nada si `POLL_ENABLED=false`), nunca corre un tick
  inmediato al arrancar, saltea un disparo si hay uno en curso (con `warn`, sin encolar), libera su
  indicador de solapamiento **siempre** —incluso si el tick lanza—, y responde a `SIGTERM`/`SIGINT`
  esperando el tick en vuelo antes de cerrar el bus y salir con codigo `0`. Desde S-014/S-015, cada
  mail normalizado se rutea y publica dentro de la misma iteracion del tick — ver el modulo `ruteo`.
- **ruteo** — Extraccion del slug del subaddress y decision de la **intencion** del mail.
  `routeMail()` es pura: devuelve la **intencion de alta** con el slug en minusculas, la intencion de
  comentario, o el descarte `sin_slug`; ya no tiene el mapa. El tick resuelve el slug con
  `lookupTicket()` (`#infra/kv`) contra el Espacio KV, **un `get` por mail nuevo con slug**, sin copia
  en memoria ni cache; un slug no mapeado se descarta como `slug_no_mapeado` y una consulta fallida
  como `slug_no_consultable`, los dos con el slug en el log. *(S-034 / REQ-008: hasta S-032 el slug
  se resolvia contra una copia en memoria de un bucket propio, seguida con `watch()` desde S-025.)*
  **Estado (S-012 a S-016):**
  **implementado** de punta a punta — el arbol de decision puro de `routeMail()` (hoy: intencion de
  comentario → `sin_slug` → intencion de alta, S-027 y S-032; en S-013 era `es_respuesta` →
  `sin_slug` → `slug_no_mapeado` → resuelto), cableado en el tick junto con la publicacion
  (S-014), y con las propiedades del sistema completo afirmadas por tests (slug literal en el log
  redactado, ningun log filtra contenido de cliente, entry points limpios, pico de memoria de un mail
  a la vez — S-016). **S-032** saco la resolucion del slug de `routeMail()` y la llevo al tick con
  `lookupTicket()`, antes del procesamiento de adjuntos (subir archivos de un mail que despues se
  descarta los dejaria huerfanos). Documentado de punta a punta en
  [ruteo-y-alta-del-requisito](../../flows/ruteo-y-alta-del-requisito.md) (Paso 2 y Paso 2.5).
- **infra/kv** — El **Espacio KV** del conector dentro del bucket compartido `JIKU_KV` del bus, sobre
  la **conexion unica** del proceso (ADR-002): `client.kv()` viaja por `client.connection`, nunca por
  una conexion nueva. Guarda los dos mapas bajo prefijos fijos —constantes del codigo, no
  configuracion—: `tickets.<slug> → projectId` y `hilos.<sha256> → requirementId`. El conector maneja
  solo esa parte derecha de la clave; el prefijo `{instance}.{userId}.` lo agrega y lo quita el SDK
  (invariante 31). Seis archivos:

  - `space.ts` — `openKvSpace({ client, logger })`, la **unica** llamada a `client.kv()` de `src/`
    (un test de propiedad lo afirma). Devuelve `KvSpace = Pick<KV, 'get' | 'put'>`: sin `delete()`,
    el conector no borra. El SDK verifica `JIKU_KV` y su `allow_direct` con
    `$JS.API.STREAM.INFO.KV_JIKU_KV`; el conector **no crea el bucket**. Loguea `info`
    `'espacio KV abierto'` con `{ bucket, kvPrefix }` (el campo no se llama `key`: `REDACT_PATHS` lo
    redactaria).
  - `tickets.ts` — `lookupTicket({ space, slug, logger })`: un `get` por mail nuevo, un intento, sin
    cache, **nunca lanza**. Tres resultados: `found` con el `projectId`; no encontrado y consultable
    (nunca cargado, borrado, valor mal formado con `warn` que nombra el slug, o slug que no puede ser
    clave, sin round-trip); no consultable (el `get()` rechazo, con `warn` `{ slug, errorClass }`).
  - `keys.ts` — `TICKETS_KEY_PREFIX` / `THREADS_KEY_PREFIX`, `sha256hex()`, `ticketKey()`,
    `threadKey()` e `isStorableSlug()`, que delega en `assertValidKVKey()` del SDK (las reglas de
    clave de NATS, que rechazan `<`, `>` y `@`: por eso la clave del hilo es el sha256 del
    `Message-Id` **crudo**, sin normalizar). Es el unico lugar que arma claves.
  - `threads.ts` — `recordThreadEntry()` escribe la entrada despues del alta o del comentario con una
    falla **no cancelante** (`warn` con `errorClass`, `JikuBucketFull` incluido), y `lookupThread()`
    recorre los `referenceIds` **en orden** y **corta en el primer hit**. El `put()` va sin opciones:
    los hilos **no expiran** (invariante 32). Ninguna de las dos lanza, y **el KV NO participa de la
    idempotencia** —el `\Seen` sigue siendo la unica marca—.
  - `errors.ts` — `KvSpaceUnavailableError` (`KV_SPACE_UNAVAILABLE_ERROR`) y `diagnoseKvFailure()`,
    que diagnostica **por clase** del SDK (`instanceof`, nunca el mensaje): `JikuNoBucket` →
    `bucket_no_usable`, `JikuKVPermissionDenied` → `kv_sin_permisos`, todo lo demas → `desconocido`.
  - `parse.ts` — `parsePositiveId()`, el parseo del entero leido del KV, **compartido** por los dos
    mapas.

  **Estado (S-032 / S-033):** **implementado** por S-032 y **verificado** por S-033 contra un
  JetStream real —el slug que el operador carga con la clave completa del README rutea desde el mail
  siguiente, el aislamiento por instancia y por identidad, las tres causas de fallo del arranque, la
  caida del KV en caliente— y sobre `runTick()` cableado. Suites: `test/infra/kv/space.test.ts`,
  `test/infra/kv/tickets.test.ts`, `test/infra/kv/keys.test.ts`, `test/infra/kv/threads.test.ts`,
  `test/infra/kv/errors.test.ts`, `test/infra/kv/source-properties.test.ts`,
  `test/infra/kv/startup-wiring.test.ts`, `test/ingesta/tick-mapa-tickets.test.ts`,
  `test/infra/kv/e2e-operador.test.ts`, `test/infra/kv/e2e-kv.test.ts`,
  `test/infra/kv/e2e-permisos.test.ts` y `test/ingesta/tick-propiedades-espacio.test.ts` (mas las
  conservadas de REQ-005: `test/ingesta/tick-propiedades-kv.test.ts` y
  `test/infra/kv/preservacion-req-005.test.ts`). Documentado en el Paso 5.5 de
  [arranque-y-conexion-al-bus](../../flows/arranque-y-conexion-al-bus.md) y de punta a punta en
  [mapa-de-hilos-en-kv](../../flows/mapa-de-hilos-en-kv.md).

  *Historia (REQ-005, S-024 a S-028):* hasta S-032 el modulo abria dos buckets propios con el KV
  crudo de la libreria sobre la conexion, seguia el Mapa de Tickets con un `watch()` sobre una copia
  en memoria y los hilos tenian un TTL de 90 dias. REQ-008 reemplazo todo eso por el Espacio KV del
  SDK; el detalle queda en las stories S-024 a S-028 y en el catalogo de codigo reutilizable.
- **publicacion** — Los dos planos del bus que el conector toca, y desde S-029 son **dos**:
  **escritura** —los TRES comandos via el SDK: `files.request-upload`, `requirements.new` y —desde
  S-027— `requirements.{id}.comment`, mas el `PUT` del byte del adjunto a la URL prefirmada que
  devuelve `core`— y **lectura**: **su primer y unico consumo del plano de consultas**, la consulta
  `attachments.list` que reusa un adjunto ya vinculado al Requisito del hilo en vez de subirlo de
  nuevo. Ningun otro recurso ni operacion de lectura queda habilitado, y ADR-003 lo enumera asi.
  **Estado (S-005 a S-022):** `requirements.new` esta **implementado** de punta a punta —schema Zod
  del contrato, publicacion con `client.command()` y la traduccion de las 9 ramas de diagnostico del
  SDK al sistema que rechazo (S-005)— con **dos disparadores** desde S-015: el modo de verificacion
  (`npm run verify`, payload fijo, un entry point separado del arranque) y el tick (payload derivado
  del mail, via `publishRequirementFromMail()`). **FG-4 completo (S-017 a S-022):**
  `files.request-upload` esta implementado de punta a punta (permiso de subida por adjunto, con la
  traduccion de `file_type_not_allowed`/`file_too_large` como rechazo de negocio, S-018); el `PUT`
  del byte via `fetch` nativo directo a la `uploadUrl` prefirmada, sin credenciales de S3 (S-019); y
  `fileIds` en el payload de `requirements.new`, condicional (sólo si hay al menos uno, nunca
  `fileIds: []`), resuelto por el orquestador `procesarAdjuntosDelMail()` (particion → dedup → tope →
  permiso → `PUT`, S-017 a S-021). Las propiedades del sistema completo con adjuntos —el orden
  invariante, el tope no recalculado tras un fallo de `PUT`, el pico de memoria de un mail a la vez, y
  que ningun log filtra el contenido de un adjunto ni la `uploadUrl`— quedan afirmadas por tests sobre
  `runTick()`, no solo sobre los modulos puros (S-022), que tambien verifica de punta a punta el
  camino completo con un adjunto sin instancia real de Jiku. **S-027 agrega el TERCER comando**
  (`requirements.{id}.comment`): la respuesta de un cliente al hilo de su ticket se publica como
  Comentario **publico** —`visibilityLevel` explicito, porque el default del contrato es `internal` y
  un comentario interno no lo veria el cliente— con sus adjuntos por la misma politica, y REUSANDO
  la traduccion de errores sin agregarle ramas. Documentado en
  [publicacion-requirements-comment](../../flows/publicacion-requirements-comment.md).

  **S-029 abre el PLANO DE CONSULTAS, y es el primer cambio de este servicio que deroga una regla
  de una ADR.** El modulo hace ahora **una consulta de lectura**, `attachments.list`, desde un unico
  archivo (`src/domain/publicacion/lookup-attachment.ts`, `lookupAttachmentByChecksum()`): cuando una
  respuesta matchea el Mapa de Hilos, cada adjunto aceptado pregunta si su `checksum` ya esta
  vinculado al Requisito del hilo **por el propio conector** —filtrando por los cuatro nombres
  `entityType`/`entityId`/`checksum`/`uploadedBy`— y un match devuelve el `fileId` existente y
  **corta el ciclo de subida** (ni permiso, ni `PUT`). Resuelve el caso que motiva REQ-006: Gmail
  arrastra los adjuntos del original en la respuesta, y hasta S-028 se subian de nuevo.

  **El alcance de la derogacion, que importa mas que el cambio:** ADR-003 **declaraba** *"El conector
  MUST NOT publicar en el plano de consultas (`jiku-queries.*`) ni suscribirse a subjects de otros
  servicios"*. S-029 deroga **la primera mitad, y solo para `attachments.list`**; la segunda —no
  suscribirse a subjects de otros— **queda INTACTA**, porque `client.list()` es un request/reply
  sobre el inbox propio y esta story no agrega ninguna suscripcion. Se pudo hacer porque `core`
  expuso `checksum` como **filtrable e incluible** en el recurso, precisamente para que un consumidor
  deduplique contra los vinculos existentes en **una** consulta y no en N+1 —que era el costo que la
  regla evitaba—. **El texto de ADR-003, del flujo y del PRD ya esta reescrito** (S-030): la
  Implementation Rule quedo partida en dos —la prohibicion de suscribirse, intacta; la de consultar,
  reescrita enumerando `attachments.list` con sus cuatro filtros— y §Decision ya no afirma que el
  conector no usa el plano de lectura. El caso `'touches the query plane only through
  attachments.list, only in the lookup module'` de `test/publicacion/source-properties.test.ts` sigue
  siendo la version **ejecutable** de la regla, y mantiene prohibidos en **todo** `src/` el resto del
  plano de lectura
  (`client.query(`, `client.get(`, `client.iterate(`, `client.all(`, `client.count(`) y el literal
  `jiku-queries`. Cualquier fallo de la consulta —los seis codigos del contrato incluidos— **degrada
  al comportamiento anterior**: se sube el archivo como siempre, con un `warn` y su `diagnosis`, y
  `diagnosePublishFailure()` se reusa **sin una sola rama nueva**. **Cero cambios de infraestructura
  y ninguna capacidad nueva en el bus:** el rol `internal-app` ya autorizaba `pub` sobre
  `jiku-queries.v1.>`.

## Notas adicionales

**Instancia unica obligatoria.** Sin idempotencia ni coordinacion, dos instancias sobre la misma
casilla duplicarian tickets (NFR-SC03).

**Restriccion dura de red.** El conector va dentro de la red del bus de Jiku, que no esta expuesta al
ingress. No puede desplegarse afuera y alcanzar NATS.

**El SDK `@gravadigital/jiku` es la dependencia central.** Reemplaza el cliente NATS propio,
la obtencion del token de Zitadel (RFC 7523) y su refresh en background, y el prefijo de inbox. Las
clases de error del SDK son lo que distingue *que sistema rechazo* en el log. Se consume del **build
local de `jiku-ts@edd1064`** (`vendor/gravadigital-jiku-1.0.0-edd1064.tgz`, el `npm pack` sin
publicar, que declara `1.0.0`). El KV entra por **`client.kv()`**, y sus clases de error
(`JikuNoBucket`, `JikuKVPermissionDenied`, `JikuBucketFull`) salen de la entrada principal: el
conector **no** declara ninguna libreria de KV ni de JetStream (ADR-002). Sigue valiendo que haya una
sola copia de `nats-core` en el arbol —la del SDK—, sin la cual un `instanceof` contra una clase de
error del SDK falla contra la copia que lo lanzo. *(Historia: entre S-023 y S-032 el KV entro por un
re-export de `@nats-io/kv` en el subpath `./nats` de un build 1.1.0 vendoreado; `jiku-ts` nunca tuvo
ese re-export. REQ-008 lo reemplazo por `client.kv()`.)*

**El conector no expone nada.** Ni HTTP, ni puerto, ni suscripcion a subjects de otros. Por eso no
hay especificacion OpenAPI en `docs/apis/` para este producto — un `/health` de relleno seria un
contrato falso.

**Sin base de datos propia.** No hay documento en `docs/db-schemas/`, ni migraciones, ni cliente de
PostgreSQL. Las entidades que el conector crea (Requisito, Archivo, Adjunto) son de Jiku y las
escribe `core`.

**Pero desde S-024 sí tiene estado, y vive en el bus.** El matiz correcto no es "el conector no
persiste nada" sino **"el conector no tiene persistencia propia"**: usa su **Espacio KV** dentro del
bucket compartido `JIKU_KV` (JetStream), que es un almacén del bus —una dependencia que ya tenía— y no
una base que él administre. Sigue sin haber `docs/db-schemas/`, sin migraciones y sin cliente de
base: un espacio KV no es ninguna de esas cosas. El espacio tiene dos prefijos: `tickets.<slug> →
projectId` (el Mapa de Tickets, configuración que administra un humano, U-02) y `hilos.<sha256> →
requirementId` (el Mapa de Hilos, estado que el conector escribe en cada mail). **`JIKU_KV` lo crea
el deploy de Jiku**, ni U-02 ni el conector. Cada identidad alcanza **sólo su propio espacio**
(invariante 31): por el prefijo que agrega el SDK y por los **tres grants** de la plantilla de
`internal-app` (`$JS.API.STREAM.INFO.KV_JIKU_KV`, `$KV.JIKU_KV.<instance>.{{user_id}}.>` y
`$JS.API.DIRECT.GET.KV_JIKU_KV.$KV.JIKU_KV.<instance>.{{user_id}}.>`), nunca una forma ancha como
`$JS.API.>`, que alcanzaria las claves de todas las identidades. *(S-034 / REQ-008: hasta S-032 eran
dos buckets propios, configurables por variable de entorno y creados por el operador.)*

**El logging es la preocupacion transversal mas importante.** No hay nadie mirando: el cliente mando
un mail y se fue. Un ticket perdido no tiene sintoma. Cada mail deja al menos una linea con su
`Message-Id` y su resultado. Nunca se loguean credenciales, trafico IMAP crudo, el cuerpo del mail ni
el contenido de un adjunto.

**El servicio esta empaquetado (S-006).** El `Dockerfile` multi-stage (`test`/`builder`/`production`)
existe en la raiz, en su **variante worker**: corre como usuario no-root, instala con
`npm ci --omit=dev`, no hornea ningun secreto —la key del machine user y el creds del sentinel se
montan **read-only** en runtime— y su `CMD` arranca el worker, nunca el modo de verificacion (que si
viaja en la imagen, para correrlo a mano). **Sus dos ausencias son decisiones declaradas y llevan su
comentario en el archivo:** sin `EXPOSE`, porque el conector no expone HTTP; y sin `HEALTHCHECK`,
porque el unico check disponible siempre pasa y una señal verde que no prueba nada es peor que
ninguna (ADR-006). Las cinco precondiciones de despliegue —que el conector **no puede resolver**, y
ante cuya ausencia lo unico que hace es fallar de forma legible— estan en el `README.md`.

**El servicio tiene CI (REQ-007 / S-031).** GitLab CI (`.gitlab-ci.yml`, no hereda el workflow de
GitHub Actions de Jiku) corre `build` → `test` → `release` en cada push y cada merge request con
cambios de codigo. La suite **completa** (`npm run test:teardown`, con los NATS reales de
Testcontainers y los tests que construyen la imagen) es el unico gate: corre sobre el checkout con
`docker:dind`, no dentro de la etapa `test` del `Dockerfile`. Solo `dev` y `main` publican en el
registry del proyecto: `:dev`, y `:<version.txt>` + `:master`. Ver ADR-007.

**Diferido a operaciones:** el deploy (el `Dockerfile` deja la etapa `test` lista para correr la
suite a mano; el `docker build` no la corre, porque levanta un NATS con Testcontainers y necesitaria
Docker dentro del build); entorno de staging; rotacion de
la key del machine user (Zitadel la entrega **una sola vez** y **no hay procedimiento definido**);
gestion de secretos mas alla de env + archivos montados. **Fuera de alcance v1:** healthchecks,
metricas exportadas y alertas.

**Hueco conocido del catalogo de convenciones.** Dos de los tres integradores centrales de este
servicio no tienen convencion que los cubra: el uso del SDK de Jiku (conexion unica por proceso,
token como getter, mapeo de clases de error) y el manejo de senales del apagado ordenado. **El poll
IMAP (cap y no-solapamiento) y el scheduling por cron ya se estabilizaron** con el cierre de S-011 —
guard de no solapamiento, apagado ordenado y las dos ramas de `POLL_ENABLED` completos y cubiertos
por tests— y son candidatos concretos a convencion custom via
`/product-change-technical-definition`. No se escribe la convencion en esta story: se registra el
estado para que la proxima que toque este patron sepa que ya dejo de ser exploratorio.

---

**Manifest:** [manifest.yaml](./manifest.yaml)
**Indice de arquitectura:** [index.md](./index.md)
