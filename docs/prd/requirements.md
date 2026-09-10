---
created: 2026-08-26
last_updated: 2026-08-26
status: Draft - In Definition
---

# PRD — Requerimientos

> Derivado del discovery: [análisis funcional](../discovery/analisis-funcional.md) · [análisis de dominio](../discovery/analisis-dominio.md) · [análisis técnico](../discovery/analisis-tecnico.md)

## Entidades del Dominio

> **La particularidad de este dominio, y hay que decirla al principio porque explica todo lo
> demás:** el conector **no es dueño de ninguna entidad persistida**. Las entidades que le importan
> viven en dos lados y ninguno es él.

| Dónde vive | Entidades | Quién las escribe |
|---|---|---|
| **En el mail** (efímero) | Mail Entrante, Adjunto del Mail | Nadie: llegan, se procesan y se descartan |
| **En un bucket KV del bus de Jiku** (persistido, REQ-005) | Entrada del Mapa de Tickets, Entrada del Mapa de Hilos | La del Mapa de Tickets, un operador (U-02) con el CLI de NATS. La del Mapa de Hilos, **el conector**: es la única entidad que escribe y que sobrevive al tick |
| **En Jiku** (persistido) | Requisito, Comentario, Archivo, Adjunto | **`core`**, por comando. El conector sólo lo pide |

Por eso esta sección modela **el ciclo de vida de un mail**, no un esquema de base de datos. El
conector no tiene base de datos **propia**: desde REQ-005 usa dos buckets KV de NATS (JetStream) del
bus de Jiku, que ya es su dependencia, como su único mecanismo de estado.

### Lenguaje Ubicuo

| Término | Definición | Notas |
|---|---|---|
| **Mail Entrante** | Un mensaje de la casilla de tickets, ya normalizado y listo para procesar | Efímero: existe en memoria durante un tick y nunca se persiste. **No confundir con "Ticket"** |
| **Ticket** | El pedido de un cliente expresado como mail | Es el concepto de negocio; su materialización en Jiku es un **Requisito**. La palabra no nombra ninguna entidad del conector |
| **Slug** | El token del subaddress que identifica al proyecto destino: la parte entre `+` y `@` | Siempre en minúsculas. En `tickets+alfa@grava.io` el slug es `alfa` |
| **Mapa de Tickets** | La tabla de configuración `slug → id de proyecto` | Un **bucket KV de NATS** que un operador carga con `nats kv put`, leído con `watch()` y con copia en memoria (REQ-005). **Es configuración del conector, no dato del producto** |
| **Mapa de Hilos** | La tabla de estado `sha256(Message-Id) → id de requisito` | Un **segundo bucket KV de NATS**, separado del de slugs: éste lo escribe el conector en cada mail y lleva TTL de 90 días (REQ-005) |
| **Comentario** | La entidad de Jiku que representa la respuesta de un cliente en el hilo de su ticket | La escribe `core` por el comando `requirements.{id}.comment`. El conector la crea siempre con `visibilityLevel: 'public'` |
| **Adjunto del Mail** | Una parte MIME con contenido de archivo del Mail Entrante | Efímero. **No es el Adjunto de Jiku**, que es un vínculo |
| **Requisito** | La entidad de Jiku que representa el pedido | La escribe `core`. El conector la crea publicando un comando y **nunca la modifica después** |
| **Archivo** | La entidad de Jiku que representa un archivo con su ubicación física | Identidad propia, independiente de a qué se vincule. **Un archivo sin vínculo es un estado válido** |
| **Adjunto** (de Jiku) | El **vínculo** entre un Archivo y una entidad | El conector no lo crea directamente: lo crea `core` al recibir los `fileIds` |
| **Aceptado / Rechazado** | Resultado de aplicar la política de archivos a un Adjunto del Mail | Un **rechazado** deja aviso en la descripción; un **duplicado** no deja nada |
| **Descarte** | La decisión de no crear nada a partir de un Mail Entrante | Es un resultado **correcto y esperado**, no un error |
| **Tick** | Una corrida del poll: conectar, traer hasta N mails, procesarlos, cerrar | No se solapa con otro tick |
| **Caller** | La identidad con la que el conector publica en el bus | El machine user de Zitadel. Su `sub` es el `user-id` del subject y es infalsificable |

---

### Mail Entrante

- **Atributos clave:** `messageId` (string, **req** — el `Message-Id`; el único campo obligatorio de
  la normalización), `referenceIds` (string[], opt — unión ordenada y deduplicada de `In-Reply-To` y
  `References`), `recipient` (string, opt — de `Delivered-To`, con `To` como fallback),
  `senderEmail` (string, opt — aislado del formato `Nombre <mail@dominio>`), `subject` (string,
  opt — sin los prefijos `Re:`/`Fwd:`/`RV:`), `body` (string, opt — texto plano, sin el texto citado
  del hilo), `attachments` (Adjunto del Mail[], opt)
- **Relaciones:** has_many Adjunto del Mail (0..N)
- **Notas:** **Efímero: no se persiste en ningún lado.** Vive en memoria durante el procesamiento de
  un tick. Un mail sin `messageId` se descarta sin procesar. `referenceIds` vacío significa **mail
  nuevo**; no vacío significa **candidato a comentario** (REQ-005): el resultado depende del lookup
  en el Mapa de Hilos — con match se comenta, sin match se descarta como `hilo_desconocido`. El
  campo no cambia de forma ni de origen. `subject` y
  `body` vacíos son estados válidos: se reemplazan por placeholders al crear el Requisito.
  `senderEmail` **se parsea y en v1 no se usa para nada** (su único consumidor era la notificación
  de Mattermost, que está fuera de alcance).

### Adjunto del Mail

- **Atributos clave:** `filename` (string, req), `mimeType` (string, req — **declarado por el mail,
  no verificado**), `size` (int, req), `content` (bytes, req), `checksum` (string sha256 — **lo
  calcula el conector**, no viene en el mail), `contentDisposition` (enum: `inline`/`attachment`,
  opt), `contentId` (string, opt)
- **Relaciones:** belongs_to Mail Entrante
- **Notas:** Efímero, igual que su mail. `mimeType` y `size` son **declaraciones**, y ni el conector
  ni Jiku verifican que se correspondan con el byte. El `checksum` tiene **dos consumidores**
  *(REQ-006)*: el `checksum` del payload de `files.request-upload` y el filtro de la consulta de
  reuso contra el hilo — **se calcula una sola vez** (en el dedup intra-mail) y nunca se recalcula.
  `contentDisposition` y `contentId` se conservan aunque v1 no los use: son lo que permitiría
  distinguir una imagen inline (una firma, un logo) de un adjunto real, y **v1 decide tratarlas
  igual**.

### Entrada del Mapa de Tickets

- **Atributos clave:** `slug` (string, req, **único**, siempre en minúsculas), `projectId` (int,
  req — un id de `projects` de Jiku)
- **Relaciones:** ninguna. Es una tabla plana de configuración
- **Notas:** **Es configuración, no dato de negocio**, pero desde REQ-005 **deja de ser
  configuración leída al arrancar y pasa a ser un registro de un bucket KV de NATS**: la carga U-02
  con el CLI de NATS (`nats kv put`), y el conector la lee con `watch()` manteniendo una copia en
  memoria que el servidor actualiza solo — **agregar un proyecto ya no requiere redesplegar**. La
  **unicidad del `slug` la garantiza el almacén**, no una validación propia, así que **un mapa mal
  formado deja de ser un modo de falla posible**. Se conserva que un mapa **vacío es válido** (el
  conector arranca y descarta todo) y que el `projectId` **no se valida contra Jiku**: si apunta a un
  proyecto inexistente, el síntoma es un `project_not_found` por mail. Si el bucket **no existe** al
  arrancar, el conector **no arranca** y no lo crea.

### Entrada del Mapa de Hilos

- **Atributos clave:** `messageIdHash` (string sha256 **en hex**, req, **único** — la clave del
  bucket; el `Message-Id` crudo **no es clave válida** de NATS KV, cuyo `validKeyRe` es
  `/^[-/=.\w]+$/` y rechaza `<`, `>` y `@`), `requirementId` (int, req — un id de `requirements`
  de Jiku)
