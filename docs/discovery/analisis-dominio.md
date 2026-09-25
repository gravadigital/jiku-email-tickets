---
created: 2026-08-26
last_updated: 2026-08-26
status: Análisis de dominio cerrado
documento_base: "analisis-funcional.md (jiku-email-tickets) + el dominio de Jiku en jiku/core/docs/prd/requirements.md"
---

# Análisis de Dominio — jiku-email-tickets

> **Qué es este documento.** El modelo de dominio del conector, en la notación que
> `/product-initialize` transcribe verbatim a la sección de Entidades del Dominio del PRD.
>
> **La particularidad de este dominio, y hay que decirla al principio porque explica todo lo
> demás:** el conector **no es dueño de ninguna entidad persistida**. Las entidades que le
> importan viven en dos lados y ninguno es él:
>
> | Dónde vive | Entidades | Quién las escribe |
> |---|---|---|
> | **En el mail** (efímero) | Mail Entrante, Adjunto del Mail | Nadie: llegan, se procesan y se descartan |
> | **En la configuración del conector** | Mapa de Tickets | Un operador, a mano |
> | **En Jiku** (persistido) | Requisito, Archivo, Adjunto | **`core`**, por comando. El conector sólo lo pide |
>
> Por eso este documento modela **el ciclo de vida de un mail**, no un esquema de base de datos.
> El conector no tiene base de datos: es la decisión 1 y la decisión 2 del análisis funcional.

---

## Lenguaje Ubicuo

| Término | Definición | Notas |
|---|---|---|
| **Mail Entrante** | Un mensaje de la casilla de tickets, ya normalizado y listo para procesar | Efímero: existe en memoria durante un tick y nunca se persiste. **No confundir con "Ticket"** |
| **Ticket** | El pedido de un cliente expresado como mail | Es el concepto de negocio; su materialización en Jiku es un **Requisito**. La palabra no nombra ninguna entidad del conector |
| **Slug** | El token del subaddress que identifica al proyecto destino: la parte entre `+` y `@` | Siempre en minúsculas. En `tickets+alfa@grava.io` el slug es `alfa` |
| **Mapa de Tickets** | La tabla de configuración `slug → id de proyecto` | KV cargado a mano. **Es configuración del conector, no dato del producto** (decisión 3) |
| **Adjunto del Mail** | Una parte MIME con contenido de archivo del Mail Entrante | Efímero. **No es el Adjunto de Jiku**, que es un vínculo |
| **Requisito** | La entidad de Jiku que representa el pedido | La escribe `core`. El conector la crea publicando un comando y **nunca la modifica después** |
| **Archivo** | La entidad de Jiku que representa un archivo con su ubicación física | Identidad propia, independiente de a qué se vincule. **Un archivo sin vínculo es un estado válido** |
| **Adjunto** (de Jiku) | El **vínculo** entre un Archivo y una entidad | El conector no lo crea directamente: lo crea `core` al recibir los `fileIds` |
| **Aceptado / Rechazado** | Resultado de aplicar la política de archivos a un Adjunto del Mail | Un **rechazado** deja aviso en la descripción; un **duplicado** no deja nada |
| **Descarte** | La decisión de no crear nada a partir de un Mail Entrante | Es un resultado **correcto y esperado**, no un error (decisión 15) |
| **Tick** | Una corrida del poll: conectar, traer hasta N mails, procesarlos, cerrar | No se solapa con otro tick |
| **Caller** | La identidad con la que el conector publica en el bus | El machine user de Zitadel. Su `sub` es el `user-id` del subject y es infalsificable |

---

## Entidades

> **Notación.** Las tres primeras son del conector; las tres últimas son **de Jiku** y se
> transcriben sólo con los atributos que el conector escribe o lee, con un puntero al dominio
> completo. Modelarlas enteras acá duplicaría el PRD de Jiku y las dos copias divergirían.

### Mail Entrante

- **Atributos clave:** `messageId` (string, **req** — el `Message-Id`; el único campo obligatorio
  de la normalización), `referenceIds` (lista de string, opt — unión deduplicada de `In-Reply-To`
  y `References`), `recipient` (string, opt — de `Delivered-To`, con `To` como fallback),
  `senderEmail` (string, opt — aislado del formato `Nombre <mail@dominio>`), `subject` (string,
  opt — sin los prefijos `Re:`/`Fwd:`/`RV:`), `body` (string, opt — texto plano, sin el texto
  citado del hilo), `attachments` (lista de Adjunto del Mail, opt)
