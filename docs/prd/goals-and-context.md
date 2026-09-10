---
created: 2026-08-26
last_updated: 2026-08-26
status: Draft - In Definition
---

# PRD — Objetivos y Contexto

> Derivado del discovery: [análisis funcional](../discovery/analisis-funcional.md) · [análisis de dominio](../discovery/analisis-dominio.md) · [análisis técnico](../discovery/analisis-tecnico.md)

## Información General del Producto

### Nombre

**jiku-mail-connector**

### Planteo del Problema

El PRD de Jiku declara el problema en su visión: *"El pedido de un cliente que llega por
Mattermost, mail o reunión se pierde o queda sin trazabilidad"*. El portal Opus resolvió el pedido
que el cliente carga él mismo; **el mail quedó afuera**, y es el último canal de pedido sin
trazabilidad.

El mail es el canal que el cliente **ya usa y no va a dejar de usar**. Pedirle que entre a un
portal para algo que resolvía con un mail es fricción que no se puede imponer a una contraparte
externa. El conector acepta el canal del cliente en vez de cambiarlo, y lo hace desembocar en el
mismo modelo que el resto de Jiku: un requisito, en un proyecto, con su trazabilidad hasta las
horas.

**jiku-mail-connector** es un worker sin interfaz que convierte mails en requisitos de Jiku. Una
casilla de tickets con subaddress —`tickets+<slug>@grava.io`— recibe el pedido de un cliente; el
conector lo ingesta por IMAP, resuelve a qué proyecto corresponde por el `<slug>`, y publica en el
bus de Jiku la creación del requisito con sus adjuntos. Para el cliente que escribe el mail, el
conector es invisible: manda un mail y su pedido aparece en Opus. Ese es todo el valor.

### Usuarios Objetivo

El conector es un worker **sin interfaz de usuario**: nadie lo "usa". Los tres actores de abajo
son quienes disparan, configuran o consumen su resultado.

- **U-01: Cliente externo**: Escribe a `tickets+<slug>@grava.io` para pedir algo. **No sabe que el
  conector existe** y no debería tener que saberlo: su única interacción es mandar un mail y, más
  tarde, ver su pedido en el portal Opus. Es quien dispara todo el flujo. No tiene forma de saber
  si su mail se procesó, se descartó o se perdió.

- **U-02: Operador del conector**: Carga el Mapa de Tickets a mano (`slug → projectId`), crea y
  configura el machine user en Zitadel con el rol `internal-app`, y **es el único lector de los
  logs**. Este último punto es el que define su rol: en un servicio sin nadie mirando una
  pantalla, *"un ticket perdido no tiene síntoma"* — los logs no son un accesorio de diagnóstico,
  son el **único** lugar donde un mail perdido deja rastro.

- **U-03: Equipo interno de Jiku**: Consume el resultado. Ve el requisito aparecer en Jiku con su
  proyecto, su tipo y sus adjuntos, y trabaja sobre él como sobre cualquier otro requisito.
  **Nunca toca el conector** ni se entera de que el requisito entró por mail.

---

## Objetivos y Criterios de Éxito

### Objetivos Principales

1. **G-01: Cerrar el canal de pedido por mail sin trazabilidad**: Un pedido que llega por mail a la
   casilla de tickets debe terminar como un requisito en el proyecto correcto de Jiku, con la misma
   trazabilidad que un pedido cargado por el portal. Es el objetivo que justifica el producto.

2. **G-02: No imponerle fricción al cliente externo**: El cliente sigue usando el mail, sin portal,
   sin registro y sin formato obligatorio. El conector se adapta al canal del cliente, no al revés.

3. **G-03: No modificar el producto Jiku**: El conector se integra como **un caller más del bus**,
   sin un comando nuevo en `core`, sin un endpoint nuevo en la api, sin migraciones y sin tocar
   `rules.yaml` ni las plantillas del auth-callout. Es la restricción de alcance más fuerte de v1 y
   lo que hace viable construirlo sin coordinar con el roadmap de Jiku.

4. **G-04: Degradar hacia el descarte, nunca hacia el requisito equivocado**: Un mail que no
   resuelve a un proyecto se descarta con log y no crea nada. Crear un requisito en el proyecto
   incorrecto lo haría visible a un cliente que no debía verlo, y eso rompe el aislamiento que
   sostiene todo el portal.