- **Relaciones:** ninguna en el conector. Apunta a un Requisito de Jiku **sin FK real**
- **Notas:** **Es la primera entidad que el conector escribe y que sobrevive al tick** — hasta
  REQ-005 todas sus entidades eran efímeras o de configuración. Se escribe al crear un Requisito
  desde un mail nuevo **y también** al comentar con éxito desde una respuesta: **una entrada por
  cada mail del hilo**, para que una respuesta a la respuesta rutee aunque el cliente recorte la
  cadena de `References`. **TTL de 90 días**; una entrada expirada degrada a `hilo_desconocido`, que
  es la falla segura. **No participa de la idempotencia**: el `\Seen` de IMAP sigue siendo la única
  marca. El hash se elige sobre normalizar y escapar a mano porque dos `Message-Id` distintos
  podrían colapsar a la misma clave y rutear un comentario al requisito equivocado (viola G-04); el
  costo aceptado es que la clave **no es legible** con `nats kv ls`.

### Comentario *(entidad de Jiku)*

- **Atributos que el conector escribe:** `comment` (string, req — el cuerpo de la respuesta más los
  avisos y placeholders de sus adjuntos), `visibilityLevel` (enum: `public`/`internal` — el conector
  manda **`'public'` explícito**), `fileIds` (int[], opt, max 10 — los archivos de la respuesta)
- **Atributos que el conector NO toca:** `author` (opcional en el schema; `core` resuelve el actor
  del subject)
- **Relaciones:** belongs_to Requisito (req, por el `{id}` del subject), has_many Adjunto (por los
  `fileIds`)
- **Notas:** **El default del contrato es `internal`, el opuesto del que hace falta** — un
  comentario `internal` no lo vería el cliente en Opus—, así que el `'public'` explícito es una
  regla y no un adorno. El Requisito del hilo **no se modifica** al comentar: el comentario es una
  entidad aparte y la regla 9 sigue valiendo. Sus `x-error-codes` incluyen `requirement_not_found`
  (el requisito se borró en Jiku) y `file_not_owned`.

### Requisito *(entidad de Jiku)*

- **Atributos que el conector escribe:** `title` (string, req, **max 255** — el asunto, truncado por
  el conector), `description` (text, req — el cuerpo más los avisos y los placeholders), `projectId`
  (int, req — del Mapa de Tickets), `type` (enum:
  `funcionalidad`/`mejora`/`incidencia`/`otro`, default del conector: **`incidencia`**), `priority`
  (enum: `sin_prioridad`/`baja`/`media`/`alta`/`urgente`, default `sin_prioridad`),
  `visibilityLevel` (enum: `public`/`internal`, default `public`), `creator` (string — el `sub` del
  caller, **que `core` resuelve del subject e ignora lo que se declare**)
- **Atributos que el conector NO toca:** `state` (nace en `analisis`, que es el default de Jiku),
  `scope`, `technicalSolution`, `acceptanceCriteria`, `estimatedFinishDate`, `tags`,
  `responsiblePersonIds`, y los cuatro timestamps de transición
- **Relaciones:** belongs_to Proyecto (req), has_many Adjunto (por los `fileIds`)
- **Notas:** **El conector lo crea y nunca lo modifica.** No hay comando de compensación: si el alta
  salió bien y el vínculo de un adjunto falló, el requisito queda con el aviso en la descripción y
  así se queda. `visibilityLevel: 'public'` significa *"visible para usuarios externos
  autenticados"* — es lo que hace que el cliente vea su ticket en Opus, y **no** habilita acceso
  anónimo a nada. Dominio completo en el PRD de Jiku.

### Archivo *(entidad de Jiku)*

- **Atributos que el conector declara:** `fileName` (string, req, max 255), `mimeType` (string, req,
  max 100), `fileSize` (int, req, ≥ 1), `checksum` (string sha256, opt)
- **Atributos que decide `core` y el conector nunca elige:** `storageKey`, `storageBucket`,
  `storageRegion`, `byteStatus`, `uploadedBy`, `retentionStatus`
- **Relaciones:** has_many Adjunto (**0..N** — un archivo puede no estar vinculado a nada, y
  *(REQ-006)* también puede tener **N vínculos vivos por diseño**: ver Notas)
- **Notas:** **Quien sube no elige dónde se guarda** — `core` construye la clave. El conector recibe
  el `id` y una URL prefirmada, y hace el `PUT` del byte directo al storage: **el byte nunca viaja
  por el bus** (el `max_payload` es 1 MB y los adjuntos llegan a 10 MB). `uploadedBy` queda con el
  `sub` del caller, resuelto por `core`, y es **lo que hace que la titularidad se cumpla por
  construcción**. Un archivo huérfano —subido y nunca vinculado— es un estado válido y nadie lo
  limpia.

  **El `0..N` se extiende en el otro sentido** *(REQ-006)*: a partir del dedup contra el hilo, el
  conector **crea vínculos nuevos sobre un Archivo que no subió en este tick**, así que un mismo
  Archivo pasa a tener **N vínculos vivos por diseño y no por accidente** — uno por el mail original
  y uno por cada respuesta que arrastró el mismo byte. La titularidad sigue cumpliéndose por
  construcción, y ahora está garantizada **también en la lectura**: la consulta de reuso filtra por
  `uploadedBy` con la identidad propia, así que el `fileId` reusado es siempre vinculable y nunca
  produce un `file_not_owned`.

### Adjunto *(entidad de Jiku)*

- **Atributos:** `entityType` (string, req — para el conector siempre `requirement`), `entityId`
  (int, req), `fileId` (int, req)
- **Relaciones:** belongs_to Archivo (FK real), vínculo **polimórfico** hacia la entidad
- **Notas:** **El conector no lo crea nunca directamente.** Lo crea `core` en la misma transacción
  del alta del Requisito, a partir de los `fileIds`. El conector no conoce su `id` ni lo necesita.

---

### Ciclos de Vida y Estados

#### Mail Entrante — el ciclo de vida central del conector

Es el único ciclo de vida propio, y **el estado no se persiste**: es la posición del mail en el
recorrido de un tick. Aun así importa modelarlo, porque **cada estado terminal tiene una
consecuencia distinta** y es lo que define el comportamiento del conector.

| Estado | Cuándo | Transiciones permitidas | Prohibidas |
|---|---|---|---|
| `sin_leer` | Está en la casilla, `\Unseen` | → `en_proceso` | — |
| `en_proceso` | El tick lo tomó y lo marcó `\Seen` | → `descartado`, `publicado`, `fallido` | → `sin_leer` (**el `\Seen` no se revierte**) |
| `descartado` | Sin slug, slug no mapeado, hilo desconocido, no se pudo parsear, o el lookup del hilo no se pudo hacer | (terminal) | → cualquiera |
| `publicado` | El comando de alta **o el de comentario** respondió `success` (REQ-005) | (terminal) | → cualquiera |
| `fallido` | El comando falló o expiró | (terminal) | → cualquiera. **No hay reintento** |

**Las dos transiciones que definen el conector, y las dos son pérdidas asumidas:**

- **`en_proceso` → `fallido` es definitivo.** El mail ya está `\Seen` y no hay reintento: el ticket
  se perdió y el único rastro es el log.
- **`en_proceso` no se revierte a `sin_leer`.** Si el proceso muere entre el comando exitoso y el
  `\Seen`, el próximo tick lo reprocesa y **crea un Requisito duplicado**.

**Lo que REQ-005 cambia en este ciclo, y no es sólo un motivo más:** `publicado` deja de significar
únicamente *"se creó un Requisito"* y pasa a cubrir también *"se publicó un comentario"*. La
transición `en_proceso → descartado` gana el motivo `hilo_desconocido`, y si el proceso muere después
del `\Seen` pero antes de escribir la entrada del hilo, **ese hilo queda sin ruteo** — el `\Seen`
sigue siendo la única marca y el KV no se aprovecha para idempotencia.

#### Adjunto del Mail