- **Relaciones:** has_many Adjunto del Mail (0..N)
- **Notas:** **Efímero: no se persiste en ningún lado.** Vive en memoria durante el
  procesamiento de un tick. Un mail sin `messageId` se descarta sin procesar. `referenceIds`
  vacío significa **mail nuevo**; no vacío significa **respuesta a un hilo**, y en v1 eso es un
  descarte (decisión 9). `subject` y `body` vacíos son estados válidos: se reemplazan por
  placeholders al crear el Requisito.

### Adjunto del Mail

- **Atributos clave:** `filename` (string, req), `mimeType` (string, req — **declarado por el
  mail, no verificado**), `size` (int, req), `content` (bytes, req), `checksum` (string sha256 —
  **lo calcula el conector**, no viene en el mail), `contentDisposition` (enum:
  `inline`/`attachment`, opt), `contentId` (string, opt)
- **Relaciones:** belongs_to Mail Entrante
- **Notas:** Efímero, igual que su mail. `mimeType` y `size` son **declaraciones**, y ni el
  conector ni Jiku verifican que se correspondan con el byte. `contentDisposition` y `contentId`
  se conservan aunque v1 no los use: son lo que permitiría distinguir una imagen inline (una
  firma, un logo) de un adjunto real, y v1 decide tratarlas igual (decisión 11).

### Entrada del Mapa de Tickets

- **Atributos clave:** `slug` (string, req, **único**, siempre en minúsculas), `projectId` (int,
  req — un id de `projects` de Jiku)
- **Relaciones:** ninguna. Es una tabla plana de configuración
- **Notas:** **Es configuración, no dato de negocio**: se carga a mano por variable de entorno o
  archivo montado, y se lee al arrancar. El `projectId` **no se valida contra Jiku**: si apunta a
  un proyecto inexistente, el síntoma es un `project_not_found` por mail (decisión 4). Un mapa
  **vacío es válido** — el conector arranca y descarta todo; un mapa **mal formado no lo es** y
  el conector no arranca.

### Requisito *(entidad de Jiku)*

- **Atributos que el conector escribe:** `title` (string, req, **max 255** — el asunto, truncado
  por el conector), `description` (text, req — el cuerpo más los avisos y los placeholders),
  `projectId` (int, req — del Mapa de Tickets), `type` (enum:
  `funcionalidad`/`mejora`/`incidencia`/`otro`, default del conector: **`incidencia`**),
  `priority` (enum: `sin_prioridad`/`baja`/`media`/`alta`/`urgente`, default `sin_prioridad`),
  `visibilityLevel` (enum: `public`/`internal`, default `public`), `creator` (string — el `sub`
  del caller, **que `core` resuelve del subject e ignora lo que se declare**)
- **Atributos que el conector NO toca:** `state` (nace en `analisis`, que es el default de Jiku),
  `scope`, `technicalSolution`, `acceptanceCriteria`, `estimatedFinishDate`, `tags`,
  `responsiblePersonIds`, y los cuatro timestamps de transición
- **Relaciones:** belongs_to Proyecto (req), has_many Adjunto (por los `fileIds`)
- **Notas:** **El conector lo crea y nunca lo modifica.** No hay comando de compensación: si el
  alta salió bien y el vínculo de un adjunto falló, el requisito queda con el aviso en la
  descripción y así se queda. `visibilityLevel: 'public'` significa *"visible para usuarios
  externos autenticados"* — es lo que hace que el cliente vea su ticket en Opus, y **no** habilita
  acceso anónimo a nada. Dominio completo en `docs/prd/requirements.md` de Jiku.

### Archivo *(entidad de Jiku)*

- **Atributos que el conector declara:** `fileName` (string, req, max 255), `mimeType` (string,
  req, max 100), `fileSize` (int, req, ≥ 1), `checksum` (string sha256, opt)
- **Atributos que decide `core` y el conector nunca elige:** `storageKey`, `storageBucket`,
  `storageRegion`, `byteStatus`, `uploadedBy`, `retentionStatus`