5. **G-05: Dejar rastro de todo lo que no salió bien**: En un worker sin usuario esperando, cada
   mail perdido, descartado o fallido tiene que quedar registrado con su motivo. Es la única
   defensa contra una pérdida silenciosa.

### Métricas de Éxito

> **Propuestas, no medidas.** El conector no instrumenta ninguna hoy, igual que el resto de Jiku.
> Métricas exportadas y healthchecks están fuera del alcance v1.

| Métrica | Objetivo | Plazo | Valida |
|---|---|---|---|
| Tickets creados sobre mails con slug válido | > 99% | Semanal | G-01 |
| Mails descartados por slug no mapeado | Tendiendo a 0 | Semanal | G-01, G-04 |
| Latencia de mail a requisito | < 2× el intervalo del poll | Continuo | G-01, G-02 |
| Adjuntos vinculados sobre adjuntos aceptados | > 98% | Semanal | G-01 |
| Comandos fallidos por `caller_not_authorized` | 0 | Semanal | G-03 |
| Tickets duplicados detectados a mano | 0 | Mensual | G-05 (el costo real de no tener idempotencia) |

---

## Contexto

### Sistemas Existentes

- **`grava-gestion/mail-integration` v1.0.0**: El servicio que hace esto hoy. De él sale **todo el
  dominio del mail**: ingesta IMAP, parseo, ruteo por slug, política de adjuntos. **No es una
  migración de código**: el servicio actual escribe directo en PostgreSQL con Sequelize y sube a S3
  con credenciales propias, y en Jiku **no puede hacer ninguna de las dos cosas**. Se conserva el
  dominio del mail; la mitad de la escritura se reescribe contra el bus.

- **Jiku (`core`, api, portal Opus)**: El producto destino. El conector le escribe por el bus NATS
  usando **dos comandos que ya existen** —`requirements.new` y `files.request-upload`— y no
  modifica nada. `core` es el único escritor de la base y del storage.

- **Bus NATS de Jiku + auth-callout + Zitadel**: La infraestructura de escritura, ya desplegada. El
  conector la consume; no la provisiona. El auth-callout valida su token y mintea sus permisos; la
  fila del conector en `users` **la crea Jiku sola** en su primera autenticación.

- **`@gravadigital/jiku` v1.0.0 (SDK oficial del bus)**: Paquete publicado y estable
  (*"the API below is what 1.x will keep"*). Es **la pieza que más simplifica el conector**: aporta
  `client.command()` sobre el plano de escritura y `ServiceUser.fromKeyFile()` para exactamente
  esta clase de identidad desatendida. El conector **lo consume; no reimplementa nada del
  protocolo**.

- **Casilla IMAP `tickets+<slug>@grava.io`**: Externa a Jiku y al conector. La única entrada del
  sistema. Requiere subaddress habilitado e IMAP sobre TLS.

### Decisiones Clave