| Estado | Cuándo | Transiciones permitidas | Prohibidas |
|---|---|---|---|
| `pendiente` | Recién parseado del mail | → `aceptado`, `rechazado` | — |
| `rechazado` | Falla la política local, o `core` la rechaza | (terminal) → deja **aviso** en la descripción | → `aceptado` |
| `aceptado` | Pasa la política y está dentro del tope de 10 | → `subido`, `duplicado`, `reusado`, `fallido` | — |
| `duplicado` | Su checksum ya apareció en el mismo mail | (terminal) → **no deja aviso ni placeholder** | → `subido` |
| `reusado` | Su checksum ya estaba **vinculado al Requisito del hilo** y lo subió el conector (REQ-006) | → `vinculado`, `fallido` | → `subido`. **No gastó `files.request-upload` ni `PUT`** |
| `subido` | El `PUT` a la URL prefirmada respondió OK | → `vinculado`, `huerfano` | — |
| `fallido` | El `PUT` o el pedido de permiso falló | (terminal) → deja **aviso** en la descripción | → `subido` |
| `vinculado` | El alta del Requisito con su `fileId` fue `success` | (terminal) | — |
| `huerfano` | Se subió pero el alta del Requisito falló | (terminal) | → `vinculado`. **Nadie lo limpia** |

**`duplicado` y `rechazado` son estados distintos a propósito, y confundirlos sería un bug**: un
rechazado le avisa al cliente que su archivo no entró; un duplicado es el **mismo** archivo que ya
entró, así que avisar sería ruido y contar el placeholder dos veces sería mentira.

**`reusado` es el cuarto estado que no hay que confundir con ninguno de los tres** (REQ-006), y cada
contraste es un bug distinto si se pierde:

- **contra `subido`:** el `reusado` **no gastó** un `files.request-upload` ni un `PUT`, así que **no
  creó fila en `files` ni objeto en el storage**. Tratarlo como subido haría creer que hay un archivo
  nuevo que no existe.
- **contra `duplicado`:** el `reusado` **sí deja placeholder** y **sí entra en los `fileIds`** — el
  archivo del cliente llega al hilo. El `duplicado` no deja nada y no se vincula. Tratarlo como
  duplicado le sacaría al cliente un adjunto que sí tiene.
- **contra `rechazado`:** el `reusado` **no deja aviso**, porque no es una falla. Avisar de un reuso
  sería el mismo ruido que la regla 12 evita para el duplicado intra-mail.

Su transición terminal la decide el comentario (o el alta): `reusado → vinculado` con `success`, y
`reusado → fallido` si la escritura falla. **Un `reusado` nunca llega a `huerfano`**, y es la única
mejora de este estado sobre la ventana de huérfanos de ADR-003: el archivo ya estaba vinculado a otra
cosa antes de esta escritura, así que un fallo no lo deja sin vínculo.

---

### Invariantes y Reglas de Negocio

1. **Mail Entrante** — Un mail sin `messageId` no se procesa. Es el único campo obligatorio de la
   normalización.
2. **Mail Entrante** *(reformulada en REQ-005)* — Un mail con `referenceIds` no vacío **se comenta
   en el Requisito de su hilo si alguna referencia matchea el Mapa de Hilos, y se descarta como
   `hilo_desconocido` si ninguna matchea**. El propósito original se conserva intacto: **sin match no
   se crea nada**, así que la respuesta de un cliente nunca produce un Requisito duplicado. La regla
   pasa de un descarte incondicional a un descarte por falla segura.
3. **Mail Entrante** — Un mail que no resuelve a un proyecto **no crea nada**. Crear un Requisito en
   el proyecto equivocado lo haría visible a un cliente que no debía verlo, y eso rompe el
   aislamiento del portal de Jiku. El descarte es la falla segura.
4. **Slug** — Se compara **siempre en minúsculas**, en las dos puntas del mapa.
5. **Mapa de Tickets** *(reformulada en REQ-005)* — Un `slug` es único, y **la unicidad la garantiza
   el almacén**: un bucket KV no admite dos entradas con la misma clave, así que "mapa mal formado
   por slug duplicado" deja de ser un modo de falla posible. Lo que sí falla al arrancar es que el
   **bucket no exista**.
6. **Requisito** — Nace siempre en `analisis`: el conector no manda `state`.
7. **Requisito** — `title` se trunca a 255 caracteres **antes de publicar**. El contrato del comando
   no declara un `maxLength`, así que un asunto largo llegaría a `core` y fallaría en la base con un
   error genérico; truncar del lado del emisor convierte un fallo opaco en una pérdida de
   información visible.
8. **Requisito** — `title` y `description` nunca quedan vacíos: si el mail los trae vacíos, se usan
   los placeholders configurados. Los dos son `req` en Jiku.
9. **Requisito** — Un Requisito creado **no se modifica nunca**. No hay comando de compensación en
   el conector. **Comentar no lo modifica** (REQ-005): el Comentario es una entidad aparte y esta
   regla sigue valiendo entera.
10. **Adjunto del Mail** — La política autoritativa es la de **`core`**, que lee la doble lista
    blanca —extensión **y** MIME— en caliente. La del conector es una **conveniencia** y puede
    quedar desalineada: si lo está, `core` rechaza y el conector anota el aviso.
11. **Adjunto del Mail** — A lo sumo **10** por Requisito. Es el `maxItems` del contrato del bus, no
    un límite de transporte: es una regla de dominio.
12. **Adjunto del Mail** — Dos adjuntos con el mismo checksum en el mismo mail **se colapsan a
    uno**, y el colapsado no deja aviso ni placeholder. **Y** *(REQ-006)* un adjunto de una
    **respuesta al hilo** cuyo checksum ya está vinculado al Requisito del hilo **y fue subido por el
    conector** se **reusa** en vez de subirse. El reuso, **al contrario del colapso intra-mail**, sí
    deja placeholder y sí se vincula: el archivo del cliente llega al hilo, apuntando al `fileId` que
    ya existía. Los dos dedups **conviven y el intra-mail va primero** — colapsa las repeticiones
    dentro de la respuesta, y recién entonces se consulta una vez por checksum sobreviviente.
13. **Adjunto del Mail** — El fallo de un adjunto **nunca cancela el Requisito**. Abortar
    convertiría un archivo corrupto en un ticket perdido, y el ticket es el activo.
14. **Archivo** — El conector **no elige la clave de storage**: la construye `core`. Un conector que
    armara su propia clave rompería la garantía de que el storage tiene un solo dueño.
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
22. **Observabilidad** — No se loguean nunca: credenciales, tráfico IMAP crudo, el cuerpo del mail,
    el contenido de un adjunto **ni el texto de un comentario** (REQ-005). En un servicio sin nadie
    mirando, el log es el único rastro de un ticket perdido — pero sigue siendo un log, no un
    depósito de datos del cliente.
23. **Mapa de Hilos** *(REQ-005)* — La clave es el **sha256 en hex del `Message-Id` crudo**, nunca el
    `Message-Id` normalizado o escapado: dos `Message-Id` distintos que colapsaran a la misma clave
    rutearían un comentario al requisito equivocado.
24. **Mapa de Hilos** *(REQ-005)* — Se escribe una entrada por **cada mail del hilo**: al crear el
    Requisito desde el mail nuevo, y al comentar con éxito desde cada respuesta. Si el comentario
    falla, **no se escribe** la entrada de esa respuesta.
25. **Comentario** *(REQ-005)* — Se publica **siempre** con `visibilityLevel: 'public'` explícito. El
    default del contrato de `core` es `internal`, y un comentario `internal` no lo vería el cliente
    en Opus.
26. **Mail Entrante** *(REQ-005)* — Una respuesta con match en el hilo **se comenta sin evaluar el
    slug**: el `requirementId` del KV ya resuelve el destino, y exigir un subaddress válido rompería
    el caso real del cliente que responde sin conservarlo.
27. **Tick** *(REQ-005)* — Un fallo del write al Mapa de Hilos **nunca cancela el alta**: se loguea y
    la consecuencia asumida es que ese hilo no va a rutear después. Convertir una falla de KV en un
    ticket perdido sería lo contrario de la regla 13 ("el ticket es el activo").