- **Relaciones:** has_many Adjunto (**0..N** — un archivo puede no estar vinculado a nada)
- **Notas:** **Quien sube no elige dónde se guarda** — `core` construye la clave. El conector
  recibe el `id` y una URL prefirmada, y hace el `PUT` del byte directo al storage: **el byte
  nunca viaja por el bus** (el `max_payload` es 1 MB y los adjuntos llegan a 10 MB). `uploadedBy`
  queda con el `sub` del caller, resuelto por `core`, y es **lo que hace que la titularidad se
  cumpla por construcción**. Un archivo huérfano —subido y nunca vinculado— es un estado válido y
  nadie lo limpia.

### Adjunto *(entidad de Jiku)*

- **Atributos:** `entityType` (string, req — para el conector siempre `requirement`), `entityId`
  (int, req), `fileId` (int, req)
- **Relaciones:** belongs_to Archivo (FK real), vínculo **polimórfico** hacia la entidad
- **Notas:** **El conector no lo crea nunca directamente.** Lo crea `core` en la misma
  transacción del alta del Requisito, a partir de los `fileIds`. El conector no conoce su `id` ni
  lo necesita.

---

## Ciclos de Vida y Estados

### Mail Entrante — el ciclo de vida central del conector

Es el único ciclo de vida propio, y **el estado no se persiste**: es la posición del mail en el
recorrido de un tick. Aun así importa modelarlo, porque **cada estado terminal tiene una
consecuencia distinta** y es lo que define el comportamiento del conector.

| Estado | Cuándo | Transiciones permitidas | Prohibidas |
|---|---|---|---|
| `sin_leer` | Está en la casilla, `\Unseen` | → `en_proceso` | — |
| `en_proceso` | El tick lo tomó y lo marcó `\Seen` | → `descartado`, `publicado`, `fallido` | → `sin_leer` (**el `\Seen` no se revierte**) |
| `descartado` | Sin slug, slug no mapeado, es una respuesta, o no se pudo parsear | (terminal) | → cualquiera |
| `publicado` | El comando de alta respondió `success` | (terminal) | → cualquiera |
| `fallido` | El comando falló o expiró | (terminal) | → cualquiera. **No hay reintento** |

**Las dos transiciones que definen el conector, y las dos son pérdidas asumidas:**

- **`en_proceso` → `fallido` es definitivo.** El mail ya está `\Seen` y no hay reintento: el
  ticket se perdió y el único rastro es el log. Es la decisión 1.
- **`en_proceso` no se revierte a `sin_leer`.** Si el proceso muere entre el comando exitoso y el
  `\Seen`, el próximo tick lo reprocesa y **crea un Requisito duplicado**. La otra cara de la
  misma decisión.

### Adjunto del Mail

| Estado | Cuándo | Transiciones permitidas | Prohibidas |
|---|---|---|---|
| `pendiente` | Recién parseado del mail | → `aceptado`, `rechazado` | — |
| `rechazado` | Falla la política local, o `core` la rechaza | (terminal) → deja **aviso** en la descripción | → `aceptado` |
| `aceptado` | Pasa la política y está dentro del tope de 10 | → `subido`, `duplicado`, `fallido` | — |
| `duplicado` | Su checksum ya apareció en el mismo mail | (terminal) → **no deja aviso ni placeholder** | → `subido` |
| `subido` | El `PUT` a la URL prefirmada respondió OK | → `vinculado`, `huerfano` | — |
| `fallido` | El `PUT` o el pedido de permiso falló | (terminal) → deja **aviso** en la descripción | → `subido` |
| `vinculado` | El alta del Requisito con su `fileId` fue `success` | (terminal) | — |
| `huerfano` | Se subió pero el alta del Requisito falló | (terminal) | → `vinculado`. **Nadie lo limpia** |

**`duplicado` y `rechazado` son estados distintos a propósito, y confundirlos sería un bug**: un
rechazado le avisa al cliente que su archivo no entró; un duplicado es el **mismo** archivo que ya
entró, así que avisar sería ruido y contar el placeholder dos veces sería mentira.

---

## Invariantes y Reglas de Negocio

