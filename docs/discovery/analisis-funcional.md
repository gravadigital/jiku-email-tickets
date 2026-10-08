---
created: 2026-08-26
last_updated: 2026-08-26
status: Análisis funcional cerrado
documento_base: "grava-gestion/mail-integration (servicio existente, v1.0.0) + el PRD de Jiku en jiku/core/docs/prd/ + el SDK @gravadigital/jiku v1.0.0 (jiku/jiku-ts)"
---

# Análisis Funcional — jiku-email-tickets

> **Qué es este documento.** El pre-PRD del conector de mail de Jiku. Es
> **decision-complete**: cada ambigüedad que apareció al portar el servicio existente a la
> arquitectura de Jiku está resuelta acá, con su por qué, en la sección
> [Decisiones Tomadas](#decisiones-tomadas). `/product-initialize` lo lee para **transcribir**,
> no para volver a preguntar.
>
> **De dónde sale.** De tres fuentes, y conviene saber cuál dice qué:
>
> 1. **`grava-gestion/mail-integration` v1.0.0** — el servicio que hace esto hoy. De ahí sale
>    todo el **dominio del mail**: ingesta IMAP, parseo, ruteo por slug, política de adjuntos.
>    Está verificado contra el código, no reconstruido de memoria.
> 2. **El PRD y los ADRs de Jiku** — de ahí sale todo el **dominio de la escritura**, que
>    cambia por completo. Cada afirmación arquitectónica de este documento cita el ADR o el
>    contrato que la respalda.
> 3. **`@gravadigital/jiku` v1.0.0 (`jiku/jiku-ts`)** — el SDK oficial del bus, y **la pieza
>    que más simplifica este conector**. Es un paquete publicado, estable (*"the API below is
>    what 1.x will keep"*), con `client.command()` sobre el plano de escritura y
>    `ServiceUser.fromKeyFile()` para exactamente esta clase de identidad. El conector **lo
>    consume; no reimplementa nada del protocolo**.
>
> **Lo que NO es.** No es una migración de código. El servicio actual escribe directo en
> PostgreSQL con Sequelize y sube a S3 con credenciales propias; en Jiku **no puede hacer
> ninguna de las dos cosas**. Lo que se conserva es el dominio del mail; la mitad de la
> escritura se reescribe contra el bus — y esa mitad la resuelve el SDK, no el conector.

---

## Contexto y Alcance

### Producto

**jiku-email-tickets** es un worker sin interfaz que convierte mails en requisitos de Jiku. Una
casilla de tickets con subaddress —`tickets+<slug>@grava.io`— recibe el pedido de un cliente; el
conector lo ingesta por IMAP, resuelve a qué proyecto corresponde por el `<slug>`, y publica en el
bus de Jiku la creación del requisito con sus adjuntos.

Es un **conector**, no un servicio del producto: vive en su propio repositorio, no comparte
código con el monorepo de Jiku, y **su única puerta de entrada al producto es el bus NATS**. No
tiene HTTP, no tiene base de datos propia, y no toca la base de Jiku.

Para el cliente que escribe el mail, el conector es invisible: manda un mail y su pedido aparece
en Opus. Ese es todo el valor.

### Objetivo Estratégico

**Cerrar el último canal de pedido que no tiene trazabilidad.** El PRD de Jiku declara el problema
en su visión: *"El pedido de un cliente que llega por Mattermost, mail o reunión se pierde o queda
sin trazabilidad"*. El portal Opus resolvió el pedido que el cliente carga él mismo (G-02); el
mail quedó afuera.

Y el mail es el canal que el cliente **ya usa y no va a dejar de usar**. Pedirle que entre a un
portal para algo que resolvía con un mail es fricción que no se puede imponer a una contraparte
externa. El conector acepta el canal del cliente en vez de cambiarlo, y lo hace desembocar en el
mismo modelo: un requisito, en un proyecto, con su trazabilidad hasta las horas (G-01).

### Principios Rectores

- **El conector no escribe en la base ni en el storage.** No es una preferencia de diseño: es la
  garantía estructural de Jiku. La api conecta con un rol de PostgreSQL sin `INSERT`/`UPDATE`/
  `DELETE` y `core` es el único escritor (ADR-001); el storage tiene un solo dueño y también es
  `core` (`files.request-upload`: *"la api no guarda credenciales de S3"*). El conector se somete
  a la misma regla, y por eso **no lleva cliente de PostgreSQL ni credenciales de S3**.
- **Toda escritura es un comando NATS.** ADR-001 lo declara como Implementation Rule: *"Toda
  escritura de dominio nueva DEBE implementarse como comando en `core`"*. El conector no inventa
  un comando: usa los dos que ya existen.
- **No modifica el producto.** Ni un comando nuevo en `core`, ni un endpoint nuevo en la api, ni
  una migración, ni una plantilla del auth-callout. Si el conector necesitara algo de eso, sería
  un requerimiento del producto y no de este repositorio. Es la restricción más fuerte del
  alcance v1, y está verificada una por una en [Dependencias](#dependencias-y-bloqueantes-abiertos).
- **El mapa de tickets es configuración del conector, no dato del producto.** El slug resuelve a
  un proyecto por un KV que se carga a mano. Es deliberado — ver la decisión 3.
- **Degradar hacia el descarte silencioso, nunca hacia el requisito equivocado.** Un mail que no
  resuelve a un proyecto se descarta con log y no se crea nada. Crear un requisito en el proyecto
  incorrecto es peor que no crearlo: lo ve un cliente que no debía verlo, y eso rompe el
  aislamiento que sostiene todo el portal (ADR-006).

### Alcance v1

| Dentro del alcance v1 | Fuera del alcance v1 |
|---|---|
| Ingesta IMAP por poll, de la casilla de tickets | Webhook / push del proveedor de mail |
| Parseo del mail a una forma normalizada | Cualquier interfaz de usuario |
| Resolución del proyecto por `<slug>` contra un KV local | Resolución por consulta al bus (ver decisión 3) |
| Alta de requisito en Jiku (`requirements.new`) | **Comentarios desde respuestas al hilo** (ver decisión 9) |
| Subida y vínculo de adjuntos (`files.request-upload` + `fileIds`) | Notificaciones a Mattermost (ver decisión 10) |
| Política de adjuntos: doble lista blanca y tope de tamaño | Verificación del byte subido |
| Descarte silencioso de lo que no resuelve | Reintento de un comando fallido |
| Carga del KV por variable de entorno / archivo montado | Interfaz de administración del KV |

### Restricciones

**Permitido:** publicar los comandos de escritura de `core` bajo la identidad propia; hacer `PUT`
contra una URL prefirmada que `core` firmó; leer el KV de su propia configuración.

**Prohibido:** conectarse a PostgreSQL; tener credenciales de S3; crear o modificar comandos de
`core`; agregar endpoints a la api; correr migraciones; editar `rules.yaml` o las plantillas del
auth-callout.

**Estrategia:** el conector se declara como **un caller más del bus**, con el rol `internal-app`
que Jiku ya tiene definido exactamente para esto. `rules.yaml` es explícito: *"Para habilitar un
conector: crear un machine user en Zitadel con Access Token Type = JWT y asignarle el rol
`internal-app` en `GESTION_ZITADEL_PROJECT_ID`. **No hace falta tocar nada de este archivo**"*. Y
`templates/api.yaml` ya publica sobre `{{instance}}.{{user_id}}.jiku-commands.v1.>` con comodín,
que cubre los dos comandos que el conector necesita.

Esa estrategia tiene un **costo que hay que declarar y no minimizar**: `internal-app` concede los
dos planos completos —`{ commands: ALL, queries: ALL }` en `core/src/authorize-caller.ts`— y ubica
al caller en la clase `connector`, **que no recorta ninguna fila en las consultas**. El conector va
a poder mucho más de lo que necesita. `rules.yaml` ya anticipa la pregunta: *"Un conector con
permiso acotado es un ROL NUEVO —con su plantilla y su entrada en ese mapa—, no una variante de
este"*. Se acepta el rol amplio en v1 porque acotarlo modifica el producto, y eso está fuera del
alcance; queda registrado en [Fuera de Alcance](#fuera-de-alcance--preguntas-abiertas).

---

## Mapa Funcional

> **Borrador.** `/product-initialize` lo formaliza en feature groups reales con sus
> precondiciones y postcondiciones. FG-1 es el walking skeleton.

```
jiku-email-tickets
├── FG-1 · Ingesta y normalización del mail
│   ├── Poll IMAP de la casilla de tickets
│   ├── Cap por tick y marcado \Seen
│   └── Normalización: asunto, cuerpo, referencias, adjuntos
├── FG-2 · Resolución del destino
│   ├── Extracción del <slug> del subaddress
│   ├── Mapa slug → projectId (KV local)
│   └── Descarte silencioso de lo que no resuelve
├── FG-3 · Alta del requisito en Jiku
│   ├── Conexión al bus con la identidad propia
│   ├── Publicación de requirements.new
│   └── Traducción de la respuesta y de sus errores
├── FG-4 · Adjuntos
│   ├── Partición por política (doble lista blanca + tamaño)
│   ├── files.request-upload + PUT directo a la URL prefirmada
│   └── Vínculo por fileIds en el alta del requisito
└── Transversales
    ├── Identidad en el bus (machine user + auto-refresh)
    ├── Observabilidad (el conector no tiene a quién reportarle)
    ├── Configuración y fail-fast
    └── Idempotencia (o su ausencia declarada)
```

---

## FG-1 — Ingesta y normalización del mail

### Objetivo

Traer los mails nuevos de la casilla de tickets y dejarlos en una forma normalizada, sin decidir
nada sobre ellos todavía. Es el único feature group que **se conserva casi intacto** del servicio
existente: el dominio del mail no cambia porque cambie la arquitectura de escritura.

### Configuraciones

| Configuración | Default | Alternativas |
|---|---|---|
| Host IMAP | — (requerido) | Cualquier proveedor con IMAP sobre TLS |
| Puerto IMAP | `993` | — (TLS siempre) |
| Cron del poll | `*/5 * * * *` | Cualquier expresión cron |
| Poll habilitado | `true` | `false` deja el worker vivo sin schedular nada |
| Máximo de mails por tick | `50` | Cualquier entero ≥ 1 |
| Prefijo del subaddress | `tickets` | La parte local de una casilla de prueba |
| Carpeta | `INBOX` | — (fija en v1) |

### Flujo

1. El cron dispara el tick. Si otro tick está en curso, **no se solapa**: se saltea con un warn.
2. Conecta a IMAP sobre TLS y toma el lock de `INBOX`.
3. Busca los mensajes **no vistos** (`\Unseen`).
4. Ordena los UIDs **de más nuevo a más viejo** y toma los primeros N según el cap. Si había más,
   loguea un warn con cuántos quedaron diferidos: los restantes siguen sin leer y los toma el
   próximo tick.
5. Por cada UID: descarga el mensaje crudo completo, lo parsea, y **lo marca `\Seen`**.
6. Normaliza cada mensaje a la forma de trabajo:
   - `messageId` — el `Message-Id` del mail. **Es obligatorio**: un mail sin él no se procesa.
   - `referenceIds` — unión ordenada y deduplicada de `In-Reply-To` + `References`. Se conserva
     aunque v1 no rutee respuestas, porque es lo que **distingue un mail nuevo de una respuesta**
     y v1 necesita ese dato para descartar las respuestas (ver FG-2, regla 4).
   - `recipient` — `Delivered-To`, y `To` como fallback. Es el header que **conserva el
     subaddress real**, que es de donde sale el slug.
   - `senderEmail` — el mail del remitente, aislado del formato `Nombre <mail@dominio>`.
   - `subject` — sin los prefijos `Re:` / `Fwd:` / `RV:`, quitados **iterativamente** (un
     `Re: Re: Fwd:` queda limpio) y sin distinguir mayúsculas.
   - `body` — texto plano. Si el mail es sólo HTML se convierte preservando saltos, ignorando
     `href` y salteando `img`. En los dos casos **se recorta el texto citado** del hilo.
   - `attachments` — nombre, MIME declarado, tamaño, contenido, y el `Content-Disposition` y
     `Content-ID` de la parte MIME.
7. Cada mail normalizado pasa a FG-2, **de a uno**.

### Reglas

- Se procesan sólo los mails **no vistos**. El marcado `\Seen` es lo único que evita reprocesar.
- El cap por tick procesa **los más nuevos primero**. Un backlog grande se drena en varios ticks
  y el pedido más reciente no espera detrás de mil viejos.
- **Un mail que no se puede parsear no aborta el lote**: se cuenta como fallido, se loguea con su
  `Message-Id`, y el tick sigue con el siguiente.
- **Un fallo del tick completo no tumba el worker.** Queda vivo y reintenta en el próximo.
- Las credenciales IMAP **nunca se loguean**, ni el tráfico IMAP crudo.
- El cuerpo del mail **no se loguea**: es contenido de negocio y puede traer datos del cliente.

### Edge cases / Condiciones de falla

| Causa | Resultado |
|---|---|
| Credenciales u host IMAP incorrectos | El tick falla completo con log de error; el worker sigue vivo y reintenta |
| Red caída a mitad del tick | Los mails ya marcados `\Seen` no se reprocesan; el resto queda sin leer |
| Más mails sin leer que el cap | Procesa los más nuevos; warn con cuántos quedaron diferidos |
| Un mensaje no se puede descargar | Se saltea con warn; **no se marca `\Seen`**, así que el próximo tick lo reintenta |
| Mail sin `Message-Id` | Se descarta con warn: es el único campo obligatorio de la normalización |
| Mail sin cuerpo (ni texto ni HTML) | `body` queda vacío; FG-3 lo reemplaza por un placeholder |
| Mail sólo HTML | Se convierte a texto plano; no es un error |
| Tick anterior todavía corriendo | Se saltea el nuevo con warn (sin solapamiento) |

---

## FG-2 — Resolución del destino

### Objetivo

Decidir **a qué proyecto de Jiku va** el mail, o descartarlo. Es el feature group que más cambia
respecto del servicio existente: hoy resuelve con un `SELECT ... WHERE ticket_slug = ?` contra la
base; acá no hay base.

### Configuraciones

| Configuración | Default | Alternativas |
|---|---|---|
| Mapa `slug → projectId` | — (requerido, puede estar vacío) | Variable de entorno o archivo montado |
| Prefijo del subaddress | `tickets` | La parte local de una casilla de prueba |
| Recarga del mapa | Al arrancar | Recarga en caliente (fuera de v1) |

### Flujo

1. Toma el `recipient` normalizado y aísla el email si viene como `Nombre <mail@dominio>`.
2. Matchea `^<prefijo>\+([^@]+)@` sin distinguir mayúsculas. Sin match → **descarte silencioso**.
3. Normaliza el slug extraído **a minúsculas**.
4. Busca el slug en el KV. Sin entrada → **descarte silencioso** con log del slug buscado.
5. Con entrada, obtiene el `projectId` (entero) y se lo pasa a FG-3.

### Reglas

1. El slug se compara **siempre en minúsculas**, en las dos puntas. Un `TICKETS+Alfa@` y un
   `tickets+alfa@` resuelven al mismo proyecto.
2. **El descarte es silencioso y es la respuesta correcta**, no un error: la casilla recibe spam,
   respuestas automáticas y mails a direcciones sin slug. Cada descarte deja una línea de log con
   el `Message-Id` y el motivo, y nada más.
3. **El conector no valida que el proyecto exista.** Publica el `projectId` del KV y `core` valida
   por su cuenta: si no existe, la respuesta es `project_not_found`, que nombra el problema real
   (el KV apunta a un proyecto inexistente). Ver la decisión 4.
4. **Una respuesta a un hilo se descarta en v1.** Si el mail trae `referenceIds` no vacío, se
   descarta con un log que lo diga explícitamente. Es la consecuencia visible de que los
   comentarios queden fuera de alcance (decisión 9), y **hay que declararla**: sin esta regla, una
   respuesta del cliente crearía **un requisito nuevo duplicado** en vez de un comentario.
5. El KV **puede estar vacío** y el conector arranca igual: descarta todo y lo loguea. Un KV vacío
   es un estado de configuración válido, no un error de arranque.

### Edge cases / Condiciones de falla

| Causa | Resultado |
|---|---|
| Destinatario sin `+slug` | Descarte silencioso con log |
| Slug que no está en el KV | Descarte silencioso con log **nombrando el slug** (es el dato que hace falta para cargarlo) |
| Slug en el KV con un `projectId` que no existe en Jiku | Se publica y `core` responde `project_not_found`; el mail queda perdido (ya está `\Seen`) |
| Mail con `referenceIds` (respuesta a un hilo) | Descarte con log explícito de "respuesta, fuera de alcance v1" |
| `Delivered-To` ausente | Cae al fallback `To`; si tampoco está, descarte silencioso |
| Varios destinatarios con slugs distintos | Resuelve por `Delivered-To`, que es **uno solo**: el que efectivamente entregó a esta casilla |
| KV mal formado al arrancar | **Fail-fast**: el worker no arranca (ver Transversales → Configuración) |

---

## FG-3 — Alta del requisito en Jiku

### Objetivo

Publicar el comando que crea el requisito, y traducir su respuesta. Es donde el conector deja de
ser un lector de mails y se vuelve un caller del bus de Jiku.

### Configuraciones

| Configuración | Default | Alternativas |
|---|---|---|
| Instancia del bus (`JIKU_INSTANCE`) | `dev` | `prod` o cualquier instancia desplegada |
| Servidores NATS (`JIKU_SERVERS`) | `nats://localhost:4222` | La URL del bus del entorno |
| Creds del sentinel (`JIKU_CREDS`) | — (requerido) | — |
| Key del machine user (`JIKU_KEY_FILE`) | — (requerido) | — |
| Issuer de Zitadel (`JIKU_ISSUER`) | `https://id.grava.io` | — |
| Project id de Zitadel (`JIKU_PROJECT_ID`) | — (requerido) | Sin él **el token no lleva roles y no conecta a nada** |
| Timeout de la request (`JIKU_TIMEOUT`) | `15000` ms (default del SDK) | **No bajarlo** — ver la regla correspondiente |
| `type` del requisito creado | `incidencia` | Cualquier valor del enum (ver decisión 5) |
| `priority` del requisito creado | `sin_prioridad` | Cualquier valor del enum |
| `visibilityLevel` | `public` | `internal` |
| Título cuando el asunto viene vacío | `Ticket recibido por mail` | Cualquier texto |
| Cuerpo cuando el mail viene vacío | `(mail sin contenido)` | Cualquier texto |

### Flujo

1. **Al arrancar** (una vez, no por mail): construye la identidad con
   `ServiceUser.fromKeyFile()` y **un solo `connect()` del SDK**, que se conserva por toda la
   vida del proceso. El SDK resuelve las tres cosas que un cliente NATS a mano hace mal en este
   bus: fija el prefijo de inbox, maneja las dos credenciales, y **entrega al bus una función y
   no un string** para que el token siga fresco tras un reconnect.
2. Arma el payload de `requirements.new`:
   - `creator` — su propio `sub`. **Lo que declare acá se ignora** (ver decisión 6).
   - `title` — el asunto limpio, o el título por default si vino vacío.
   - `description` — el cuerpo, o el placeholder si vino vacío, más lo que FG-4 anexe.
   - `projectId` — el que resolvió FG-2.
   - `type`, `priority`, `visibilityLevel` — los valores configurados.
   - `fileIds` — los ids de los archivos que FG-4 subió con éxito. Ausente si no hay ninguno.
3. Llama a `client.command('requirements.new', payload)`. El SDK arma el subject, publica y
   **espera la respuesta**.
4. Si resuelve, toma el `id` del requisito creado y lo loguea con el `Message-Id`, el `projectId`
   y el `id`.
5. Si lanza, distingue **qué sistema rechazó** por la clase del error y lo loguea. **No reintenta.**

### Reglas

- **El conector no arma subjects ni parsea envelopes: usa el SDK.** ADR-002 declara como
  Implementation Rule que el subject se construye con la gramática del protocolo y no a mano, y
  el SDK es esa gramática (ver decisión 8).
- **Un solo cliente por proceso, construido al arrancar.** Conectar cuesta un round-trip a
  Zitadel más un handshake de NATS que corre el auth-callout: uno por mail sería absurdo.
- El `user-id` del subject **sale de la key del machine user**, no de una variable de entorno:
  tiene que coincidir exactamente con el `sub` que el auth-callout lee para autorizar el subject.
  `ServiceUser` lo deriva de la key y lo expone como `auth.userId`.
- **El `projectId` de Zitadel es obligatorio y su ausencia no se parece a su causa.** Sin él el
  token no lleva el claim de roles, y un token sin roles **no conecta a nada**: el error dice
  sólo `Authorization Violation`.
- **No bajar el timeout por debajo del default del SDK.** Son 15 s a propósito, por encima de los
  10 s del servidor: PostgreSQL corta a los 8 s y la respuesta llega como un error que se explica.
  Un timeout más corto del lado del cliente **convierte esa explicación en silencio**.
- **Un fallo del refresh del token en background no es fatal pero va al log**: el token actual
  sigue sirviendo, y lo que se rompe es el **próximo reconnect**.
- **El requisito nace en `analisis`**, que es el default del enum en Jiku. El conector no manda
  `state`.
- **El conector no manda `actor` en el payload.** Es la única clave de identidad que el plano de
  escritura rechaza de plano.
- **Un requisito creado no se corrige.** Si el alta salió bien y el vínculo de un adjunto falló, el
  requisito queda con el aviso en la descripción y nada más. No hay comando de compensación.
- **No hay reintento.** Un `failure` o un timeout es definitivo para ese mail, que además ya está
  `\Seen`. Es la consecuencia asumida de la decisión 1.

### Edge cases / Condiciones de falla

**Tres sistemas distintos pueden rechazar un comando, por razones distintas y con arreglos
distintos.** El SDK los separa por clase de error, y el log tiene que decir cuál fue — es la
diferencia entre "no puedo escribir" y saber dónde mirar:

| Causa | Clase del SDK | Resultado |
|---|---|---|
| El **bus** rechazó la publicación, por subject | `JikuPermissionDenied` | La plantilla del rol no concede el plano de comandos. **Problema de configuración de Zitadel**, no del payload |
| **`core`** rechazó por rol | `JikuFailure` con `caller_not_authorized` | El bus dejó pasar y el mapa rol→método de `core` no autoriza. Típicamente: **sin fila en `users`** (ver Transversales → Identidad) |
| **`core`** aceptó el caller y rechazó la forma | `JikuFailure` con `invalid_fields` | El payload está mal armado. **Prueba de que el plano de escritura sí está abierto** para esta identidad |
| `core` caído, o el comando expira | `JikuTimeout` | Se loguea; **el mail se pierde** (ya está `\Seen`) |
| Nada suscripto al subject | `JikuNoEndpoint` | El bus lo dice **de inmediato**, sin esperar el timeout |
| Rechazado localmente antes de publicar | `JikuInvalidRequest` | **No llegó nada a la red.** Error de armado del conector |
| `project_not_found` | `JikuFailure` | El KV apunta a un proyecto inexistente; se loguea con el `projectId` |
| El rol `internal-app` no está asignado en Zitadel | (falla el `connect`) | **La conexión se rechaza**: `Authorization Violation`. Es un fallo de arranque, no por mail |
| Asunto vacío | — | Título por default |
| Cuerpo vacío y sin adjuntos | — | Descripción con el placeholder |
| Asunto de más de 255 caracteres | — | `title` es `varchar(255)` en Jiku: hay que truncar antes de publicar (ver decisión 7) |
| Un `errorCode` que el conector no conoce | `JikuFailure` | Se loguea con su `code` y su `hint()`. **No se mapea a nada**: el conector no tiene a quién responderle |

---

## FG-4 — Adjuntos

### Objetivo

Que los archivos del mail terminen vinculados al requisito. Es el feature group donde la
arquitectura de Jiku cambia más el **cómo** sin cambiar el **qué**: hoy es un upload y un INSERT;
acá son tres planos separados.

### Configuraciones

| Configuración | Default | Alternativas |
|---|---|---|
| Extensiones aceptadas | Las que declare `system_settings` de Jiku | Ver la regla 1 |
| Tamaño máximo por archivo | El que declare `system_settings` (hoy 10 MB) | Ver la regla 1 |
| Máximo de archivos por requisito | `10` | **No configurable**: es el `maxItems` del contrato |
| Timeout del `PUT` a la URL prefirmada | `30000` ms | Cualquier valor razonable |
| Política ante fallo de un archivo | Continuar sin él | Abortar el requisito completo (descartada) |

### Flujo

Por cada mail que llegó a esta etapa, y **antes** de publicar `requirements.new`:

1. **Particiona** los adjuntos en aceptados y rechazados según la política local.
2. Por cada aceptado, y hasta el tope de 10:
   1. Llama a `client.command('files.request-upload', ...)` con `fileName`, `mimeType`,
      `fileSize` y el `checksum` sha256 calculado sobre el contenido.
   2. `core` valida la doble lista blanca **leyéndola en caliente de `system_settings`**, crea la
      fila de `files` con el byte sin verificar, construye la clave —**el conector no elige dónde
      se guarda**— y devuelve el `fileId` y una URL prefirmada de `PutObject`.
   3. El conector hace **`PUT` del byte directo a esa URL**. No pasa por el bus ni por la api.
   4. Con el `PUT` exitoso, guarda el `fileId` para el paso 3.
3. Publica `requirements.new` con los `fileIds` acumulados (FG-3). `core` crea el requisito y,
   **en la misma transacción**, valida la titularidad de cada archivo e inserta un vínculo por
   cada uno.
4. Compone la descripción final: cuerpo base, después los avisos de rechazo, después los avisos de
   fallo de subida, y **al final los placeholders** de los archivos que sí quedaron.

### Reglas

1. **La política autoritativa es la de `core`, no la del conector.** `core` valida la doble lista
   blanca —extensión **y** MIME— contra `system_settings`, en caliente. El filtro local del
   conector es una **conveniencia** para no gastar un round-trip en un `.exe`, y puede quedar
   desalineado: si lo está, `core` rechaza y el conector anota el aviso. Es la misma relación que
   tiene la validación del navegador con la de `core` en el flujo de subida de Jiku.
2. **El byte nunca viaja por el bus.** El `max_payload` de NATS es 1 MB y los adjuntos llegan a
   10 MB. El `PUT` directo no es una optimización: es la única forma.
3. **El conector no elige la clave de storage.** `core` la construye. Un conector que armara su
   propia clave rompería la garantía de que el storage tiene un solo dueño.
4. **La titularidad se cumple por construcción.** `core` resuelve el actor por canal: como el
   caller del conector **no** es el service user de la api, el actor es **su propio `sub` del
   subject** —infalsificable, avalado por el auth-callout— y *lo que el conector declare en el
   cuerpo se ignora*. Sube con su identidad y vincula con la misma, así que la regla
   `uploaded_by == actor` se satisface sin que el conector haga nada. Es exactamente el canal que
   Jiku diseñó para un publicador externo.
5. **El tope de 10 es del contrato, no del transporte.** `fileIds` declara `maxItems: 10`. Un mail
   con 15 adjuntos aceptables sube los primeros 10 y anota los otros 5 como no adjuntados.
6. **Un fallo de un archivo no cancela el requisito.** Se anota el aviso y se sigue. La alternativa
   —abortar todo— convertiría un adjunto corrupto en un ticket perdido.
7. **Nadie verifica el byte.** Ni `core` ni el conector: el `checksum` se declara y no se
   comprueba, y `core` no hace `headObject` para no arriesgar el timeout del comando. Un `PUT` que
   falló en silencio se descubre al descargar.
8. **Los archivos huérfanos son un estado válido.** Si la subida de tres archivos salió bien y el
   `requirements.new` falla, las tres filas de `files` quedan sin vínculo. En Jiku eso **no es una
   anomalía**, y el barrido de abandonados está fuera de alcance del producto entero.
9. **Se deduplica por checksum dentro del mismo mail**: dos adjuntos idénticos se colapsan a uno.
   Un adjunto colapsado **no es un rechazo**: no suma aviso ni placeholder.

### Edge cases / Condiciones de falla

| Causa | Resultado |
|---|---|
| Extensión o MIME fuera de la lista | Rechazado localmente; aviso en la descripción; no se sube |
| El filtro local acepta y `core` rechaza | `file_type_not_allowed` / `file_too_large`; aviso en la descripción |
| Tamaño 0 o sobre el tope | Rechazado; aviso en la descripción |
| El `PUT` a la URL prefirmada falla | El archivo se saltea con warn; aviso en la descripción; **el requisito se crea igual** |
| La URL prefirmada expiró | Igual al anterior: el TTL sale de `system_settings` y el `PUT` es inmediato, así que es improbable |
| Más de 10 adjuntos aceptables | Sube 10; los demás quedan como aviso |
| Dos adjuntos idénticos | Se colapsan a uno; sin aviso ni placeholder duplicado |
| `files.request-upload` responde `failure` | El archivo se saltea con aviso; el requisito se crea sin él |
| `requirements.new` falla después de subir | Los `files` quedan **huérfanos**, sin vínculo. Estado válido; no se limpian |
| Imagen inline del cuerpo (firma, logo) | Se trata como adjunto normal en v1 (ver decisión 11) |

---

## Transversales

### Identidad en el bus

| Pieza | Definición |
|---|---|
| Tipo de identidad | Machine user de Zitadel con Access Token Type = **JWT** |
| Cómo se construye | `ServiceUser.fromKeyFile()` del SDK (RFC 7523, sólo Node) |
| Rol requerido | **`internal-app`**, asignado en el project de gestión de Zitadel |
| Cambios en el auth-callout | **Ninguno.** `rules.yaml` ya matchea el rol y `templates/api.yaml` ya publica sobre `jiku-commands.v1.>` con comodín |
| Lo que ese rol concede | `commands: ALL` y `queries: ALL`, más la clase `connector` (sin recorte de filas). **Más de lo necesario**; ver Fuera de Alcance |
| La key | **Zitadel la entrega una sola vez.** No se puede volver a descargar, sólo reemplazar por una nueva |
| Token | Se obtiene con la JSON key, caduca en ~1 h y **el SDK lo refresca en background** |
| `user-id` del subject | El `sub` del machine user, **derivado de la key** (`auth.userId`), nunca de una variable |
| Prefijo de inbox | `_INBOX.<hash(sub)>.>`, **lo fija el SDK siempre** |
| Fila en `users` | **La crea Jiku solo**, no el conector (ver abajo) |

**La fila en `users` es una precondición que se satisface sola, y hay que entender cómo.** El
conector necesita fila en `users` por dos motivos independientes: la compuerta de autorización de
`core` lee `users.roles` y **sólo exime al service user de la api**, y `requirements.created_by` y
`files.uploaded_by` tienen FK real contra `users.id`.

Esa fila la crea Jiku por su cuenta: el auth-callout publica un evento en cada autenticación
contra el bus, y `core` lo consume y espeja la identidad. La **primera conexión** del conector la
crea, con `identity_type: service` y `email` en `NULL` —un machine user no tiene dirección de
correo, y Jiku lo contempla explícitamente—.

Con dos consecuencias que el conector no puede arreglar y tiene que tolerar:

- **La entrega del evento no es durable** (NATS sin JetStream). Si se pierde, el conector queda
  sin fila y sus comandos fallan con `caller_not_authorized` hasta su próxima autenticación, que
  con un token renovado en caliente puede tardar. **Es una dependencia declarada, no un bug del
  conector.**
- **La fila aparece después de la primera conexión, no antes.** Los primeros comandos de un
  conector recién desplegado pueden fallar. Reconectar lo resuelve.

### Observabilidad

| Pieza | Definición |
|---|---|
| Transporte de logs | **stdout**, estructurado (JSON en producción) |
| A quién le reporta un fallo | **A nadie.** No hay usuario esperando ni request que responder |
| Métricas por tick | ingestados, parseados, creados, descartados, fallidos |
| Nivel por defecto | `info` |
| Qué **no** se loguea | Credenciales, tráfico IMAP crudo, cuerpo del mail, contenido de adjuntos |
| Healthcheck | Fuera de alcance v1 (ver Fuera de Alcance) |

**Es la preocupación transversal más importante del conector, y merece decirlo sin rodeos.** En
Jiku, cuando una escritura falla, hay un usuario mirando una pantalla que recibe un error. Acá no
hay nadie: el cliente mandó un mail y se fue. **Un ticket perdido no tiene síntoma.** Los logs no
son un accesorio de diagnóstico, son el **único** lugar donde un mail perdido deja rastro.

Por eso los logs a stdout y no a archivo: el PRD de Jiku registra que sus dos backends tienen los
transports de archivo con `filename: undefined` en producción, porque las variables no están en el
compose. El conector no repite ese error.

### Configuración y arranque

| Pieza | Definición |
|---|---|
| Fuente | Variables de entorno, más el KV por variable o archivo montado |
| Validación | **Fail-fast al arrancar**, con la lista completa de lo que falta |
| Punto de lectura | Un único módulo tipado; `process.env` no se lee en ningún otro lugar |
| Secretos | Inyectados por el entorno. **Nada horneado en la imagen** |
| KV vacío | Válido: arranca y descarta todo con log |
| KV mal formado | **Fail-fast**: no arranca |

El fail-fast con la lista completa es deliberado: el servicio existente ya lo hace y es la
diferencia entre *"faltan `X`, `Y` y `Z`"* y descubrir los tres de a uno, con un deploy cada vez.

### Idempotencia

| Pieza | Definición |
|---|---|
| Mecanismo | **El flag `\Seen` de IMAP, y nada más** |
| Estado propio | **Ninguno.** El conector no persiste nada |
| Garantía | Ninguna, en ninguna de las dos direcciones |

**Es la decisión más consecuente del conector y está tomada a conciencia** (decisión 1). Las dos
formas de falla, explícitas:

- **Se pierde un ticket.** El mail se marca `\Seen` y el comando falla después. El mail queda
  leído y el requisito no existe. **No hay reintento y no hay rastro más que el log.**
- **Se duplica un ticket.** El comando escribe y el proceso muere antes de marcar `\Seen`. El
  próximo tick lo vuelve a procesar y crea un segundo requisito idéntico.

Se acepta porque es **coherente con lo que el producto ya asume**: ADR-002 declara que sin
JetStream *"un comando perdido es un comando perdido"*, sin cola, reintento, persistencia ni
idempotencia. Un conector con idempotencia real sería más fuerte que el producto al que le
escribe. Y la alternativa —estado propio persistido— le agrega al conector un volumen que hay que
respaldar, para cubrir un caso que el resto del sistema no cubre.

**Queda registrado como el candidato número uno a revisar** si la pérdida silenciosa resulta
intolerable en la práctica. El lugar donde el producto lo resolvería es FG-3 de Jiku
(Durabilidad y Observabilidad de la Escritura).

---

## Métricas

> **Propuestas, no medidas.** El conector no instrumenta ninguna hoy, igual que el resto de Jiku.

| Métrica | Objetivo | Plazo | Valida |
|---|---|---|---|
| Tickets creados sobre mails con slug válido | > 99% | Semanal | Que el camino feliz funcione |
| Mails descartados por slug no mapeado | Tendiendo a 0 | Semanal | Que el KV esté al día |
| Latencia de mail a requisito | < 2× el intervalo del poll | Continuo | Que el cap por tick no genere backlog |
| Adjuntos vinculados sobre adjuntos aceptados | > 98% | Semanal | Que el `PUT` directo sea confiable |
| Comandos fallidos por `caller_not_authorized` | 0 | Semanal | Que la fila en `users` esté sana |
| Tickets duplicados detectados a mano | 0 | Mensual | El costo real de no tener idempotencia |

---

## Dependencias y Bloqueantes Abiertos

### Del lado de Jiku — todo existe, nada hay que construir

Verificado uno por uno contra el código y los contratos:

| Dependencia | Estado | Dónde |
|---|---|---|
| Comando de alta de requisito con adjuntos | **Existe** | `requirements.new`, con `fileIds` |
| Comando de permiso de subida | **Existe** | `files.request-upload` |
| Rol de conector en el bus | **Existe** | `internal-app` en `rules.yaml` + `ROLE_METHODS` |
| Plantilla del callout que publique comandos | **Existe** | `templates/api.yaml`, con comodín sobre `jiku-commands.v1.>` |
| Resolución de titularidad para un publicador externo | **Existe** | La rama externa de `resolveActor` |
| Alta automática de la fila en `users` | **Existe** | El evento de autenticación que `core` consume |
| Política de archivos configurable en caliente | **Existe** | Las cinco claves de `system_settings` |
| **Cliente del bus, publicado y estable** | **Existe** | `@gravadigital/jiku` v1.0.0 — `client.command()` sobre los 20 comandos, `ServiceUser.fromKeyFile()`, errores tipados |

**Ningún cambio en el producto Jiku.** Es el resultado que hace viable el alcance v1.

### Precondiciones de despliegue

1. **Machine user en Zitadel** con Access Token Type = JWT y el rol `internal-app` asignado en el
   project de gestión. Sin el rol, **la conexión al bus se rechaza** —no hay catch-all en
   `rules.yaml`— y el síntoma es `Authorization Violation`, no un fallo por mail. La **key JSON
   se descarga una sola vez** y hay que guardarla: no se puede volver a bajar.
2. **El creds del sentinel del bus** montado y alcanzable (`JIKU_CREDS`), y el **project id de
   Zitadel** configurado. Sin el project id el token no lleva roles y no conecta a nada.
3. **La casilla de tickets acepta subaddress** (`+slug`) y tiene IMAP habilitado. Con Gmail hace
   falta App Password, no la contraseña de la cuenta.
4. **El KV cargado** con al menos una entrada, o el conector descarta todo.
5. **Los `projectId` del KV existen** en la instancia de Jiku a la que apunta. Nadie lo verifica
   antes: el síntoma de un id equivocado es `project_not_found` por mail.
6. **CORS del bucket** no hace falta: el `PUT` lo hace un proceso de servidor, no un navegador.
   Es una diferencia real con los dos frontends de Jiku, que sí lo necesitan.
7. **Red al bus.** El conector necesita alcanzar NATS. En el deploy de Jiku eso es la red del bus,
   que **no está expuesta al ingress**: el conector va en esa red, no afuera.

### Bloqueantes

Ninguno. Los siete puntos de arriba son de configuración, no de construcción.

---

## Fuera de Alcance / Preguntas Abiertas

### Fuera de alcance v1, con su razón

| Tema | Por qué queda afuera |
|---|---|
| **Comentarios desde respuestas al hilo** | Es la mitad del servicio existente y **no cabe en v1 sin estado propio**: el ruteo de una respuesta a su requisito necesita el mapa `Message-Id → requisito`, que hoy vive en una tabla de Jiku que el conector no puede escribir. Ver la decisión 9 y la pregunta 1 |
| **Notificaciones a Mattermost** | Es un canal de salida, no de entrada. En Jiku las notificaciones son un feature group propio del producto, y ahí es donde se decide el canal |
| **Rol de conector acotado** | `internal-app` concede los dos planos completos. Acotarlo es crear un rol nuevo con su plantilla y su entrada en el mapa de `core`: **modifica el producto** |
| **Interfaz de administración del KV** | El KV a mano es la decisión 3. Una interfaz implica que el mapa es dato del producto, y esa es una decisión de Jiku |
| **Verificación del byte subido** | Nadie lo verifica en Jiku tampoco. Agregarlo acá sería más estricto que el producto |
| **Barrido de archivos huérfanos** | Está fuera de alcance del producto entero |
| **Idempotencia real** | Decisión 1. El producto tampoco la tiene |
| **Healthchecks y métricas exportadas** | Jiku no tiene healthcheck en ninguno de sus cuatro servicios. Es el mismo hueco, y su lugar es FG-3 del producto |
| **Webhook / push en vez de poll** | El poll es suficiente para el volumen y no depende del proveedor |
| **Adjuntos que Jiku rechaza pero el cliente mandó** | Quedan como aviso en la descripción. Guardarlos en otro lado sería un storage paralelo |

### Preguntas abiertas

1. **¿Cómo se rutea una respuesta cuando los comentarios entren en alcance?** Es la pregunta que
   más condiciona la v2, y no tiene respuesta obvia: el conector necesitaría el mapa
   `Message-Id → requisito` y **no tiene dónde ponerlo**. Las tres salidas son un estado propio
   persistido (lo que la decisión 1 evitó), una tabla en Jiku —que existe pero está declarada sin
   uso y el conector no puede escribir—, o un identificador embebido en el asunto que sobreviva al
   `Re:`. Ninguna es gratis, y la elección probablemente arrastre revisar la decisión 1.

   > **RESPONDIDA por REQ-005 (2026-09-09), y por una cuarta salida que esta lista no contemplaba:**
   > un **bucket KV del bus de NATS**. No es ninguna de las tres — no es estado propio persistido
   > (no hay base, ni migraciones, ni cliente de base), no es una tabla de Jiku (el conector no
   > escribe la base de Jiku, sigue sin poder), y no toca el asunto. Es un almacén **del bus**, que
   > ya era una dependencia del conector, con la clave `sha256(Message-Id)` y un TTL de 90 días.
   > *(REQ-008: el estado pasó al Espacio KV del conector en `JIKU_KV`, con la clave bajo `hilos.` y
   > sin TTL.)*
   >
   > **La decisión 1 se matizó, no se revisó:** ADR-001 pasó de *"no persiste nada"* a *"no tiene
   > persistencia **propia**"*, y el `\Seen` de IMAP sigue siendo el único mecanismo de
   > idempotencia — el KV **no** se aprovecha para eso.
2. **¿El `type: incidencia` por default es correcto?** Es lo que hace el servicio existente, pero
   un mail de un cliente no siempre es una incidencia. Alternativas: `otro`, o inferirlo del
   asunto (frágil), o por slug en el KV.
3. **¿El KV debería vivir por proyecto en vez de por conector?** Jiku ya guarda propiedades
   extensibles por proyecto. Poner el slug ahí lo haría dato del producto y visible en la
   interfaz, al precio de que el conector necesite el plano de lectura.
4. **¿Qué pasa cuando el mismo cliente escribe a dos slugs en el mismo hilo?** No modelado.
5. **¿Se acepta que un remitente no verificado cree requisitos?** Hoy cualquiera que conozca la
   dirección `tickets+<slug>@` puede crear un requisito en ese proyecto. El servicio existente
   tampoco lo valida. Es una superficie de abuso real, aunque acotada por lo poco adivinable del
   slug.
6. **¿El conector debería anotar en el requisito quién lo mandó?** Hoy `senderEmail` se usa sólo
   para la notificación de Mattermost, que está fuera de alcance — así que en v1 **se parsea y no
   se usa para nada**. Ponerlo en la descripción o en un tag lo haría visible al cliente en Opus.

---

## Decisiones Tomadas

> La sección que sostiene el documento. Cada ambigüedad que apareció al portar el servicio, con
> su resolución **y su por qué**.

| # | Tema | Decisión y por qué |
|---|---|---|
| 1 | **Idempotencia** | **El `\Seen` de IMAP es la única marca; el conector no persiste nada.** Porque un conector con idempotencia real sería más fuerte que el producto al que le escribe: ADR-002 ya asume que un comando perdido es un comando perdido. Se acepta la doble falla —ticket perdido o duplicado— a cambio de un conector sin estado. Es el candidato número uno a revisar |
| 2 | **Escritura** | **Nada de base ni de storage: sólo comandos del bus.** No es preferencia, es la garantía de infraestructura de Jiku: la api conecta con un rol sin `INSERT` y `core` es el único escritor (ADR-001), y el storage tiene un solo dueño que también es `core`. Elimina de un golpe el cliente de PostgreSQL, los modelos y las credenciales de S3 del servicio actual |
| 3 | **Mapa `slug → projectId`** | **KV local cargado a mano, con el `projectId` como valor.** Porque `ticket_slug` existe en la base de Jiku pero está **deliberadamente no expuesto ni filtrable** en el contrato de consultas del bus, y está marcado para eliminarse: un conector que resolviera por bus **no tiene por dónde**. Guardar el id y no el nombre es lo que hace al KV autosuficiente — con el nombre habría que resolverlo por consulta y volvería a hacer falta el plano de lectura |
| 4 | **Plano de lectura** | **El conector no consulta el bus: sólo escribe.** Validar el proyecto antes de crear no agregaría información —`core` ya responde `project_not_found`, que nombra el problema real— y duplicaría la validación con la peor de las dos decidiendo, que es el argumento con el que Jiku eximió a la api de su propia compuerta de roles. Además el plano de lectura exige fila en `users`, así que validar antes **adelantaría el fallo con un código que no señala la causa** |
| 5 | **`type` del requisito** | **`incidencia`, configurable.** Es lo que hace el servicio existente y se conserva para no cambiar el comportamiento en la migración. Configurable porque es el default más discutible del conector (pregunta abierta 2) |
| 6 | **Identidad del autor** | **El machine user del conector, resuelto del subject por `core`.** No hay persona detrás de un mail entrante, y `resolveActor` ya hace exactamente esto para un publicador externo: el actor es el `sub` del subject —infalsificable— y lo que el conector declare se **ignora**. El `MAIL_BOT_USER_ID` seedeado a mano del servicio actual **desaparece**: la fila en `users` la crea Jiku sola en la primera conexión |
| 7 | **Truncado del título** | **El conector trunca el asunto a 255 caracteres antes de publicar.** `requirements.title` es `varchar(255)`, y el contrato del comando **no declara un `maxLength`**: un asunto largo llegaría a `core` y fallaría en la base con un error genérico. Truncar del lado del emisor convierte un fallo opaco en una pérdida de información visible |
| 8 | **Cliente del bus** | **Se consume el SDK oficial `@gravadigital/jiku` v1.0.0; el conector no implementa nada del protocolo.** Es la decisión que más código elimina y más riesgo evita. El SDK resuelve las tres cosas que este bus castiga y **ninguna de las tres falla señalando su causa**: el prefijo de inbox (sin él, *todas* las requests dan timeout y la violación de permisos queda en el log del servidor NATS, no del cliente), las dos credenciales (un token sin el claim de roles conecta a nada y el error dice sólo `Authorization Violation`), y el token en un reconnect (el callout evalúa al conectar y NATS no revalida, así que un token vencido hace que el **reconnect** sea rechazado). Además es estable por contrato: *"the API below is what 1.x will keep"*. La alternativa —reimplementar la gramática, el envelope y el hash de inbox— era **dos copias del contrato del bus sincronizadas a mano**, justo lo que el monorepo de Jiku existe para evitar (ADR-012) |
| 9 | **Comentarios desde respuestas** | ~~**Fuera del alcance v1, y las respuestas se descartan explícitamente.**~~ **DEROGADA por REQ-005 (2026-09-09).** El texto original decía: *"Fuera del alcance v1... no cabe sin estado propio (pregunta abierta 1). Lo importante es la consecuencia: hay que descartar las respuestas de forma activa, porque sin esa regla una respuesta del cliente crearía un requisito duplicado en vez de un comentario"*. **Lo que cambió es su premisa, no su razonamiento:** el razonamiento era correcto —sin estado no cabía— y la pregunta abierta 1 encontró su respuesta en el KV del bus, que no es "estado propio" del conector sino un almacén de una dependencia que ya tenía. Desde S-027 una respuesta con hilo conocido se publica como **Comentario público** del Requisito; el descarte activo se conserva **sólo** para la respuesta cuyo hilo no se conoce, con un motivo propio (`hilo_desconocido`) que lo distingue. Ver [publicacion-requirements-comment](../flows/publicacion-requirements-comment.md) |
| 10 | **Mattermost** | **Fuera de alcance.** Es un canal de salida y en Jiku las notificaciones son un feature group propio del producto: decidir el canal acá lo prejuzgaría |
| 11 | **Imágenes inline** | **Se tratan como adjuntos normales en v1.** El parseo ya conserva `Content-Disposition` y `Content-ID`, así que distinguirlas es posible después. Tratarlas igual significa que la firma de un mail entra como adjunto: ruido aceptable frente a perder una captura de pantalla, que es el adjunto más frecuente de un ticket |
| 12 | **Fallo de un adjunto** | **Se anota y se sigue; nunca cancela el requisito.** Abortar convertiría un archivo corrupto en un ticket perdido, y el ticket es el activo |
| 13 | **Política de archivos** | **La autoritativa es la de `core`; la local es una conveniencia.** `core` lee la doble lista blanca de `system_settings` en caliente, así que la del conector puede desalinearse. Duplicarla como autoritativa obligaría a redesplegar el conector cada vez que Jiku cambia la política |
| 14 | **Logs a stdout** | **Estructurados a stdout, nunca a archivo.** Jiku tiene los transports de archivo de sus dos backends con `filename: undefined` en producción porque las variables no están en el compose. El conector no repite el error, y en un servicio sin usuario mirando los logs son el **único** rastro de un ticket perdido |
| 15 | **Descarte silencioso** | **Un mail que no resuelve se descarta con log y no crea nada.** Crear un requisito en el proyecto equivocado lo haría visible a un cliente que no debía verlo, y eso rompe el aislamiento que sostiene el portal (ADR-006). El descarte es la falla segura |