28. **Caller** *(REQ-006)* — El conector **puede** publicar en el plano de consultas
    (`jiku-queries.*`), y el **único caso habilitado en v1** es la consulta de reuso de adjuntos
    (`attachments.list` filtrando por `entityType`, `entityId`, `checksum` y `uploadedBy`). Es una
    habilitación **puntual y enumerada, no un plano abierto**: el alta sigue sin consultar nada antes
    de crear (ADR-004), y el comentario sigue sin consultar el Requisito antes de comentar. Deroga la
    Implementation Rule de ADR-003 (*"MUST NOT publicar en el plano de consultas"*), completando la
    derogación que REQ-005 dejó a medias — allí se derogó *"sólo escribe"* como restricción de
    diseño, pero la regla de la ADR nunca se reescribió. **Suscribirse a subjects de otros servicios
    sigue prohibido**: eso no se derogó.
29. **Adjunto del Mail** *(REQ-006)* — Un fallo de la consulta de reuso **nunca cuesta un adjunto ni
    un ticket**: se loguea con su motivo y el adjunto **se sube como hoy**. Es la misma forma que la
    regla 27 le dio al fallo del write del Mapa de Hilos, y por la misma razón de la regla 13 — el
    ticket es el activo, y una **optimización** no puede costar un archivo que el código actual sí
    entrega. El peor caso del fallo es el duplicado que ya existía antes de REQ-006.

---

## Core Features

> **Nota sobre la columna `Actor`.** El conector es un worker sin interfaz: en casi todas las
> capabilities el actor es **el conector mismo** —el `Tick` que corre, o el `Caller` que publica en
> el bus—, no una persona. Los usuarios de `goals-and-context.md` aparecen así: **U-01 (Cliente
> externo)** dispara el flujo mandando el mail y nunca opera nada; **U-02 (Operador)** es el actor
> de las capabilities de configuración y el único destinatario de los logs; **U-03 (Equipo interno)**
> no es actor de ninguna capability — consume el Requisito ya creado, en Jiku.

### F-01: Ingesta y normalización del mail

**Description:** Traer los mails nuevos de la casilla de tickets y dejarlos en una forma normalizada,
sin decidir nada sobre ellos todavía. Es la única feature que **se conserva casi intacta** del
servicio existente: el dominio del mail no cambia porque cambie la arquitectura de escritura.

**User Story:**
Como Cliente externo (U-01),
quiero mandar un mail a la casilla de tickets como siempre lo hice,
para que mi pedido entre al sistema sin que yo tenga que aprender un portal.

**Capabilities:**

| ID | Capability | Actor | Entity | Operation | Key Fields | Business Rules |
|----|-----------|-------|--------|-----------|------------|----------------|
| C-01 | Disparar el tick del poll | Tick (cron) | — | ACTION | `cron` (string, default `*/5 * * * *`), `pollEnabled` (bool, default `true`) | **No se solapa**: si un tick está en curso, el nuevo se saltea con warn. Con `pollEnabled: false` el worker queda vivo sin schedular nada |
| C-02 | Conectar a IMAP y tomar el lock de la carpeta | Tick | — | ACTION | `host` (string, req), `port` (int, default `993`), `folder` (string, fijo `INBOX` en v1) | TLS siempre. Credenciales u host incorrectos hacen fallar el tick completo con log de error; **el worker sigue vivo** y reintenta en el próximo |
| C-03 | Buscar los mails no vistos y aplicar el cap | Tick | Mail Entrante | READ | `maxPerTick` (int, default `50`, ≥ 1) | Sólo `\Unseen`. Ordena los UIDs **de más nuevo a más viejo** y toma los primeros N: un backlog grande se drena en varios ticks y el pedido más reciente no espera detrás de mil viejos. Si había más, warn con cuántos quedaron diferidos |
| C-04 | Descargar el mensaje crudo y marcarlo `\Seen` | Tick | Mail Entrante | UPDATE | — | El marcado `\Seen` es **lo único que evita reprocesar** (no hay estado propio). Si el mensaje no se puede descargar se saltea con warn y **no se marca `\Seen`**, así que el próximo tick lo reintenta |
| C-05 | Normalizar el mail a la forma de trabajo | Tick | Mail Entrante | CREATE (en memoria) | `messageId` (string, **req**), `referenceIds` (string[], opt), `recipient` (string, opt), `senderEmail` (string, opt), `subject` (string, opt), `body` (string, opt), `attachments` (Adjunto del Mail[], opt) | `messageId` es el único obligatorio: sin él se descarta con warn. `referenceIds` = unión ordenada y deduplicada de `In-Reply-To` + `References`. `recipient` = `Delivered-To` con `To` como fallback (es el header que **conserva el subaddress real**). `subject` sin `Re:`/`Fwd:`/`RV:` quitados **iterativamente** y sin distinguir mayúsculas. `body` en texto plano, **recortando el texto citado** del hilo |
| C-06 | Convertir un mail sólo-HTML a texto plano | Tick | Mail Entrante | ACTION | — | Preserva saltos, ignora `href`, saltea `img`. **No es un error**. Un mail sin texto ni HTML deja `body` vacío, que F-03 reemplaza por el placeholder |
| C-07 | Parsear los adjuntos de las partes MIME | Tick | Adjunto del Mail | CREATE (en memoria) | `filename` (string, req), `mimeType` (string, req — **declarado, no verificado**), `size` (int, req), `content` (bytes, req), `contentDisposition` (enum: `inline`/`attachment`, opt), `contentId` (string, opt) | Se conservan `contentDisposition` y `contentId` aunque v1 no los use. Una imagen inline (firma, logo) **se trata como adjunto normal en v1** |
| C-08 | Contabilizar y loguear el resultado del tick | Tick | — | ACTION | métricas: `ingestados`, `parseados`, `creados`, `descartados`, `fallidos` | **Un mail que no se puede parsear no aborta el lote**: se cuenta como fallido, se loguea con su `Message-Id`, y el tick sigue. Un fallo del tick completo **no tumba el worker**. Nunca se loguean credenciales, tráfico IMAP crudo ni el cuerpo del mail |

**Acceptance Criteria:**

- DADO que la casilla tiene 60 mails `\Unseen` y `maxPerTick` es 50
  CUANDO corre el tick
  ENTONCES procesa los 50 **más nuevos**, los marca `\Seen`
  Y loguea un warn diciendo que 10 quedaron diferidos
  Y los 10 restantes siguen `\Unseen` para el próximo tick

- DADO un mail con asunto `Re: Re: Fwd: Falla en el login`
  CUANDO se normaliza
  ENTONCES `subject` queda `Falla en el login` (los tres prefijos quitados iterativamente)

- DADO un mail sin header `Message-Id`
  CUANDO se normaliza
  ENTONCES se descarta con warn y no se procesa

- DADO un mail cuyo cuerpo es sólo HTML con un `<img src="logo.png">` y un `<a href="http://x">acá</a>`
  CUANDO se normaliza
  ENTONCES `body` es texto plano con la palabra `acá` sin la URL, sin el `img`, y con los saltos preservados

- DADO que el tick de las 10:00 todavía está corriendo
  CUANDO el cron dispara el tick de las 10:05
  ENTONCES el de las 10:05 se saltea con warn y no se solapa

- DADO que las credenciales IMAP son incorrectas
  CUANDO corre el tick
  ENTONCES el tick falla completo con log de error, **sin loguear las credenciales**
  Y el worker sigue vivo y reintenta a las 10:05

**Priority:** High

**Dependencies:** None

---

### F-02: Resolución del destino

**Description:** Decidir **a qué proyecto de Jiku va** el mail, o descartarlo. Es la feature que más
cambia respecto del servicio existente: hoy resuelve con un `SELECT ... WHERE ticket_slug = ?`
contra la base; acá no hay base.

**User Story:**
Como Operador del conector (U-02),
quiero mapear cada slug de la casilla a un proyecto de Jiku,
para que el pedido de cada cliente aterrice en su proyecto y en ningún otro.

**Capabilities:**