1. **Mail Entrante** — Un mail sin `messageId` no se procesa. Es el único campo obligatorio de la
   normalización.
2. **Mail Entrante** — Un mail con `referenceIds` no vacío **se descarta en v1**. Sin esta regla,
   la respuesta de un cliente crearía un Requisito duplicado en vez de un comentario: el "fuera de
   alcance" tiene que ser **activo**, no pasivo (decisión 9).
3. **Mail Entrante** — Un mail que no resuelve a un proyecto **no crea nada**. Crear un Requisito
   en el proyecto equivocado lo haría visible a un cliente que no debía verlo, y eso rompe el
   aislamiento del portal de Jiku (ADR-006). El descarte es la falla segura.
4. **Slug** — Se compara **siempre en minúsculas**, en las dos puntas del mapa.
5. **Mapa de Tickets** — Un `slug` es único. Dos entradas con el mismo slug es un mapa mal formado
   y el conector no arranca.
6. **Requisito** — Nace siempre en `analisis`: el conector no manda `state`.
7. **Requisito** — `title` se trunca a 255 caracteres **antes de publicar**. El contrato del
   comando no declara un `maxLength`, así que un asunto largo llegaría a `core` y fallaría en la
   base con un error genérico; truncar del lado del emisor convierte un fallo opaco en una pérdida
   de información visible (decisión 7).
8. **Requisito** — `title` y `description` nunca quedan vacíos: si el mail los trae vacíos, se
   usan los placeholders configurados. Los dos son `req` en Jiku.
9. **Requisito** — Un Requisito creado **no se modifica nunca**. No hay comando de compensación en
   el conector.
10. **Adjunto del Mail** — La política autoritativa es la de **`core`**, que lee la doble lista
    blanca —extensión **y** MIME— en caliente. La del conector es una **conveniencia** y puede
    quedar desalineada: si lo está, `core` rechaza y el conector anota el aviso (decisión 13).
11. **Adjunto del Mail** — A lo sumo **10** por Requisito. Es el `maxItems` del contrato del bus,
    no un límite de transporte: es una regla de dominio.
12. **Adjunto del Mail** — Dos adjuntos con el mismo checksum en el mismo mail **se colapsan a
    uno**, y el colapsado no deja aviso ni placeholder.
13. **Adjunto del Mail** — El fallo de un adjunto **nunca cancela el Requisito**. Abortar
    convertiría un archivo corrupto en un ticket perdido, y el ticket es el activo (decisión 12).
14. **Archivo** — El conector **no elige la clave de storage**: la construye `core`. Un conector
    que armara su propia clave rompería la garantía de que el storage tiene un solo dueño.
15. **Archivo** — La titularidad se cumple **por construcción**: `core` resuelve el actor del
    subject —infalsificable— e **ignora lo que el conector declare en el cuerpo**. Sube con su
    identidad y vincula con la misma.
16. **Archivo** — Nadie verifica el byte, ni el conector ni Jiku. El `checksum` se declara y no se
    comprueba.
17. **Caller** — El `user-id` del subject sale de la key del machine user, **nunca de una variable
    de entorno**: tiene que coincidir con el `sub` que el auth-callout lee para autorizar.
18. **Caller** — El conector **no manda `actor`** en el payload de un comando: es la única clave de
    identidad que el plano de escritura rechaza de plano.
19. **Tick** — No se solapa con otro tick. Un tick en curso hace que el siguiente se saltee.
20. **Tick** — Un mail que falla **no aborta el lote**: se cuenta, se loguea y el tick sigue.
21. **Descripción del Requisito** — Se compone en un orden **determinístico**: cuerpo base, avisos
    de rechazo, avisos de fallo de subida, y **los placeholders siempre al final**.
22. **Observabilidad** — No se loguean nunca: credenciales, tráfico IMAP crudo, el cuerpo del mail
    ni el contenido de un adjunto. En un servicio sin nadie mirando, el log es el único rastro de
    un ticket perdido — pero sigue siendo un log, no un depósito de datos del cliente.

---

## Eventos de Dominio

> **Transporte fuera de alcance acá** — lo decide `/product-discovery-technical`. Lo que sigue es
> qué cambios de estado son significativos, no cómo viajan.

