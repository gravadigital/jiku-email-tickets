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
- **ruteo** — Resolucion del slug del subaddress contra el Mapa de Tickets (KV en memoria, cargado
  al arrancar). Un mail sin slug mapeado se descarta con motivo logueado. **Estado (S-012 a S-016):**
  **implementado** de punta a punta — el arbol de decision puro de `routeMail()` (`es_respuesta` →
  `sin_slug` → `slug_no_mapeado` → resuelto, S-013), cableado en el tick junto con la publicacion
  (S-014), y con las propiedades del sistema completo afirmadas por tests (slug literal en el log
  redactado, ningun log filtra contenido de cliente, entry points limpios, pico de memoria de un mail
  a la vez — S-016). Documentado de punta a punta en
  [ruteo-y-alta-del-requisito](../../flows/ruteo-y-alta-del-requisito.md).
- **publicacion** — Los dos comandos de escritura al bus via el SDK: `files.request-upload` y
  `requirements.new`. El `PUT` del byte del adjunto a la URL prefirmada que devuelve `core`.
  **Estado (S-005 a S-016):** `requirements.new` esta **implementado** de punta a punta —schema Zod
  del contrato, publicacion con `client.command()` y la traduccion de las 9 ramas de diagnostico del
  SDK al sistema que rechazo (S-005)— con **dos disparadores** desde S-015: el modo de verificacion
  (`npm run verify`, payload fijo, un entry point separado del arranque) y el tick (payload derivado
  del mail, via `publishRequirementFromMail()`). **Pendientes de FG-4:** `files.request-upload`, el
  `PUT` del adjunto y `fileIds` en el payload.

## Notas adicionales

**Instancia unica obligatoria.** Sin idempotencia ni coordinacion, dos instancias sobre la misma
casilla duplicarian tickets (NFR-SC03).

**Restriccion dura de red.** El conector va dentro de la red del bus de Jiku, que no esta expuesta al
ingress. No puede desplegarse afuera y alcanzar NATS.

**El SDK `@gravadigital/jiku` v1.0.0 es la dependencia central.** Reemplaza el cliente NATS propio,
la obtencion del token de Zitadel (RFC 7523) y su refresh en background, y el prefijo de inbox. Las
siete clases de error del SDK son lo que distingue *que sistema rechazo* en el log.

**El conector no expone nada.** Ni HTTP, ni puerto, ni suscripcion a subjects de otros. Por eso no
hay especificacion OpenAPI en `docs/apis/` para este producto — un `/health` de relleno seria un
contrato falso.

**Sin base de datos propia.** No hay documento en `docs/db-schemas/`, ni migraciones, ni cliente de
PostgreSQL. Las entidades que el conector crea (Requisito, Archivo, Adjunto) son de Jiku y las
escribe `core`.

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