| ID | Capability | Actor | Entity | Operation | Key Fields | Business Rules |
|----|-----------|-------|--------|-----------|------------|----------------|
| C-09 | Cargar el Mapa de Tickets al arrancar | U-02 (Operador) | Entrada del Mapa de Tickets | CREATE | `slug` (string, req, **único**, minúsculas), `projectId` (int, req) | Por variable de entorno o archivo montado. Se lee **al arrancar**; sin recarga en caliente en v1. Un mapa **vacío es válido** (arranca y descarta todo con log); un mapa **mal formado hace fail-fast** y el worker no arranca. Dos entradas con el mismo slug = mal formado |
| C-10 | Extraer el slug del subaddress | Tick | Mail Entrante | READ | `recipient` (string), `subaddressPrefix` (string, default `tickets`) | Aísla el email si viene como `Nombre <mail@dominio>`, matchea `^<prefijo>\+([^@]+)@` **sin distinguir mayúsculas**, y normaliza el slug **a minúsculas**. Sin match → descarte silencioso. Resuelve por `Delivered-To`, que es **uno solo**: varios destinatarios con slugs distintos no son ambiguos |
| C-11 | Resolver el slug a un `projectId` | Tick | Entrada del Mapa de Tickets | READ | `slug` (string, minúsculas) | Compara **siempre en minúsculas en las dos puntas**: `TICKETS+Alfa@` y `tickets+alfa@` resuelven al mismo proyecto. Sin entrada → descarte silencioso con log **nombrando el slug buscado** (es el dato que hace falta para cargarlo). **El conector no valida que el proyecto exista**: publica el `projectId` y `core` valida por su cuenta |
| C-12 | Descartar una respuesta a un hilo | Tick | Mail Entrante | ACTION | `referenceIds` (string[]) | Si `referenceIds` **no está vacío**, se descarta con log explícito de "respuesta, fuera de alcance v1". **Es un descarte activo, no una omisión**: sin esta regla una respuesta del cliente crearía un Requisito nuevo duplicado en vez de un comentario |
| C-13 | Descartar en silencio lo que no resuelve | Tick | Mail Entrante | ACTION | motivo (enum: `sin_slug`/`slug_no_mapeado`/`es_respuesta`/`sin_message_id`/`no_parseable`) | **El descarte es la respuesta correcta, no un error**: la casilla recibe spam, respuestas automáticas y mails a direcciones sin slug. Cada descarte deja **una** línea de log con el `Message-Id` y el motivo, y nada más. **No crea nada**: un Requisito en el proyecto equivocado sería visible a un cliente que no debía verlo |

**Acceptance Criteria:**

- DADO que el mapa tiene la entrada `alfa → 42`
  CUANDO llega un mail con `Delivered-To: TICKETS+Alfa@grava.io`
  ENTONCES resuelve al `projectId` 42 (comparación en minúsculas en las dos puntas)

- DADO que el mapa **no** tiene la entrada `beta`
  CUANDO llega un mail a `tickets+beta@grava.io`
  ENTONCES se descarta con log que **nombra el slug `beta`**, y no se crea nada

- DADO un mail a `soporte@grava.io` (sin `+slug`)
  CUANDO se intenta resolver
  ENTONCES descarte silencioso con log, sin crear nada

- DADO un mail con `In-Reply-To: <abc@grava.io>` a `tickets+alfa@grava.io` (slug válido y mapeado)
  CUANDO se intenta resolver
  ENTONCES se descarta con log de "respuesta, fuera de alcance v1"
  Y **no** se crea un Requisito duplicado

- DADO el mapa vacío
  CUANDO arranca el worker
  ENTONCES arranca correctamente, y descarta todos los mails con log

- DADO un mapa con dos entradas para el slug `alfa`
  CUANDO arranca el worker
  ENTONCES **no arranca** (fail-fast) e informa que el mapa está mal formado

**Priority:** High

**Dependencies:** F-01

---

### F-03: Alta del requisito en Jiku

**Description:** Publicar el comando que crea el requisito, y traducir su respuesta. Es donde el
conector deja de ser un lector de mails y se vuelve un caller del bus de Jiku.

**User Story:**
Como Cliente externo (U-01),
quiero que mi mail aparezca como un pedido en el portal,
para poder seguir su avance como cualquier otro pedido que cargué yo mismo.

**Capabilities:**

| ID | Capability | Actor | Entity | Operation | Key Fields | Business Rules |
|----|-----------|-------|--------|-----------|------------|----------------|
| C-14 | Construir la identidad y conectar al bus | Caller | — | ACTION | `JIKU_INSTANCE` (string, default `dev`), `JIKU_SERVERS` (string, default `nats://localhost:4222`), `JIKU_CREDS` (string, **req**), `JIKU_KEY_FILE` (string, **req**), `JIKU_ISSUER` (string, default `https://id.grava.io`), `JIKU_PROJECT_ID` (string, **req**) | **Al arrancar, una sola vez** con `ServiceUser.fromKeyFile()` y **un solo `connect()`**, conservado por toda la vida del proceso: conectar cuesta un round-trip a Zitadel más el handshake que corre el auth-callout. El `user-id` del subject **sale de la key**, nunca de una variable. Sin `JIKU_PROJECT_ID` el token no lleva roles y **no conecta a nada**: el error dice sólo `Authorization Violation`. Sin el rol `internal-app` asignado, **la conexión se rechaza** — es un fallo de arranque, no por mail |
| C-15 | Mantener el token fresco | Caller | — | ACTION (auto) | — | Lo hace el SDK en background. Un fallo del refresh **no es fatal pero va al log**: el token actual sigue sirviendo y lo que se rompe es el **próximo reconnect** (el callout evalúa al conectar y NATS no revalida) |
| C-16 | Armar el payload del alta | Caller | Requisito | CREATE | `title` (string, req, **truncado a 255**), `description` (text, req), `projectId` (int, req), `type` (enum: `funcionalidad`/`mejora`/`incidencia`/`otro`, default **`incidencia`**), `priority` (enum: `sin_prioridad`/`baja`/`media`/`alta`/`urgente`, default `sin_prioridad`), `visibilityLevel` (enum: `public`/`internal`, default `public`), `creator` (string), `fileIds` (int[], opt, **maxItems 10**) | `title` = asunto limpio o `Ticket recibido por mail` si vino vacío; **se trunca a 255 antes de publicar** porque el contrato no declara `maxLength` y en la base fallaría con un error genérico. `description` = cuerpo o `(mail sin contenido)`, más lo que F-04 anexe. **No manda `state`**: nace en `analisis`. **No manda `actor`**: es la única clave de identidad que el plano de escritura rechaza de plano. Lo que declare en `creator` **se ignora**: `core` resuelve el actor del subject |
| C-17 | Publicar `requirements.new` y esperar la respuesta | Caller | Requisito | CREATE | `JIKU_TIMEOUT` (int, default `15000` ms) | Vía `client.command()` del SDK: **el conector no arma subjects ni parsea envelopes**. **No bajar el timeout del default**: son 15 s a propósito, por encima de los 10 s del servidor, porque PostgreSQL corta a los 8 s y la respuesta llega como un error que se explica — un timeout más corto **convierte esa explicación en silencio** |
| C-18 | Registrar el alta exitosa | Caller | Requisito | ACTION | `messageId`, `projectId`, `id` del requisito | Loguea los tres juntos: es lo que permite reconstruir qué mail se volvió qué requisito |
| C-19 | Traducir el error distinguiendo qué sistema rechazó | Caller | — | ACTION | clase del SDK (`JikuPermissionDenied`/`JikuFailure`/`JikuTimeout`/`JikuNoEndpoint`/`JikuInvalidRequest`), `code`, `hint()` | **Tres sistemas distintos pueden rechazar, con arreglos distintos**, y el log tiene que decir cuál: el **bus** por subject (`JikuPermissionDenied` → problema de Zitadel, no del payload), **`core` por rol** (`caller_not_authorized` → típicamente sin fila en `users`), **`core` por forma** (`invalid_fields` → payload mal armado, y prueba de que el plano sí está abierto). **No reintenta**: un `failure` o timeout es definitivo y el mail ya está `\Seen`. Un `errorCode` desconocido se loguea con su `code` y su `hint()` y **no se mapea a nada**: el conector no tiene a quién responderle |

