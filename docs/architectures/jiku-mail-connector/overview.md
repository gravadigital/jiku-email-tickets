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
- **ruteo** — Resolucion del slug del subaddress contra el Mapa de Tickets (KV en memoria, cargado
  al arrancar). Un mail sin slug mapeado se descarta con motivo logueado.
- **publicacion** — Los dos comandos de escritura al bus via el SDK: `files.request-upload` y
  `requirements.new`. El `PUT` del byte del adjunto a la URL prefirmada que devuelve `core`.
  **Estado (S-005):** `requirements.new` esta **implementado** —schema Zod del contrato, payload fijo,
  publicacion con `client.command()` y la traduccion de las 7 clases de error del SDK al diagnostico
  de que sistema rechazo— y se ejercita con el modo de verificacion (`npm run verify`), un entry point
  separado del arranque. **Pendientes de FG-4:** `files.request-upload`, el `PUT` del adjunto y
  `fileIds` en el payload. **Pendiente de FG-3:** el payload derivado del mail (hoy es fijo).

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

**Hueco conocido del catalogo de convenciones.** Los tres integradores centrales de este servicio no
tienen convencion que los cubra: el poll IMAP (cap y no-solapamiento), el uso del SDK de Jiku
(conexion unica por proceso, token como getter, mapeo de clases de error) y el scheduling por cron.
Quedan como candidatos a convencion custom cuando el patron se estabilice en la implementacion.

---

**Manifest:** [manifest.yaml](./manifest.yaml)
**Indice de arquitectura:** [index.md](./index.md)
