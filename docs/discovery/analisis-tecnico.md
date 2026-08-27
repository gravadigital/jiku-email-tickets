---
created: 2026-08-26
last_updated: 2026-08-26
status: Análisis técnico cerrado
documento_base: "analisis-funcional.md + analisis-dominio.md (jiku-mail-connector)"
---

# Análisis Técnico — jiku-mail-connector

> **Qué es este documento.** La pre-arquitectura del conector: tecnologías, servicios,
> comunicación y flujos clave. `/product-initialize-technical` lo lee para **transcribir** —
> derivar el documento de arquitectura, los ADRs y las especificaciones— en lugar de entrevistar.
>
> **Límite de alcance, declarado.** Este documento decide **tecnologías, servicios, comunicación
> y flujos**. Quedan deliberadamente afuera CI/CD, estrategia de testing, observabilidad
> exportada, estructura del proyecto y hosting: están en
> [Decisiones Operativas Fuera de Alcance](#decisiones-operativas-fuera-de-alcance).
>
> **La particularidad que condiciona todo el documento.** Este no es un producto nuevo que elige
> su arquitectura: es un **conector que se somete a la de Jiku**. Dos consecuencias:
>
> 1. **Casi ninguna decisión de comunicación es libre.** El transporte, la gramática de subjects,
>    el formato de respuesta, el modelo de identidad y la política de archivos ya están decididos
>    por los ADRs de Jiku. Lo que este documento hace con ellos es **registrar a qué se somete**,
>    no elegirlos.
> 2. **La decisión técnica de mayor impacto ya está tomada y es consumir un paquete**: el SDK
>    `@gravadigital/jiku` v1.0.0. Sin él, la mitad de este documento serían decisiones sobre
>    reimplementar un protocolo.

---

## Mapa de Servicios

**Un solo servicio propio.** No hay nada que partir: es un worker con un ciclo de vida —despertar,
traer mails, publicar, dormir— y los tres bounded contexts del dominio (Ingesta, Ruteo,
Publicación) son **módulos internos**, no servicios. Partirlos exigiría un transporte entre ellos
para transportar mails con adjuntos de 10 MB, y no hay ninguna razón para pagar eso.

```
                  ┌──────────────────────────────────────────┐
   Casilla IMAP   │  S1 · jiku-mail-connector (worker)       │
   tickets+slug@ ─┼──> [Ingesta] ──> [Ruteo] ──> [Publicación]
        (poll)    │                     │             │      │
                  │              Mapa de Tickets      │      │
                  │                (KV local)         │      │
                  └───────────────────────────────────┼──────┘
                                                      │
                          @gravadigital/jiku (SDK)    │
                                                      │
                         ┌────────────────────────────┴─────┐
                         │                                  │
                    NATS (bus de Jiku)              Storage S3-compatible
                         │                            (PUT prefirmado)
                    auth-callout                            ▲
                         │                                  │
                    core ─────── firma la URL ──────────────┘
                         │
                    PostgreSQL (jiku)
```

**Nada de lo que está debajo de la línea del SDK es infraestructura del conector**: es Jiku, ya
desplegado. El conector no despliega NATS, ni el callout, ni el storage.

### Servicios

| # | Servicio | Responsabilidad |
|---|---|---|
| S1 | **jiku-mail-connector** | El worker completo: poll IMAP, normalización, ruteo por slug contra el KV, y publicación de los dos comandos de escritura al bus de Jiku |

### Infraestructura Compartida

> **Toda es de Jiku y ya existe.** El conector la consume; no la provisiona ni la versiona.

| Componente | Rol |
|---|---|
| **NATS 2.10** (bus de Jiku, sin JetStream) | El único canal de escritura. Request/reply |
| **auth-callout** | Valida el token del conector y mintea sus permisos de publicación e inbox |
| **Zitadel** | Emite el token del machine user. Fuente de la identidad y del rol `internal-app` |
| **core** | Valida y ejecuta los comandos; **firma la URL prefirmada** del storage |
| **Storage S3-compatible** | Recibe el `PUT` del byte. El conector lo alcanza **sin credenciales**, sólo con la URL firmada |
| **PostgreSQL `jiku`** | **El conector NO lo alcanza.** Aparece en el diagrama sólo para mostrar dónde termina la escritura |
| **Casilla IMAP** | Externa a Jiku y al conector. La única entrada del sistema |

### Servicios eliminados / fusionados

- **Un servicio de ingesta separado del de publicación** — descartado. Habría que transportar el
  mail completo con sus adjuntos entre los dos, y el `max_payload` del bus es 1 MB: obligaría a un
  storage intermedio para resolver un problema que no existe. Son dos módulos del mismo proceso.
- **Un servicio de notificación** — no aplica: las notificaciones están fuera de alcance
  funcional, y cuando entren son un feature group del **producto**, no de este repo.
- **Una base de datos propia del conector** — descartada por la decisión 1 del análisis funcional
  (idempotencia por `\Seen`). Es la eliminación de infraestructura más consecuente del diseño: sin
  base no hay migraciones, ni backup, ni volumen que respaldar, ni un segundo esquema que
  mantener.
- **Un cliente NATS propio** — descartado por la decisión 8. Lo reemplaza el SDK.

---

## Tecnologías por Servicio

### S1 — jiku-mail-connector

| Pieza | Tecnología | Razón |
|---|---|---|
| Runtime | **Node.js ≥ 22.12** | Es el `engines` floor del SDK, y **parte de su superficie pública**: subirlo es un major. No es una preferencia, es un requisito |
| Lenguaje | **TypeScript 5.x**, `strict: true` | Es la convención transversal de Jiku, y el servicio actual ya es TS. `strict` porque el conector **escribe** datos: es el mismo criterio con que `core` lo tiene prendido y la api no |
| Módulos | **ESM** | El SDK es ESM-only. No es negociable |
| Cliente del bus | **`@gravadigital/jiku` ^1.0.0** | La decisión 8. Resuelve las tres trampas del bus que no señalan su causa, y es estable por contrato dentro de 1.x |
| Identidad | **`ServiceUser.fromKeyFile()`** (del SDK, RFC 7523) | La forma que el propio SDK documenta para un servicio desatendido. Refresca el token en background, que es lo que hace sobrevivir un reconnect |
| Config del bus | **`loadConfig()`** (del SDK) | Lee `JIKU_*` del entorno con los defaults correctos. Evita redeclarar a mano el timeout, que tiene una razón no obvia (ver Patrones) |
| IMAP | **`imapflow`** | Lo que ya usa el servicio actual, funcionando en producción. No hay razón para cambiarlo |
| Parseo de mail | **`mailparser`** (`simpleParser`) | Ídem. Resuelve MIME, adjuntos y headers, que es exactamente el trabajo sucio que no se quiere reescribir |
| HTML → texto | **`html-to-text`** | Ídem, con la configuración ya probada (ignorar `href`, saltear `img`) |
| Scheduler | **`node-cron`** | Ídem. El poll es un cron y no necesita más |
| HTTP (sólo el `PUT`) | **`fetch` nativo** | Un solo `PUT` a una URL prefirmada. Traer `axios` para eso es dependencia sin retorno |
| Checksum | **`node:crypto`** | sha256 de la librería estándar |
| Logging | **estructurado a stdout** (`pino` o `winston`) | Ver la decisión 14 del funcional: nunca a archivo. La elección concreta es menor; lo que importa es stdout y JSON en producción |
| Validación de config | **fail-fast propio al arrancar** | El servicio actual ya lo hace y es la diferencia entre *"faltan X, Y y Z"* y descubrirlos de a uno con un deploy cada vez |
| Tests | **`node:test`** + doble del bus | El runner nativo alcanza y es lo que usa el SDK. Ver Fuera de Alcance para la estrategia |

### Dependencias que el servicio actual tiene y el conector NO lleva

Vale la pena la tabla, porque **es la medida real del cambio arquitectónico**:

| Dependencia de hoy | Por qué desaparece |
|---|---|
| `pg`, `sequelize`, `sequelize-typescript` | El conector no toca PostgreSQL (ADR-001). **Se van los 6 modelos y los 6 repositorios** |
| `@aws-sdk/client-s3` | No tiene credenciales de S3: el `PUT` va a una URL que `core` firmó |
| `axios` | Sólo lo usaba el notificador de Mattermost, fuera de alcance |
| `reflect-metadata` | Era para los decoradores de `sequelize-typescript` |
| `@testcontainers/postgresql` | No hay base contra la que testear |

Cinco dependencias menos y dos capas enteras —modelos y repositorios— que dejan de existir. El
conector queda con **una dependencia de integración (el SDK) y cuatro de dominio del mail**.

---

## Comunicación entre Servicios

### Conexiones

| De → A | Protocolo | Dirección | Naturaleza |
|---|---|---|---|
| Casilla IMAP → S1 | IMAP sobre TLS (993) | S1 **tira** (poll) | Periódico, por cron. **La única entrada del sistema** |
| S1 → Zitadel | HTTPS (RFC 7523) | unidireccional | Al arrancar y en cada refresh del token (~1 h) |
| S1 → NATS → `core` | **NATS request/reply**, sin JetStream | bidireccional (con reply) | **Síncrono**. Toda la escritura. 2 formas de comando |
| S1 → Storage S3 | HTTPS `PUT` a URL prefirmada | unidireccional | Un `PUT` por adjunto aceptado. **Sin credenciales** |
| S1 → stdout | — | unidireccional | La única salida de diagnóstico. **No hay a quién reportarle** |

**Lo que no existe y conviene decirlo:** el conector **no expone nada**. Ni HTTP, ni puerto, ni
suscripción a subjects de otros. Nadie lo llama y nadie lo puede llamar; sólo el cron lo despierta.
Es la misma forma que `core` —un worker sin framework web— y por la misma razón: su contrato es el
bus, no una ruta.

### Patrones

1. **Poll periódico con cap y sin solapamiento (IMAP).** El conector tira del mail en vez de
   recibirlo. Un tick no se solapa con otro, y cada tick procesa a lo sumo N mails, **los más
   nuevos primero**: un backlog grande se drena en varios ticks sin que el pedido más reciente
   espere detrás de mil viejos.
2. **Request/reply síncrono para toda escritura (NATS).** ADR-002 de Jiku: el conector publica y
   **espera la respuesta**. Sin JetStream no hay cola, reintento, persistencia ni idempotencia — si
   `core` está caído, **la operación no ocurrió**.
3. **Escritura en dos planos separados: el permiso y el byte.** El permiso viaja por el bus
   (`files.request-upload` devuelve un `fileId` y una URL firmada); el byte va **directo al
   storage** por HTTPS. No es una optimización: el `max_payload` del bus es 1 MB y los adjuntos
   llegan a 10 MB, así que es la única forma.
4. **Una conexión por proceso, no una por mensaje.** Conectar cuesta un round-trip a Zitadel más un
   handshake de NATS que **corre el auth-callout**. El cliente se construye al arrancar y se
   conserva.
5. **El token es una función, no un string.** El callout evalúa el token **al conectar** y NATS no
   revalida después; un reconnect vuelve a correrlo, así que un token vencido hace que el
   **reconnect** sea rechazado. El SDK entrega al bus un getter y mantiene el token fresco detrás.
6. **Continue-on-failure en cada nivel.** Un adjunto que falla no cancela el requisito; un mail que
   falla no aborta el tick; un tick que falla no tumba el worker.
7. **Fail-fast sólo al arrancar.** La configuración se valida entera antes de escuchar; después, el
   worker no muere por nada.

**Un patrón que deliberadamente no se usa: el timeout corto.** El default del SDK son 15 s, **por
encima** de los 10 s del servidor, porque PostgreSQL corta a los 8 s y la respuesta llega como un
error que se explica solo. Un timeout más corto del lado del cliente **convierte esa explicación en
silencio**, que es el peor resultado posible en un servicio sin nadie mirando.

### Subjects de mensajería

| Subject | Publica | Subscribe | Auth |
|---|---|---|---|
| `{instance}.{sub}.jiku-commands.v1.files.request-upload` | S1 | `core` (queue group `jiku-commands`) | Token de Zitadel del machine user con rol `internal-app`; el callout autoriza `jiku-commands.v1.>` |
| `{instance}.{sub}.jiku-commands.v1.requirements.new` | S1 | `core` (ídem) | Ídem |
| `_INBOX.{hash(sub)}.>` | `core` (las replies) | S1 | El callout mintea el permiso sobre **el hash** del `sub`. El SDK fija el prefijo siempre |

- **`{sub}` es el `sub` del machine user y es infalsificable**: el callout sólo autoriza a publicar
  bajo el id propio. Es lo que hace que `core` pueda confiar en la identidad del subject.
- **El conector no publica ni se suscribe a nada más.** No emite eventos: `core` tampoco lo hace, y
  el conector no tiene por qué inventar el primero.
- **Ningún subject nuevo, ninguna plantilla nueva.** Los dos comandos ya están cubiertos por el
  comodín `jiku-commands.v1.>` de la plantilla existente.

---

## Tokens y Autenticación

**Filosofía: una sola identidad, de máquina, y ninguna sesión.** El conector no autentica a
personas —no tiene usuarios— y no guarda sesión de nada. Su identidad es un **machine user de
Zitadel**, y es la misma para todo lo que hace.

| Contexto | Token / credencial | Formato | Alcance | Almacenamiento | Transporte | Vida |
|---|---|---|---|---|---|---|
| **Identidad en el bus** | Access token de Zitadel | JWT con claim de roles | El rol `internal-app` en el project de gestión | En memoria, **nunca en disco** | Al conectar a NATS, vía el callout | ~1 h, **refrescado en background por el SDK** |
| **La credencial raíz** | Key JSON del machine user | JSON (RFC 7523) | Firma la solicitud del access token | **Archivo montado read-only** | No se transporta: se lee local | Permanente hasta que se reemplace |
| **Sentinel del bus** | Creds de NATS | `.creds` | **No concede nada por sí solo** — se niega pub/sub sobre `>` | Archivo montado read-only | Al conectar | Permanente |
| **Casilla de mail** | Usuario + password IMAP | — | Lectura y marcado de `INBOX` | Variables de entorno | IMAP sobre TLS | Permanente (App Password en Gmail) |
| **Storage** | **Ninguna** | — | — | — | La autorización **viaja en la URL firmada** | El TTL que declare `system_settings` |

**Los tres puntos donde esto falla sin señalar su causa**, y por los que se usa el SDK:

1. **Sin el project id de Zitadel configurado**, el token no lleva el claim de roles, y un token sin
   roles **no conecta a nada**. El error dice sólo `Authorization Violation`.
2. **Las dos credenciales son necesarias y ninguna alcanza sola**: el creds del sentinel se niega
   permisos a sí mismo, y lo que mintea los permisos reales es el token.
3. **El prefijo de inbox**: una conexión puede suscribirse a exactamente un inbox. Cualquier otro
   —incluido el aleatorio que genera todo cliente NATS por default— hace que la reply se publique
   donde nadie escucha. **La request expira sin ningún error visible** y la violación de permisos
   queda en el log del *servidor* NATS. El síntoma apunta a que `core` está caído. No lo está.

**La autorización que el conector NO hace, y es deliberado:** no verifica quién mandó el mail. Un
remitente cualquiera que conozca `tickets+<slug>@` crea un requisito en ese proyecto. El servicio
actual tampoco lo valida; queda como pregunta abierta 5 del funcional.

---

## Flujos Clave

> **Los nombres de campo de acá son autoritativos**: bajan a `docs/flows/` del conector. Salen
> verbatim de `docs/apis/core.yaml` de Jiku, no de una paráfrasis.

### Flujo 1 — Arranque del worker

```
1. Proceso arranca
   ↓ valida la config entera; si falta algo, ABORTA con la lista completa
   ↓ carga el Mapa de Tickets (vacío es válido; mal formado ABORTA)
2. ServiceUser.fromKeyFile(keyFile, { issuer, projectId })
   → Zitadel: solicita el access token (RFC 7523)
   ← JWT con el claim de roles          [sin projectId → token sin roles → no conecta]
   ↓ auth.userId  =  el `sub`, derivado de la key
3. connect({ servers, instance, credsFile, auth, onTokenError })
   → NATS: CONNECT con creds del sentinel + token
   → auth-callout: valida el token, matchea `internal-app` en rules.yaml,
                   mintea pub sobre {instance}.{sub}.jiku-commands.v1.>
                   y sub sobre _INBOX.{hash(sub)}.>
   ← conexión aceptada; el SDK fijó inboxPrefix
   ↓ EFECTO LATERAL: el callout publica {instance}.events.auth
                     y core espeja la fila en `users`     [la precondición de escribir]
4. CronScheduler.start()  →  el worker queda vivo
```

**El paso 3 tiene el efecto lateral más importante del arranque y no es del conector**: su fila en
`users` la crea Jiku al consumir ese evento. El conector la necesita —la compuerta de `core` lee
`users.roles` y sólo exime al service user de la api, y `requirements.created_by` /
`files.uploaded_by` tienen FK real— y **no puede crearla**. Se resuelve sola en la primera
conexión, y si el evento se pierde (entrega no durable) los comandos fallan con
`caller_not_authorized` hasta la próxima autenticación.

### Flujo 2 — Un tick sin adjuntos (el camino corto)

```
1. cron dispara  →  si hay un tick en curso, SALTEA con warn
2. IMAP: connect → lock INBOX → search({ seen: false })
   ↓ ordena UIDs desc, toma los primeros N (warn si difirió alguno)
3. por cada UID:  download → simpleParser → marca \Seen
   ↓ normaliza → { messageId, referenceIds, recipient, senderEmail, subject, body, attachments }
4. RUTEO
   ↓ referenceIds no vacío?        → DESCARTA (respuesta, fuera de alcance v1)
   ↓ extractTicketSlug(recipient)  → sin slug     → DESCARTA
   ↓ mapa[slug]                    → sin entrada  → DESCARTA (log con el slug)
   → projectId
5. client.command('requirements.new', {
       creator: auth.userId,          // core lo resuelve del subject e IGNORA esto
       title: truncate(subject, 255) || 'Ticket recibido por mail',
       description: body || '(mail sin contenido)',
       projectId,
       type: 'incidencia',
       priority: 'sin_prioridad',
       visibilityLevel: 'public'
   })
   → {instance}.{sub}.jiku-commands.v1.requirements.new
   ← { id }                                    [core: valida el proyecto, escribe, commit]
6. log: messageId, projectId, requirementId
```

### Flujo 3 — Un tick con adjuntos (el camino completo)

```
   ... pasos 1-4 idénticos al Flujo 2 ...

5. POLÍTICA LOCAL:  particiona attachments  →  { aceptados, rechazados }
   ↓ rechazados → un aviso por cada uno: "archivo adjunto: <nombre>"

6. por cada aceptado (hasta 10), con dedup por checksum intra-mail:
   6a. client.command('files.request-upload', {
           uploader: auth.userId,      // IGNORADO: core resuelve el actor del subject
           fileName, mimeType, fileSize, checksum
       })
       ← { fileId, uploadUrl }         [core: valida la DOBLE lista blanca contra
                                        system_settings EN CALIENTE, construye la clave
                                        {prefix}/f/{uuid}{ext}, INSERT files
                                        byte_status='pending', firma PutObject]
       ✗ failure → aviso + sigue con el próximo (continue-on-failure)

   6b. fetch(uploadUrl, { method: 'PUT', body: content })
       → el BYTE va DIRECTO al storage. No pasa por el bus ni por la api
       ✗ falla → aviso + sigue. El archivo queda con byte_status='pending'

   6c. acumula fileId  +  placeholder:  image/* → ![attach:{id}]   resto → [attach:{id}]

7. description = cuerpo
                 + avisos de rechazo
                 + avisos de fallo de subida
                 + placeholders          ← SIEMPRE al final (orden determinístico)

8. client.command('requirements.new', { ...igual que el Flujo 2, fileIds: [...] })
   ← { id }        [core, EN UNA TRANSACCIÓN: crea el requisito, valida titularidad
                    de cada fileId (uploaded_by == actor resuelto del subject),
                    INSERT attachments por cada uno, commit]
   ✗ failure → NADA del requisito sobrevive, pero las filas de `files` SÍ:
               quedan HUÉRFANAS, y es un estado válido en Jiku
```

**La ventana de inconsistencia del paso 6 al 8 es real y no se cierra:** los archivos existen antes
que el requisito, y si el paso 8 falla quedan huérfanos para siempre. El orden inverso es imposible
—los `fileIds` son argumento del alta— y Jiku ya declara el archivo sin vínculo como estado válido.

### Flujo 4 — Los tres rechazos de un comando

Tres sistemas distintos, tres arreglos distintos. El log **tiene que decir cuál fue**:

```
client.command(...)
  ├─ JikuPermissionDenied     EL BUS rechazó por subject, antes de que core viera nada.
  │                           → la plantilla del rol no concede el plano de comandos.
  │                           ARREGLO: el rol en Zitadel. Nada implica sobre core.
  ├─ JikuFailure caller_not_authorized
  │                           EL BUS dejó pasar y CORE rechazó por rol.
  │                           → típicamente: sin fila en `users` (evento perdido).
  │                           ARREGLO: reconectar; se corrige solo.
  ├─ JikuFailure invalid_fields
  │                           CORE aceptó el caller y rechazó la FORMA.
  │                           → PRUEBA de que el plano de escritura está abierto.
  │                           ARREGLO: el payload del conector.
  ├─ JikuFailure project_not_found
  │                           → el Mapa de Tickets apunta a un proyecto inexistente.
  │                           ARREGLO: el KV.
  ├─ JikuTimeout              nada respondió. core caído, o lento.
  │                           → EL MAIL SE PERDIÓ: ya está \Seen. Sin reintento.
  ├─ JikuNoEndpoint           el bus dijo YA que nada está suscripto (sin esperar timeout).
  └─ JikuInvalidRequest       rechazado LOCALMENTE. Nada llegó a la red.
```

---

## Validación de Cobertura

**Cobertura: 38/40 requerimientos funcionales.** Los 2 no cubiertos son diferidos declarados, con
su razón — no omisiones.

| Categoría | Requerimiento | Cubierto por |
|---|---|---|
| Ingesta | Poll periódico de la casilla | `node-cron` + `imapflow`, un tick por expresión cron |
| Ingesta | Sólo mails no leídos | `search({ seen: false })` |
| Ingesta | Cap por tick, más nuevos primero | Orden desc de UIDs + slice, con warn de los diferidos |
| Ingesta | Marcado `\Seen` al procesar | `messageFlagsAdd` por UID |
| Ingesta | Sin solapamiento de ticks | Guard de tick en curso en el scheduler |
| Ingesta | Un mail que falla no aborta el lote | try/catch por ítem, con contadores |
| Ingesta | Un tick que falla no tumba el worker | try/catch en el job |
| Ingesta | Credenciales y tráfico IMAP nunca en el log | `logger: false` en el cliente IMAP |
| Normalización | `messageId` obligatorio | Validación de la forma normalizada |
| Normalización | `referenceIds` = `In-Reply-To` ∪ `References` | Unión deduplicada preservando orden |
| Normalización | Destinatario con subaddress | `Delivered-To`, fallback `To` |
| Normalización | Asunto sin `Re:`/`Fwd:`/`RV:` | Regex iterativa, case-insensitive |
| Normalización | Cuerpo en texto plano | `mailparser`; `html-to-text` si es sólo HTML |
| Normalización | Recorte del texto citado | Función de recorte sobre el resultado, única para las dos ramas |
| Normalización | Email del remitente aislado | Extracción del header `From` |
| Ruteo | Extracción del slug del subaddress | Regex `^<prefijo>\+([^@]+)@`, prefijo configurable |
| Ruteo | Slug siempre en minúsculas | Normalización en las dos puntas |
| Ruteo | `slug → projectId` | Mapa de Tickets (KV local), cargado al arrancar |
| Ruteo | Descarte silencioso con log | Rama de descarte, con el slug en el log cuando lo hubo |
| Ruteo | KV vacío es válido; mal formado aborta | Validación al arrancar |
| Ruteo | Las respuestas se descartan **activamente** | Guard de `referenceIds` no vacío |
| Publicación | Identidad de machine user con refresh | `ServiceUser.fromKeyFile()` del SDK |
| Publicación | Una conexión por proceso | `connect()` en el arranque, cliente conservado |
| Publicación | Prefijo de inbox correcto | Lo fija el SDK, siempre |
| Publicación | Alta del requisito | `client.command('requirements.new', ...)` |
| Publicación | Título truncado a 255 | `truncate()` antes de publicar |
| Publicación | Placeholders de título y cuerpo vacíos | Defaults configurables |
| Publicación | Distinguir qué sistema rechazó | Clases de error del SDK (Flujo 4) |
| Adjuntos | Política local + tope de tamaño | Servicio puro de partición |
| Adjuntos | Permiso + `PUT` directo + vínculo | `files.request-upload` → `fetch` PUT → `fileIds` |
| Adjuntos | Dedup por checksum intra-mail | `Set` de checksums durante el recorrido |
| Adjuntos | Tope de 10 por requisito | Corte del recorrido; el resto queda como aviso |
| Adjuntos | Composición determinística de la descripción | Orden fijo: cuerpo → rechazos → fallos → placeholders |
| Adjuntos | Fallo de un adjunto no cancela el requisito | continue-on-failure en el bucle |
| Observabilidad | Logs estructurados a stdout | Logger con JSON en producción |
| Observabilidad | Métricas por tick | Contadores en el resultado del tick, al log |
| Observabilidad | No loguear cuerpo ni adjuntos | Política del logger; sólo ids y resultados |
| Configuración | Fail-fast con la lista completa | Validación al arrancar |
| **Idempotencia** | **Evitar requisitos duplicados** | **❌ Diferido — decisión 1: sólo `\Seen`. Sin garantía en ninguna de las dos direcciones (pérdida y duplicado). Requeriría estado propio, que el diseño elimina a propósito** |
| **Recuperación** | **Reintento de un comando fallido** | **❌ Diferido — ADR-002 de Jiku: sin JetStream no hay reintento. Un comando perdido es un comando perdido, y el conector no puede ser más fuerte que el bus** |

**Los dos diferidos son el mismo hueco visto de dos lados**, y su lugar de resolución no es este
repositorio: es FG-3 del producto Jiku (Durabilidad y Observabilidad de la Escritura).

---

## Decisiones Operativas Fuera de Alcance

Diferidas a una iteración posterior, por el límite de alcance de este documento:

- **Estructura del proyecto** — repositorio propio, pero la organización interna de carpetas la
  define `/product-create-backend-architecture` con su manifest y sus convenciones.
- **CI/CD** — pipeline, publicación de la imagen y registry. Jiku usa GitHub Actions con matriz de
  servicios; el conector es un repo aparte y no hereda ese workflow.
- **Estrategia de testing** — el enfoque tendrá que resolver algo que no es obvio: **no hay base
  contra la que testear**, así que desaparece el patrón de Jiku de correr contra PostgreSQL real
  (ADR-013). Lo que hay que doblar es el bus y el IMAP, y el SDK ofrece
  `Client.fromConnection(nc, ...)` para apuntarlo a un NATS de prueba.
- **Observabilidad exportada** — healthchecks, métricas y alertas. Jiku no tiene healthcheck en
  ninguno de sus cuatro servicios: es el mismo hueco, y ninguno de los dos lo resuelve acá.
- **Hosting y deploy** — el conector necesita estar en la **red del bus** de Jiku, que no está
  expuesta al ingress. Si el compose de Jiku lo incorpora o se despliega aparte alcanzando esa red
  es una decisión de operaciones.
- **Gestión de secretos** — hoy son variables de entorno y archivos montados, igual que Jiku, que
  no tiene gestor de secretos. La key del machine user **se descarga una sola vez** y eso le pone
  un requisito propio al almacenamiento.
- **Rotación de la key del machine user** — sin procedimiento definido.
- **Recarga en caliente del Mapa de Tickets** — hoy se lee al arrancar; cambiarlo exige reiniciar.

---

## Resumen de Decisiones Técnicas

| # | Tema | Decisión |
|---|---|---|
| Arq-1 | Servicios | **Un solo worker.** Los tres bounded contexts son módulos internos: partirlos exigiría transportar mails con adjuntos de 10 MB entre servicios, contra un `max_payload` de 1 MB |
| Arq-2 | Persistencia propia | **Ninguna.** Sin PostgreSQL, sin migraciones, sin volumen. Consecuencia directa de la decisión 1 (idempotencia por `\Seen`) y de ADR-001 |
| Arq-3 | Cliente del bus | **`@gravadigital/jiku` ^1.0.0.** Resuelve el prefijo de inbox, las dos credenciales y el token en un reconnect — las tres trampas que no señalan su causa. Estable por contrato en 1.x |
| Arq-4 | Superficie de escritura | **Dos comandos, y ninguno nuevo:** `files.request-upload` y `requirements.new`. Cero cambios en el producto Jiku |
| Arq-5 | Plano de lectura | **No se usa.** El KV resuelve el proyecto; validar por consulta duplicaría la validación y acoplaría el arranque a la sincronización de `users` (decisión 4) |
| Arq-6 | Identidad | **Machine user de Zitadel con rol `internal-app`**, vía `ServiceUser.fromKeyFile()`. Sin cambios en `rules.yaml` ni en las plantillas del callout |
| Arq-7 | Transferencia del byte | **`PUT` directo a URL prefirmada**, con `fetch` nativo y **sin credenciales de S3**. Única forma posible dado el `max_payload` |
| Arq-8 | Runtime | **Node ≥ 22.12, TypeScript `strict`, ESM.** El floor y el formato de módulos los impone el SDK; `strict` porque el conector escribe |
| Arq-9 | Dominio del mail | **Se conservan `imapflow`, `mailparser`, `html-to-text` y `node-cron`** del servicio actual: funcionan en producción y son ortogonales al cambio de arquitectura |
| Arq-10 | Dependencias eliminadas | **Cinco:** `pg`, `sequelize`, `sequelize-typescript`, `@aws-sdk/client-s3`, `axios` (más `reflect-metadata` y los testcontainers). Se van también las capas de modelos y repositorios |
| Arq-11 | Timeout del bus | **El default del SDK (15 s), sin bajarlo.** Está por encima del servidor a propósito: PostgreSQL corta a los 8 s y devuelve un error que se explica. Un timeout más corto lo convierte en silencio |
| Arq-12 | Logs | **Estructurados a stdout, nunca a archivo.** Jiku tiene los transports de archivo con `filename: undefined` en producción; en un servicio sin nadie mirando el log es el único rastro de un ticket perdido |
| Arq-13 | Manejo de errores del bus | **Se distingue qué sistema rechazó** —bus, `core` por rol, `core` por forma— por las clases de error del SDK. Tres arreglos distintos, y el log tiene que decir cuál |
| Arq-14 | Concurrencia | **Un mail a la vez, un tick a la vez.** Sin paralelismo: el volumen no lo justifica y el orden secuencial hace el log legible |