**Acceptance Criteria:**

- DADO un mail con asunto `Falla en el login`, cuerpo `No puedo entrar`, resuelto al `projectId` 42
  CUANDO se publica el alta
  ENTONCES se crea un Requisito con `title: "Falla en el login"`, `type: incidencia`,
  `priority: sin_prioridad`, `visibilityLevel: public`, `state: analisis`
  Y se loguea el `Message-Id`, el `projectId` 42 y el `id` del requisito creado

- DADO un mail con el asunto vacío y el cuerpo vacío, sin adjuntos
  CUANDO se publica el alta
  ENTONCES `title` es `Ticket recibido por mail` y `description` es `(mail sin contenido)`

- DADO un mail con un asunto de 400 caracteres
  CUANDO se arma el payload
  ENTONCES `title` se trunca a 255 **antes de publicar**, y no falla en la base

- DADO que el `projectId` 999 del mapa no existe en Jiku
  CUANDO se publica el alta
  ENTONCES `core` responde `project_not_found`, se loguea con el `projectId` 999
  Y el mail queda perdido (ya está `\Seen`), **sin reintento**

- DADO que el conector recién se desplegó y todavía no tiene fila en `users`
  CUANDO publica el alta
  ENTONCES falla con `JikuFailure` / `caller_not_authorized`
  Y el log dice que **`core` rechazó por rol**, no que el payload esté mal

- DADO que `core` está caído
  CUANDO se publica el alta
  ENTONCES a los 15 s da `JikuTimeout`, se loguea, y **el mail se pierde sin reintento**

- DADO que falta `JIKU_PROJECT_ID`
  CUANDO arranca el worker
  ENTONCES no arranca (fail-fast), en vez de fallar después con un `Authorization Violation` opaco

**Priority:** High

**Dependencies:** F-01, F-02

---

### F-04: Adjuntos

**Description:** Que los archivos del mail terminen vinculados al requisito. Es la feature donde la
arquitectura de Jiku cambia más el **cómo** sin cambiar el **qué**: hoy es un upload y un INSERT;
acá son tres planos separados.

**User Story:**
Como Cliente externo (U-01),
quiero adjuntar la captura de pantalla de mi error al mail,
para que el equipo vea el problema sin que yo tenga que describirlo.

**Capabilities:**

| ID | Capability | Actor | Entity | Operation | Key Fields | Business Rules |
|----|-----------|-------|--------|-----------|------------|----------------|
| C-20 | Particionar los adjuntos por la política local | Caller | Adjunto del Mail | ACTION | `allowedExtensions` (string[]), `maxFileSize` (int) | **La política autoritativa es la de `core`**, que lee la doble lista blanca —extensión **y** MIME— en caliente de `system_settings`. La local es una **conveniencia** para no gastar un round-trip en un `.exe`, y **puede quedar desalineada**. Tamaño 0 o sobre el tope: rechazado. Cada rechazado deja **aviso** en la descripción |
| C-21 | Deduplicar por checksum dentro del mail | Caller | Adjunto del Mail | ACTION | `checksum` (string sha256, calculado por el conector) | Dos adjuntos idénticos **se colapsan a uno**. Un colapsado **no es un rechazo**: no suma aviso ni placeholder. Confundir `duplicado` con `rechazado` sería un bug — avisar de un duplicado sería ruido, y contar su placeholder dos veces sería mentira. **Se conserva sin cambios y corre PRIMERO**, antes de C-21b *(REQ-006)*: colapsar antes de consultar evita gastar consultas por un archivo que igual se iba a colapsar |
| C-21b | Deduplicar contra el hilo por checksum *(REQ-006)* | Caller | Adjunto (de Jiku) | READ | `entityType` (`'requirement'`), `entityId` (int — el `requirementId` del Mapa de Hilos), `checksum` (string sha256), `uploadedBy` (string — el `sub` propio); `include: [checksum]` | **La primera y única consulta del conector al plano de lectura** (`attachments.list`), y **sólo en la rama de la respuesta**: un mail nuevo no tiene hilo contra el que deduplicar y no consulta nada. Con match: **no** se pide permiso (C-22) y **no** se sube el byte (C-23) — se reusa el `fileId` y se emite su placeholder normalmente, **sin aviso de reuso**. Sin match (`items: []`): el ciclo actual completo. **Los cuatro filtros son obligatorios y por razones distintas**: `entityId` es lo que impide cruzar un archivo entre dos clientes (G-04), y `uploadedBy` es lo que garantiza que el `fileId` sea vinculable y nunca produzca `file_not_owned`. **Un fallo de la consulta degrada a subir** (regla 29), nunca cuesta un adjunto |
| C-22 | Pedir permiso de subida | Caller | Archivo | CREATE | `fileName` (string, req, max 255), `mimeType` (string, req, max 100), `fileSize` (int, req, ≥ 1), `checksum` (string sha256, opt) | Vía `files.request-upload`. `core` valida la doble lista blanca, crea la fila de `files` con el byte sin verificar, **construye la clave** —el conector **no elige dónde se guarda**— y devuelve el `fileId` y una URL prefirmada de `PutObject`. Si responde `failure` (`file_type_not_allowed`, `file_too_large`), el archivo se saltea con aviso y **el requisito se crea sin él**. **Precondición nueva** *(REQ-006)*: en la rama de la respuesta, este paso corre **sólo si C-21b no encontró match** — con match no se publica el comando y no se crea fila en `files` |
| C-23 | Subir el byte a la URL prefirmada | Caller | Archivo | ACTION | timeout del `PUT` (int, default `30000` ms) | **`PUT` directo al storage, no por el bus**: el `max_payload` de NATS es 1 MB y los adjuntos llegan a 10 MB — no es una optimización, es la única forma. **Sin credenciales de S3**: sólo la URL que `core` firmó. **No hace falta CORS**: lo hace un proceso de servidor, no un navegador. Si el `PUT` falla, el archivo se saltea con warn y aviso, y **el requisito se crea igual**. **Con un reuso de C-21b este paso no corre**: es el ahorro concreto — un objeto de menos en el storage por respuesta *(REQ-006)* |
| C-24 | Aplicar el tope de 10 archivos | Caller | Archivo | ACTION | `fileIds` (int[], **maxItems 10**) | **Es el `maxItems` del contrato, no un límite de transporte**: es una regla de dominio y **no es configurable**. Un mail con 15 adjuntos aceptables sube los primeros 10 y anota los otros 5 como no adjuntados. **Un `fileId` reusado consume cupo igual que uno nuevo** *(REQ-006)*: el `maxItems` es del contrato y no distingue el origen. El tope se aplica **antes** de C-21b, así que no se paga una consulta por un excedente |
| C-25 | Vincular los archivos al requisito | Caller | Adjunto (de Jiku) | CREATE | `fileIds` (int[], opt) | Se pasan en el alta (C-16). `core` crea el Requisito y, **en la misma transacción**, valida la titularidad de cada archivo e inserta un vínculo por cada uno. **La titularidad se cumple por construcción**: `core` resuelve el actor del subject —infalsificable— e ignora lo que el conector declare, así que `uploaded_by == actor` se satisface sin que el conector haga nada. **El conector nunca crea el Adjunto directamente** ni conoce su `id` |
| C-26 | Componer la descripción final | Caller | Requisito | ACTION | — | Orden **determinístico**: cuerpo base, después los avisos de rechazo, después los avisos de fallo de subida, y **los placeholders siempre al final**. **Un fallo de un archivo nunca cancela el Requisito**: abortar convertiría un archivo corrupto en un ticket perdido, y el ticket es el activo |

**Acceptance Criteria:**

- DADO un mail con `captura.png` (2 MB) y `datos.pdf` (1 MB), los dos aceptables
  CUANDO se procesa
  ENTONCES se piden dos permisos de subida, se hacen dos `PUT` directos al storage
  Y el alta se publica con los dos `fileIds`
  Y `core` crea el Requisito y sus dos vínculos **en la misma transacción**