| Evento | Disparado por | Datos clave | Contexto |
|---|---|---|---|
| MailIngestado | El tick trae un mail nuevo de la casilla | messageId, recipient | Ingesta |
| MailDescartado | Sin slug, slug no mapeado, es respuesta, o no parseable | messageId, motivo, slug (si hubo) | Ingesta |
| RequisitoSolicitado | Un mail resolvió a un proyecto y se pide el alta | messageId, projectId, cantidad de fileIds | Publicación |
| RequisitoCreado | El alta respondió `success` | messageId, projectId, requisitoId | Publicación |
| PublicacionRechazada | El alta respondió `failure` o expiró | messageId, projectId, código, sistema que rechazó | Publicación |
| ArchivoSubido | El `PUT` a la URL prefirmada respondió OK | fileId, fileName, checksum | Adjuntos |
| ArchivoRechazado | La política lo rechazó, local o en `core` | fileName, motivo | Adjuntos |
| TickFinalizado | Terminó la corrida | ingestados, descartados, creados, fallidos | Ingesta |

**Ninguno de estos eventos se publica hoy: son líneas de log.** Y esa es la observación que
importa, porque **el conector no tiene a quién notificarle**: no hay usuario esperando ni request
que responder. `PublicacionRechazada` es el evento más valioso del conjunto y hoy su único destino
es stdout.

---

## Bounded Contexts

| Contexto | Qué gobierna | Entidades | Relación con los demás |
|---|---|---|---|
| **Ingesta** | Traer mails y normalizarlos | Mail Entrante, Adjunto del Mail | Produce Mail Entrante para Ruteo. **No conoce Jiku** |
| **Ruteo** | Decidir el proyecto destino, o descartar | Entrada del Mapa de Tickets | Consume Mail Entrante; produce el `projectId`. **No conoce el bus** |
| **Publicación** | Hablar con Jiku | Requisito, Archivo, Adjunto (los tres, de Jiku) | Consume lo de Ruteo. **Es el único que conoce el bus** |

**La frontera que más importa es Ingesta ↔ Publicación, y no se tocan.** Ingesta no sabe que Jiku
existe; Publicación no sabe que hubo un mail. Es lo que hace que el dominio del mail —lo único que
se conserva del servicio actual— sea portable, y lo que hizo posible reescribir la mitad de la
escritura sin tocar la otra mitad.

**Relación con el contexto de Jiku:** el conector es un **consumidor del contrato del bus**, no un
socio de modelado. Jiku define el contrato y el conector se somete: no negocia campos, no propone
comandos, y **cuando el contrato y el conector discrepan, manda el contrato**. Es la relación que
en DDD se llama *conformist*, y es deliberada — la alternativa (pedirle a Jiku un comando a medida)
está fuera del alcance v1 por el principio de no modificar el producto.

---

## Notas de Consistencia

- **El conector no tiene transacciones.** No tiene base. La atomicidad que le importa es la de
  `core`: el Requisito y sus vínculos se escriben **en una sola transacción** y si algo falla no
  sobrevive ni el requisito ni un vínculo. Lo que **sí** sobrevive son las filas de `files`, sin
  vincular, y eso es un estado válido.
- **Hay una ventana de inconsistencia real y no se cierra:** los archivos se suben **antes** de
  crear el Requisito, así que entre el último `PUT` y el `success` del alta existen archivos que no
  pertenecen a nada. Si el alta falla, quedan huérfanos para siempre. Se acepta porque el orden
  inverso es imposible —los `fileIds` son un argumento del alta— y porque Jiku ya declara el
  archivo sin vínculo como estado válido.
- **La consistencia con `users` es eventual y el conector no la controla.** Su fila la crea Jiku al
  consumir el evento de autenticación del bus, con una entrega **no durable**. Un evento perdido
  deja al conector sin fila, y sus comandos fallan con `caller_not_authorized` hasta la próxima
  autenticación. **Es una dependencia declarada, no un bug del conector.**
- **El Mapa de Tickets puede quedar desactualizado respecto de Jiku** sin que nada lo detecte: un
  proyecto que se cancela en Jiku sigue teniendo su slug en el mapa. El síntoma sería un Requisito
  creado en un proyecto cancelado, que es una inconsistencia **de negocio** y no de datos.