> Transcritas del log de decisiones del discovery. El log completo, con las 15 decisiones y su
> fundamentación extendida, está en
> [análisis funcional — Decisiones Tomadas](../discovery/analisis-funcional.md#decisiones-tomadas).

- **Nada de base ni de storage: sólo comandos del bus** (decisión 2): No es una preferencia de
  diseño, es la garantía estructural de Jiku — la api conecta con un rol de PostgreSQL sin
  `INSERT`/`UPDATE`/`DELETE` y `core` es el único escritor (ADR-001), y el storage tiene un solo
  dueño que también es `core`. Elimina de un golpe el cliente de PostgreSQL, los modelos y las
  credenciales de S3 del servicio actual.

- **Se consume el SDK oficial; el conector no implementa nada del protocolo** (decisión 8): Es la
  decisión que más código elimina y más riesgo evita. El SDK resuelve las tres trampas de este bus
  y **ninguna de las tres falla señalando su causa**: el prefijo de inbox (sin él *todas* las
  requests dan timeout y la violación queda en el log del servidor NATS, no del cliente), las dos
  credenciales (un token sin el claim de roles no conecta a nada y el error dice sólo
  `Authorization Violation`), y el token en un reconnect. La alternativa eran dos copias del
  contrato del bus sincronizadas a mano.

- **La idempotencia es el `\Seen` de IMAP y nada más; el conector no persiste nada** (decisión 1):
  Un conector con idempotencia real sería **más fuerte que el producto al que le escribe** —ADR-002
  ya asume que un comando perdido es un comando perdido, sin cola ni reintento—. Se acepta la doble
  falla —ticket perdido o duplicado— a cambio de un conector sin estado. **Es el candidato número
  uno a revisar** si la pérdida silenciosa resulta intolerable en la práctica.

- **El mapa `slug → projectId` es un KV local cargado a mano, con el id como valor** (decisión 3):
  `ticket_slug` existe en la base de Jiku pero está **deliberadamente no expuesto ni filtrable** en
  el contrato de consultas del bus, y está marcado para eliminarse: un conector que resolviera por
  bus **no tiene por dónde**. Guardar el id y no el nombre es lo que hace al KV autosuficiente.

- **El alta no valida el proyecto antes de crear** (decisión 4): Validar el proyecto antes de crear
  no agregaría información —`core` ya responde `project_not_found`, que nombra el problema real— y
  duplicaría la validación con la peor de las dos decidiendo. Además el plano de lectura exige fila
  en `users`, así que validar antes **adelantaría el fallo con un código que no señala la causa**.

  *(PRECISADA por REQ-006 / S-030: esta decisión se enunciaba como "**El conector no consulta el
  bus: sólo escribe**". Esa restricción quedó **derogada puntualmente**: desde REQ-006 el conector
  consulta el plano de lectura en **un caso enumerado** —`attachments.list` filtrando por
  `entityType`, `entityId`, `checksum` y `uploadedBy`, para reusar un adjunto ya vinculado al
  Requisito del hilo— y nada más (ADR-003, Implementation Rule del plano de consultas; invariante 28).
  **Lo que la decisión realmente decide sigue vigente entero:** el alta no valida el proyecto antes
  de crear, por el argumento de arriba, que no se apoyaba en la prohibición sino en el diagnóstico
  de `core`. Ver también ADR-004, vigente.)*

- **El autor es el machine user del conector, resuelto del subject por `core`** (decisión 6): No hay
  persona detrás de un mail entrante, y `resolveActor` ya hace exactamente esto para un publicador
  externo: el actor es el `sub` del subject —infalsificable— y lo que el conector declare se
  ignora. El `MAIL_BOT_USER_ID` seedeado a mano del servicio actual **desaparece**.

- **La política de archivos autoritativa es la de `core`; la local es una conveniencia**
  (decisión 13): `core` lee la doble lista blanca en caliente de `system_settings`, así que la del
  conector puede desalinearse. Duplicarla como autoritativa obligaría a redesplegar el conector
  cada vez que Jiku cambia la política.

- **Logs estructurados a stdout, nunca a archivo** (decisión 14): Jiku tiene los transports de
  archivo de sus dos backends con `filename: undefined` en producción porque las variables no están
  en el compose. El conector no repite el error.

- **Un mail que no resuelve se descarta con log y no crea nada** (decisión 15): El descarte es la
  falla segura, y es un resultado **correcto y esperado**, no un error: la casilla recibe spam y
  respuestas automáticas.

- **Las respuestas a un hilo se descartan de forma activa** (decisión 9): Los comentarios desde
  respuestas quedan fuera del alcance v1, y la consecuencia hay que declararla — sin la regla de
  descarte, una respuesta del cliente crearía **un requisito nuevo duplicado** en vez de un
  comentario. Un "fuera de alcance" pasivo sería un bug.

### El costo aceptado del rol `internal-app`

El conector se declara como un caller más del bus con el rol `internal-app`, que Jiku ya tiene
definido exactamente para esto: *"Para habilitar un conector: crear un machine user en Zitadel con
Access Token Type = JWT y asignarle el rol `internal-app`. No hace falta tocar nada de este
archivo"*.

Eso tiene un **costo que hay que declarar y no minimizar**: `internal-app` concede los dos planos
completos —`commands: ALL, queries: ALL`— y ubica al caller en la clase `connector`, que **no
recorta ninguna fila en las consultas**. El conector va a poder mucho más de lo que necesita. Se
acepta en v1 porque acotarlo implica **crear un rol nuevo con su plantilla y su entrada en el mapa
de `core`, y eso modifica el producto** (G-03). Queda registrado como fuera de alcance.

---

## Alcance

### Dentro del Alcance (v1)

- **Ingesta IMAP por poll** de la casilla de tickets, con cap por tick y marcado `\Seen`
- **Parseo y normalización** del mail: asunto limpio, cuerpo en texto plano sin texto citado,
  referencias del hilo, remitente, adjuntos
- **Resolución del proyecto por `<slug>`** contra un KV local cargado a mano
- **Descarte silencioso** de todo lo que no resuelve (sin slug, slug no mapeado, respuesta a un
  hilo, mail sin `Message-Id`, mail no parseable)
- **Alta del requisito en Jiku** publicando `requirements.new`, con traducción de la respuesta y de
  sus errores por sistema que rechazó
- **Adjuntos**: partición por política local, `files.request-upload` + `PUT` directo a la URL
  prefirmada, y vínculo por `fileIds` en el alta del requisito
- **Identidad en el bus**: machine user con `ServiceUser.fromKeyFile()` y auto-refresh del token
- **Configuración con fail-fast** al arrancar, con la lista completa de lo que falta
- **Observabilidad por logs estructurados a stdout**, con métricas por tick

### Fuera del Alcance (v1)

- **Comentarios desde respuestas al hilo** — es la mitad del servicio existente y **no cabe en v1
  sin estado propio**: el ruteo de una respuesta a su requisito necesita el mapa
  `Message-Id → requisito`, que hoy vive en una tabla de Jiku que el conector no puede escribir
- **Notificaciones a Mattermost** — es un canal de salida, no de entrada; en Jiku las notificaciones
  son un feature group propio del producto, y ahí es donde se decide el canal
- **Rol de conector acotado** — acotar `internal-app` es crear un rol nuevo: modifica el producto
- **Interfaz de administración del KV** — implicaría que el mapa es dato del producto, y esa es una
  decisión de Jiku
- **Verificación del byte subido** — nadie lo verifica en Jiku tampoco; agregarlo acá sería más
  estricto que el producto
- **Barrido de archivos huérfanos** — está fuera de alcance del producto entero
- **Idempotencia real** (decisión 1) — el producto tampoco la tiene
- **Healthchecks y métricas exportadas** — Jiku no tiene healthcheck en ninguno de sus cuatro
  servicios; es el mismo hueco y su lugar es el producto
- **Webhook / push del proveedor de mail** — el poll alcanza para el volumen y no depende del
  proveedor
- **Reintento de un comando fallido** — consecuencia directa de la decisión 1
- **Recarga en caliente del KV** — se lee al arrancar
- **Cualquier interfaz de usuario** — es un worker

### Restricciones

- **Técnicas — permitido:** publicar los comandos de escritura de `core` bajo la identidad propia;
  hacer `PUT` contra una URL prefirmada que `core` firmó; leer el KV de su propia configuración.
- **Técnicas — prohibido:** conectarse a PostgreSQL; tener credenciales de S3; crear o modificar
  comandos de `core`; agregar endpoints a la api; correr migraciones; editar `rules.yaml` o las
  plantillas del auth-callout.
- **Arquitectura:** repositorio propio, sin código compartido con el monorepo de Jiku. **La única
  puerta de entrada al producto es el bus NATS**: no hay HTTP, no hay base de datos propia, y no se
  toca la base de Jiku.
- **Runtime:** Node.js ≥ 22.12 (es el `engines` floor del SDK y **parte de su superficie
  pública**), TypeScript 5.x con `strict: true`, módulos ESM (el SDK es ESM-only).
- **Red:** el conector necesita alcanzar NATS. En el deploy de Jiku esa red **no está expuesta al
  ingress**, así que el conector va dentro de esa red, no afuera.
- **Precondiciones de despliegue:** machine user en Zitadel con Access Token Type = JWT y rol
  `internal-app` asignado (**la key JSON se descarga una sola vez** y no se puede volver a bajar);
  creds del sentinel del bus montado; project id de Zitadel configurado (sin él el token no lleva
  roles y no conecta a nada); casilla con subaddress e IMAP habilitados; KV cargado.