- DADO un mail con `virus.exe`
  CUANDO se aplica la política local
  ENTONCES se rechaza **sin gastar un round-trip al bus**
  Y la descripción del Requisito lleva el aviso del rechazo

- DADO un mail con `captura.png` dos veces, byte por byte idéntica
  CUANDO se procesa
  ENTONCES se colapsa a un solo archivo, se sube una vez
  Y **no hay aviso de duplicado ni placeholder repetido**

- DADO un mail con 15 adjuntos aceptables
  CUANDO se procesa
  ENTONCES se suben los primeros 10 y los otros 5 quedan como aviso en la descripción

- DADO que el `PUT` de `datos.pdf` falla y el de `captura.png` funciona
  CUANDO se publica el alta
  ENTONCES el Requisito **se crea igual**, con `captura.png` vinculada
  Y la descripción lleva el aviso del fallo de `datos.pdf`

- DADO que tres archivos se subieron bien y el `requirements.new` falla con timeout
  CUANDO termina el procesamiento
  ENTONCES las tres filas de `files` quedan **huérfanas, sin vínculo**
  Y eso es un **estado válido**: nadie las limpia

- DADO un mail con cuerpo `No puedo entrar`, un `.exe` rechazado y una `captura.png` subida
  CUANDO se compone la descripción
  ENTONCES el orden es: `No puedo entrar`, después el aviso del `.exe`, y **al final** el placeholder de `captura.png`

**Priority:** High

**Dependencies:** F-01, F-02, F-03

---

### F-05: Configuración, identidad y observabilidad

**Description:** Las preocupaciones transversales del worker. **La observabilidad es la más
importante del conector y merece decirlo sin rodeos:** en Jiku, cuando una escritura falla, hay un
usuario mirando una pantalla que recibe un error. Acá no hay nadie — el cliente mandó un mail y se
fue. **Un ticket perdido no tiene síntoma.** Los logs no son un accesorio de diagnóstico, son el
**único** lugar donde un mail perdido deja rastro.

**User Story:**
Como Operador del conector (U-02),
quiero que el worker falle al arrancar si está mal configurado y que deje rastro de cada mail que no
llegó a destino,
para no descubrir un ticket perdido cuando el cliente reclame.

**Capabilities:**

| ID | Capability | Actor | Entity | Operation | Key Fields | Business Rules |
|----|-----------|-------|--------|-----------|------------|----------------|
| C-27 | Validar la configuración al arrancar | U-02 (Operador) | — | ACTION | todas las `JIKU_*` req, las de IMAP y el Mapa de Tickets | **Fail-fast con la lista completa de lo que falta**, no de a uno: es la diferencia entre *"faltan X, Y y Z"* y descubrir los tres con un deploy cada vez. Punto de lectura **único y tipado**: `process.env` no se lee en ningún otro lugar. Secretos **inyectados por el entorno**, nada horneado en la imagen |
| C-28 | Emitir logs estructurados a stdout | Caller / Tick | — | ACTION | nivel (enum: `debug`/`info`/`warn`/`error`, default `info`) | **stdout, nunca a archivo, JSON en producción.** Jiku tiene los transports de archivo de sus dos backends con `filename: undefined` en producción porque las variables no están en el compose; el conector **no repite el error**. **Un fallo no se le reporta a nadie**: no hay usuario esperando ni request que responder |
| C-29 | No filtrar datos sensibles al log | Caller / Tick | — | ACTION | — | Nunca se loguean: credenciales, tráfico IMAP crudo, **el cuerpo del mail** ni el contenido de un adjunto. El cuerpo es contenido de negocio y puede traer datos del cliente: el log es el único rastro de un ticket perdido, pero **sigue siendo un log, no un depósito de datos del cliente** |
| C-30 | Emitir las métricas del tick | Tick | — | ACTION | `ingestados`, `parseados`, `creados`, `descartados`, `fallidos` | Una línea por tick. Es la única visibilidad agregada del worker: métricas exportadas y healthcheck están **fuera de alcance v1** |

**Acceptance Criteria:**

- DADO que faltan `JIKU_CREDS`, `JIKU_KEY_FILE` y `JIKU_PROJECT_ID`
  CUANDO arranca el worker
  ENTONCES no arranca, e informa **las tres juntas** en un solo mensaje

- DADO un tick que ingestó 10 mails, creó 7 requisitos, descartó 2 y falló 1
  CUANDO termina el tick
  ENTONCES emite una línea de log con los cinco contadores

- DADO un mail cuyo cuerpo dice `mi tarjeta es 4111 1111 1111 1111`
  CUANDO se procesa y se loguea
  ENTONCES el log lleva el `Message-Id` y el resultado, **nunca el cuerpo**

- DADO que el refresh del token falla en background
  CUANDO sigue corriendo el worker
  ENTONCES se loguea como error pero **el worker no muere**: el token actual sigue sirviendo y lo
  que se rompe es el próximo reconnect

**Priority:** High

**Dependencies:** None (F-05 es precondición de F-01 y F-03)

---

## Requerimientos No Funcionales

> **Nota sobre los targets.** Los que salen del discovery son duros (vienen de un contrato, de un
> `engines` floor o de una decisión registrada). Los marcados **(asumido)** no están en el discovery
> y los propongo como orden de magnitud a validar: el discovery declara explícitamente que el
> conector **no instrumenta ninguna métrica hoy**, así que no hay números medidos para citar.

### Performance

| ID | Requirement | Target | Measurement |
|----|------------|--------|-------------|
| NFR-P01 | Latencia de mail a requisito | < 2× el intervalo del poll (< 10 min con el cron default) | Diferencia entre la fecha del mail y el log del alta |
| NFR-P02 | Mails procesados por tick | 50 (default configurable, ≥ 1) | `maxPerTick`; el warn de diferidos indica si hay backlog |
| NFR-P03 | Timeout del comando al bus | **15000 ms — no bajarlo** | Config verificable. Es el default del SDK, por encima de los 10 s del servidor, porque PostgreSQL corta a los 8 s: un timeout más corto **convierte la explicación del error en silencio** |
| NFR-P04 | Timeout del `PUT` al storage | 30000 ms | Config verificable |
| NFR-P05 | Conexiones al bus por proceso | **Exactamente 1**, construida al arrancar | Code review. Conectar cuesta un round-trip a Zitadel más el handshake del auth-callout: una por mail sería absurdo |
| NFR-P06 | Volumen esperado de mails | Decenas por día **(asumido)** | A validar con U-02. El poll cada 5 min alcanza con margen para ese orden |

### Seguridad

| ID | Requirement | Target | Measurement |
|----|------------|--------|-------------|
| NFR-S01 | Conexión IMAP | **TLS siempre**, puerto 993 | Config verificable; no hay opción de texto plano |
| NFR-S02 | Identidad en el bus | Machine user de Zitadel con Access Token Type = **JWT** y rol `internal-app` | Sin el rol, la conexión se rechaza con `Authorization Violation` |
| NFR-S03 | Origen del `user-id` del subject | **La key del machine user** (`auth.userId`), nunca una variable de entorno | Code review. Tiene que coincidir con el `sub` que el auth-callout lee para autorizar |
| NFR-S04 | Credenciales de base y de storage | **Cero**: el conector no tiene cliente de PostgreSQL ni credenciales de S3 | Ausencia de dependencias y de variables en el repo |
| NFR-S05 | Secretos en la imagen | **Ninguno**: todo inyectado por el entorno | Code review del Dockerfile |
| NFR-S06 | Datos sensibles en logs | **Cero** credenciales, tráfico IMAP crudo, cuerpos de mail y contenidos de adjunto | Code review + inspección de logs en un entorno de prueba |
| NFR-S07 | Rotación de la key del machine user | La key JSON de Zitadel **se descarga una sola vez** y sólo se reemplaza por una nueva | Procedimiento de despliegue |
| NFR-S08 | Superficie del rol | `internal-app` concede `commands: ALL` + `queries: ALL` y no recorta filas: **más de lo necesario, aceptado en v1** | Registrado como fuera de alcance; acotarlo exige un rol nuevo (modifica el producto) |
| NFR-S09 | Verificación del remitente | **Ninguna**: cualquiera que conozca `tickets+<slug>@` puede crear un requisito en ese proyecto | Superficie de abuso real, acotada por lo poco adivinable del slug. Pregunta abierta |

