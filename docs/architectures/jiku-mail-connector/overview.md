# jiku-mail-connector — Overview

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
- **ruteo** — Resolucion del slug del subaddress contra el Mapa de Tickets (copia en memoria de un
  bucket KV del bus, cargada al arrancar y actualizada **en caliente** por `watch()` desde S-025). Un mail sin slug mapeado se descarta con motivo logueado. **Estado (S-012 a S-016):**
  **implementado** de punta a punta — el arbol de decision puro de `routeMail()` (`es_respuesta` →
  `sin_slug` → `slug_no_mapeado` → resuelto, S-013), cableado en el tick junto con la publicacion
  (S-014), y con las propiedades del sistema completo afirmadas por tests (slug literal en el log
  redactado, ningun log filtra contenido de cliente, entry points limpios, pico de memoria de un mail
  a la vez — S-016). Documentado de punta a punta en
  [ruteo-y-alta-del-requisito](../../flows/ruteo-y-alta-del-requisito.md).
- **infra/kv** — Los dos buckets KV de NATS sobre la **conexion unica** del proceso (ADR-002): el
  `Kvm` se construye sobre `client.connection`, nunca sobre una conexion nueva. **Estado (S-024):**
  la **apertura y verificacion** de los dos buckets al arrancar esta **implementada** —
  `openKvStores()` los abre con `open()` y verifica que existen con `status()`, falla rapido con un
  error que **nombra el bucket faltante**, y compara el TTL del bucket de hilos avisando con un
  `warn` sin fijarlo. El conector **no crea buckets** y **no fija el TTL**, las dos cosas afirmadas
  por tests que escanean `src/`. **S-025 sumo el `watch()` del Mapa de Tickets**: `startTicketMapWatch()`
  espera la carga inicial completa antes de que se schedule el primer tick y despues mantiene la copia
  en memoria al dia, mutando SIEMPRE el mismo `Map` —nunca reemplazandolo— que es lo que hace que
  `config.ruteo.ticketMap` vea las actualizaciones. Si el watch se cae, el mapa **se conserva** y se
  reintenta; vaciarlo convertiria una caida del bus en perdida de tickets. **S-026 sumo las
  operaciones del Mapa de Hilos** (`threads.ts`): `sha256hex()` construye la clave —el sha256 en hex
  del `Message-Id` **crudo**, porque `validKeyRe` de la libreria rechaza `<`, `>` y `@`—,
  `recordThreadEntry()` escribe la entrada despues del alta con una falla **no cancelante**, y
  `lookupThread()` recorre los `referenceIds` **en orden** y **corta en el primer hit**. El bucket de
  hilos se lee con `get()` **puntual, sin `watch()` y sin copia en memoria**: es estado de alto
  cardinal que cambia en cada mail, y el contraste con el Mapa de Tickets es deliberado. Ninguna de
  las dos operaciones lanza, y **el bucket NO participa de la idempotencia** —el `\Seen` sigue siendo
  la unica marca—, las tres cosas afirmadas por tests que escanean `src/`. El parseo del entero leido
  del KV vive **compartido** en `parse.ts` (`parsePositiveId()`), consumido por los dos buckets.
  **S-027 le dio consumidor al lookup**: la respuesta con match se publica como Comentario y
  `comentados` empieza a incrementarse. **S-028 lo verifico de punta a punta** contra un NATS real con
  JetStream —el ciclo alta → write → respuesta → comentario → write → respuesta a la respuesta
  (`test/infra/kv/e2e-kv.test.ts`), el fail-fast del bucket faltante encadenado con
  `reportStartupFailure()` para los dos buckets, el `watch()` en caliente medido **sobre el tick**
  (`test/infra/kv/e2e-watch-tick.test.ts`), y las propiedades del sistema sobre `runTick()` cableado
  (`test/ingesta/tick-propiedades-kv.test.ts`)—. **El modulo esta completo y verificado** — REQ-005
  **no deja nada pendiente** en `infra/kv`. Documentado en el Paso 5.5 de [arranque-y-conexion-al-bus](../../flows/arranque-y-conexion-al-bus.md), que
  registra los cuatro hallazgos verificados del KV (entre ellos que `open()` **no** verifica
  existencia, y que el TTL viene en milisegundos), y de punta a punta en
  [mapa-de-hilos-en-kv](../../flows/mapa-de-hilos-en-kv.md).
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

**El SDK `@gravadigital/jiku` (>= v1.1.0) es la dependencia central.** Reemplaza el cliente NATS propio,
la obtencion del token de Zitadel (RFC 7523) y su refresh en background, y el prefijo de inbox. Las
siete clases de error del SDK son lo que distingue *que sistema rechazo* en el log. Desde S-023 el
SDK tambien **re-exporta el KV** por su subpath `./nats`, y es por ahi que entra: el conector **no**
declara `@nats-io/kv` ni `@nats-io/jetstream` (ADR-002), porque tomarlos del subpath garantiza una
sola copia de `nats-core` en el arbol — sin la cual un `instanceof` contra una clase de error del
SDK falla contra la copia que lo lanzo.

**El conector no expone nada.** Ni HTTP, ni puerto, ni suscripcion a subjects de otros. Por eso no
hay especificacion OpenAPI en `docs/apis/` para este producto — un `/health` de relleno seria un
contrato falso.

**Sin base de datos propia.** No hay documento en `docs/db-schemas/`, ni migraciones, ni cliente de
PostgreSQL. Las entidades que el conector crea (Requisito, Archivo, Adjunto) son de Jiku y las
escribe `core`.

**Pero desde S-024 sí tiene estado, y vive en el bus.** El matiz correcto no es "el conector no
persiste nada" sino **"el conector no tiene persistencia propia"**: usa dos buckets KV de NATS
(JetStream), que es un almacén del bus —una dependencia que ya tenía— y no una base que él
administre. Sigue sin haber `docs/db-schemas/`, sin migraciones y sin cliente de base: un bucket KV
no es ninguna de esas cosas. Los dos buckets son `KV_TICKETS_BUCKET` (el Mapa de Tickets:
`slug → projectId`, configuración que administra un humano) y `KV_THREADS_BUCKET` (el Mapa de Hilos:
`sha256(Message-Id) → requirementId`, estado que el conector escribe en cada mail). **Los crea el
operador**, no el conector.

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

**Diferido a operaciones:** CI/CD, build y registry de la imagen (no hereda el workflow de Jiku, que
usa GitHub Actions) — el `Dockerfile` deja la etapa `test` lista y documentada, pero **el
`docker build` no corre la suite**: levanta un NATS con Testcontainers y necesitaria Docker dentro
del build, asi que quien la corre es el pipeline. Tambien diferidos: entorno de staging; rotacion de
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