### Confiabilidad y Resiliencia

| ID | Requirement | Target | Measurement |
|----|------------|--------|-------------|
| NFR-R01 | Garantía de entrega | **Ninguna, en ninguna de las dos direcciones**: se acepta perder o duplicar un ticket | Decisión registrada. Único mecanismo: el `\Seen` de IMAP |
| NFR-R02 | Estado persistido propio | **Cero**: sin base de datos, sin volumen, sin migraciones | Ausencia de infraestructura de datos en el despliegue |
| NFR-R03 | Reintento de un comando fallido | **Ninguno** en v1 | Un `failure` o timeout es definitivo para ese mail |
| NFR-R04 | Supervivencia del worker | Un fallo de tick, de parseo de un mail o del refresh del token **no tumba el proceso** | Test de integración con fallos inyectados |
| NFR-R05 | Aislamiento de fallos dentro del lote | Un mail que falla **no aborta el tick** | Test: un mail corrupto entre 10 buenos deja 9 creados |
| NFR-R06 | Solapamiento de ticks | **Cero**: un tick en curso hace que el siguiente se saltee | Test con un tick artificialmente lento |
| NFR-R07 | Comportamiento con configuración incompleta | **No arranca** (fail-fast), con la lista completa de lo que falta | Test de arranque por cada variable requerida |
| NFR-R08 | Fallo de un adjunto | **Nunca cancela el requisito** | Test: `PUT` fallido deja el requisito creado con el aviso |

### Escalabilidad

| ID | Requirement | Target | Phase |
|----|------------|--------|-------|
| NFR-SC01 | Adjuntos por requisito | **10** (el `maxItems` del contrato, no configurable) | v1 |
| NFR-SC02 | Tamaño máximo por adjunto | El que declare `system_settings` de Jiku (**hoy 10 MB**) | v1 |
| NFR-SC03 | Instancias del worker | **1**: sin idempotencia ni coordinación, dos instancias sobre la misma casilla duplicarían tickets | v1 |
| NFR-SC04 | Entradas del Mapa de Tickets | Decenas **(asumido)**; un KV en memoria no tiene problema con miles | v1 |
| NFR-SC05 | Modo de ingesta | Poll por cron. Webhook/push **fuera de alcance** | Post-v1 |

### Operabilidad

| ID | Requirement | Target | Measurement |
|----|------------|--------|-------------|
| NFR-O01 | Transporte de logs | **stdout**, estructurado; JSON en producción | Code review; **nunca a archivo** |
| NFR-O02 | Nivel de log por defecto | `info` | Config verificable |
| NFR-O03 | Trazabilidad de un mail | Cada mail deja al menos una línea con su `Message-Id` y su resultado (creado / descartado con motivo / fallido con código) | Inspección de logs: **ningún mail termina sin rastro** |
| NFR-O04 | Diagnóstico de un rechazo del bus | El log distingue **cuál de los tres sistemas** rechazó (bus por subject / `core` por rol / `core` por forma) | Es la diferencia entre "no puedo escribir" y saber dónde mirar |
| NFR-O05 | Healthcheck y métricas exportadas | **Fuera de alcance v1** (Jiku no los tiene en ninguno de sus cuatro servicios) | Registrado como fuera de alcance |
| NFR-O06 | Runtime | Node.js **≥ 22.12** (el `engines` floor del SDK, **parte de su superficie pública**) | `package.json` + CI |
| NFR-O07 | Ubicación de red | Dentro de la red del bus de Jiku, que **no está expuesta al ingress** | Config del despliegue |

---

## Assumptions

Derivadas del discovery, salvo donde se indica:

- **El volumen es de decenas de mails por día** (asumido, a validar con U-02). Es lo que hace que un
  poll cada 5 minutos con un cap de 50 alcance con margen.
- **El Mapa de Tickets cambia con poca frecuencia**, así que leerlo al arrancar y no en caliente es
  suficiente. Agregar un slug implica un redeploy.
- **`type: incidencia` es un default razonable** para un mail de cliente. Es lo que hace el servicio
  existente y se conserva para no cambiar el comportamiento en la migración — pero es el default más
  discutible del conector (ver Preguntas Abiertas).
- **Una sola instancia del worker** apunta a la casilla. Sin idempotencia, dos instancias duplicarían
  tickets.
- **La casilla acepta subaddress y tiene IMAP habilitado.** Con Gmail hace falta App Password, no la
  contraseña de la cuenta.
- **Los `projectId` del Mapa existen** en la instancia de Jiku a la que apunta. Nadie lo verifica
  antes: el síntoma de un id equivocado es `project_not_found` por mail.
- **La fila del conector en `users` la crea Jiku sola** en su primera autenticación contra el bus,
  con `identity_type: service` y `email` en `NULL`. Con dos consecuencias que el conector no puede
  arreglar: la entrega del evento **no es durable** (NATS sin JetStream), así que si se pierde el
  conector queda sin fila y sus comandos fallan con `caller_not_authorized` hasta su próxima
  autenticación; y **la fila aparece después de la primera conexión, no antes**, así que los primeros
  comandos de un conector recién desplegado pueden fallar. Reconectar lo resuelve.
- **El SDK `@gravadigital/jiku` se mantiene estable dentro de 1.x** (*"the API below is what 1.x will
  keep"*).
- **La política de archivos de `core` no cambia tan seguido** como para que el filtro local
  desalineado sea un problema frecuente. Cuando se desalinea, `core` rechaza y el conector anota el
  aviso.
- **No hace falta CORS en el bucket**: el `PUT` lo hace un proceso de servidor, no un navegador. Es
  una diferencia real con los dos frontends de Jiku, que sí lo necesitan.
- **Nadie verifica el byte subido**, ni el conector ni Jiku. Un `PUT` que falló en silencio se
  descubre al descargar.

## Preguntas Abiertas

1. **¿Cómo se rutea una respuesta cuando los comentarios entren en alcance?** Es la pregunta que más
   condiciona la v2 y no tiene respuesta obvia: el conector necesitaría el mapa
   `Message-Id → requisito` y **no tiene dónde ponerlo**. Las tres salidas son un estado propio
   persistido (lo que la decisión de idempotencia evitó), una tabla en Jiku —que existe pero está
   declarada sin uso y el conector no puede escribir—, o un identificador embebido en el asunto que
   sobreviva al `Re:`. Ninguna es gratis, y la elección probablemente arrastre revisar la decisión de
   no tener estado.
2. **¿El `type: incidencia` por default es correcto?** Un mail de un cliente no siempre es una
   incidencia. Alternativas: `otro`, inferirlo del asunto (frágil), o por slug en el Mapa.
3. **¿El Mapa de Tickets debería vivir por proyecto en vez de por conector?** Jiku ya guarda
   propiedades extensibles por proyecto. Poner el slug ahí lo haría dato del producto y visible en la
   interfaz, al precio de que el conector necesite el plano de lectura.
4. **¿Qué pasa cuando el mismo cliente escribe a dos slugs en el mismo hilo?** No modelado.
5. **¿Se acepta que un remitente no verificado cree requisitos?** Hoy cualquiera que conozca la
   dirección `tickets+<slug>@` puede crear un requisito en ese proyecto, y el servicio existente
   tampoco lo valida. Es una superficie de abuso real, aunque acotada por lo poco adivinable del
   slug.
6. **¿El conector debería anotar en el requisito quién lo mandó?** Hoy `senderEmail` se parsea y
   **no se usa para nada** (su único consumidor era la notificación de Mattermost). Ponerlo en la
   descripción o en un tag lo haría visible al cliente en Opus.
7. **¿La idempotencia por `\Seen` es tolerable en la práctica?** Está registrada como **el candidato
   número uno a revisar**. El lugar donde el producto lo resolvería es su feature group de
   Durabilidad y Observabilidad de la Escritura.
