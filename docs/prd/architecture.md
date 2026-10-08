---
created: 2026-08-26
last_updated: 2026-08-26
status: Draft
---

# Arquitectura del Producto — jiku-email-tickets

> Derivado del discovery: [análisis técnico](../discovery/analisis-tecnico.md)

## La particularidad que condiciona todo el documento

**Este no es un producto nuevo que elige su arquitectura: es un conector que se somete a la de
Jiku.** Dos consecuencias que conviene tener presentes al leer el resto:

1. **Casi ninguna decisión de comunicación es libre.** El transporte, la gramática de subjects, el
   formato de respuesta, el modelo de identidad y la política de archivos ya están decididos por los
   ADRs de Jiku. Lo que este documento hace con ellos es **registrar a qué se somete**, no elegirlos.
2. **La decisión técnica de mayor impacto ya está tomada y es consumir un paquete**: el SDK
   `@gravadigital/jiku` v1.0.0. Sin él, la mitad de este documento serían decisiones sobre
   reimplementar un protocolo.

---

## Servicios

**Un solo servicio propio.** No hay nada que partir: es un worker con un ciclo de vida —despertar,
traer mails, publicar, dormir— y los tres bounded contexts del dominio (Ingesta, Ruteo, Publicación)
son **módulos internos**, no servicios.

| Servicio | Tecnología | Responsabilidades | Entidades que posee | Base de Datos | APIs Externas |
|---|---|---|---|---|---|
| **jiku-email-tickets** | Node.js ≥ 22.12 + TypeScript 5.x (`strict`, ESM) | Poll IMAP de la casilla de tickets, normalización del mail, ruteo por slug contra su Espacio KV en el bus, y publicación de los dos comandos de escritura al bus de Jiku | Mail Entrante, Adjunto del Mail, Entrada del Mapa de Tickets, Entrada del Mapa de Hilos (**las dos primeras efímeras; las Entradas de los dos mapas viven en el Espacio KV del conector en el bus: el conector no tiene persistencia propia**) *(REQ-008: antes "contra el KV local" y "las tres efímeras o de configuración: ninguna se persiste")* | **Ninguna** | Casilla IMAP, Zitadel (RFC 7523), NATS (bus de Jiku), Storage S3-compatible (`PUT` prefirmado) |

**Las entidades persistidas que el conector crea —Requisito, Archivo, Adjunto— no le pertenecen: son
de Jiku y las escribe `core`.** El conector sólo las pide por comando. Ver la sección de Entidades
del Dominio en [requirements.md](requirements.md).

```
                  ┌──────────────────────────────────────────┐
   Casilla IMAP   │  S1 · jiku-email-tickets (worker)       │
   tickets+slug@ ─┼──> [Ingesta] ──> [Ruteo] ──> [Publicación]
        (poll)    │                                   │      │
                  └───────────────────────────────────┼──────┘
                                                      │
                          @gravadigital/jiku (SDK)    │
                                                      │
                         ┌────────────────────────────┴─────┐
                         │                                  │
                    NATS (bus de Jiku)              Storage S3-compatible
                         │                            (PUT prefirmado)
                         ├── JetStream · JIKU_KV            ▲
                         │     └─ Espacio KV del conector   │
                         │        (tickets. / hilos.)       │
                    auth-callout                            │
                         │                                  │
                    core ─────── firma la URL ──────────────┘
                         │
                    PostgreSQL (jiku)
```

**Nada de lo que está debajo de la línea del SDK es infraestructura del conector**: es Jiku, ya
desplegado. El conector no despliega NATS, ni el callout, ni el storage, ni PostgreSQL. Tampoco
`JIKU_KV`: lo crea el deploy de Jiku, y el conector sólo usa su Espacio KV dentro de él (los Mapas de
Tickets y de Hilos). *(REQ-008: antes el diagrama mostraba el Mapa de Tickets como un "KV
local" dentro del worker.)*

### Servicios descartados y por qué

- **Un servicio de ingesta separado del de publicación** — habría que transportar el mail completo
  con sus adjuntos entre los dos, y el `max_payload` del bus es 1 MB contra adjuntos de hasta 10 MB:
  obligaría a un storage intermedio para resolver un problema que no existe.
- **Un servicio de notificación** — las notificaciones están fuera de alcance funcional, y cuando
  entren son un feature group del **producto**, no de este repositorio.
- **Una base de datos propia** — descartada por la decisión de idempotencia por `\Seen`. Es la
  eliminación de infraestructura más consecuente del diseño: sin base no hay migraciones, ni backup,
  ni volumen que respaldar, ni un segundo esquema que mantener.
- **Un cliente NATS propio** — lo reemplaza el SDK.

### Superficie expuesta

**El conector no expone nada.** Ni HTTP, ni puerto, ni suscripción a subjects de otros. Nadie lo
llama y nadie lo puede llamar; sólo el cron lo despierta. Es la misma forma que `core` —un worker sin
framework web— y por la misma razón: **su contrato es el bus, no una ruta.**

Consecuencia documental, y es deliberada: **no hay especificación OpenAPI para este producto**. No se
generó un `/health` de relleno porque el healthcheck está explícitamente fuera de alcance v1 (Jiku no
lo tiene en ninguno de sus cuatro servicios), y un endpoint documentado que nadie va a implementar
sería un contrato falso para los agentes que leen `docs/apis/`.

---

## Bases de Datos

**Ninguna propia.** La tabla queda declarada en negativo a propósito, porque la ausencia es una
decisión y no un olvido:

| Base de Datos | Tipo | Usada por | Propósito |
|---|---|---|---|
| — | — | — | **El conector no tiene base de datos propia** |
| `jiku` (PostgreSQL) | PostgreSQL | `core` (Jiku) | **El conector NO la alcanza.** Es donde termina la escritura, tres saltos más allá: el conector publica un comando, `core` lo ejecuta, `core` escribe |

**Por qué no hay ninguna, en dos razones independientes que apuntan al mismo lado:**

1. **No puede.** La garantía estructural de Jiku: la api conecta con un rol de PostgreSQL sin
   `INSERT`/`UPDATE`/`DELETE` y `core` es el único escritor (ADR-001 de Jiku). El conector se somete
   a la misma regla y por eso **no lleva cliente de PostgreSQL**.
2. **No necesita.** Su único mecanismo de idempotencia es el flag `\Seen` de IMAP, que vive en el
   servidor de mail. No tiene persistencia **propia**: los mails normalizados viven en memoria
   durante un tick y se descartan al terminar, y el único estado que sobrevive —los Mapas de Tickets
   y de Hilos— vive en el Espacio KV del conector, en el bus (el matiz de ADR-001). *(REQ-008: antes
   "No persiste estado de ninguna clase")*

Consecuencia documental: **no hay documento de esquema en `docs/db-schemas/`** para este producto. Sin
base propia no hay tablas, ni migraciones, ni DBML que poblar. El esquema de las entidades que el
conector **escribe** (Requisito, Archivo, Adjunto) pertenece al PRD de Jiku, no a este repositorio.

---

## Interacciones entre Servicios

### Comunicaciones Internas

Ninguna: **hay un solo servicio.** Los tres módulos internos (Ingesta → Ruteo → Publicación) se
comunican por llamada de función dentro del mismo proceso, secuencialmente, un mail a la vez.

### Integraciones Externas

- **Casilla IMAP → jiku-email-tickets** (IMAP sobre TLS 993, sync, **poll**)
  - La única entrada del sistema. El conector **tira** del mail en vez de recibirlo: un tick por
    expresión cron, sin solaparse con el anterior, procesando a lo sumo N mails **los más nuevos
    primero**.
  - Credenciales: usuario + password IMAP por variable de entorno (App Password en Gmail).

- **jiku-email-tickets → Zitadel** (HTTPS, RFC 7523, sync)
  - Solicita el access token del machine user firmando con la key JSON. Al arrancar y en cada
    refresh (~1 h, en background, lo hace el SDK).
  - **Sin el project id configurado el token no lleva el claim de roles, y un token sin roles no
    conecta a nada.** El error dice sólo `Authorization Violation`.

- **jiku-email-tickets → NATS → `core`** (NATS request/reply **sin JetStream**, **sync**)
  - **Toda la escritura del conector.** Dos formas de comando y ninguna nueva:
    `files.request-upload` y `requirements.new`.
  - Publica y **espera la respuesta**. Sin JetStream no hay cola, reintento, persistencia ni
    idempotencia: si `core` está caído, **la operación no ocurrió**.
  - Timeout: 15 s (el default del SDK), **deliberadamente por encima** de los 10 s del servidor.

- **jiku-email-tickets → Storage S3-compatible** (HTTPS `PUT` a URL prefirmada, sync)
  - Un `PUT` por adjunto aceptado, con el byte directo. **Sin credenciales de S3**: la autorización
    viaja en la URL que `core` firmó.
  - No es una optimización: el `max_payload` del bus es 1 MB y los adjuntos llegan a 10 MB, así que
    es **la única forma**. **No hace falta CORS**: lo hace un proceso de servidor, no un navegador.

- **jiku-email-tickets → stdout** (unidireccional)
  - La única salida de diagnóstico. **No hay a quién reportarle** un fallo: no hay usuario esperando
    ni request que responder.

### Subjects de mensajería

| Subject | Publica | Subscribe | Auth |
|---|---|---|---|
| `{instance}.{sub}.jiku-commands.v1.files.request-upload` | S1 | `core` (queue group `jiku-commands`) | Token de Zitadel del machine user con rol `internal-app`; el callout autoriza `jiku-commands.v1.>` |
| `{instance}.{sub}.jiku-commands.v1.requirements.new` | S1 | `core` (ídem) | Ídem |
| `_INBOX.{hash(sub)}.>` | `core` (las replies) | S1 | El callout mintea el permiso sobre **el hash** del `sub`. El SDK fija el prefijo siempre |

- **`{sub}` es el `sub` del machine user y es infalsificable**: el callout sólo autoriza a publicar
  bajo el id propio. Es lo que hace que `core` pueda confiar en la identidad del subject y resolver
  el actor desde ahí, ignorando lo que el cuerpo declare.
- **El conector no publica ni se suscribe a nada más.** No emite eventos de dominio: `core` tampoco
  lo hace, y el conector no tiene por qué inventar el primero. Los ocho eventos de dominio que
  identifica el análisis de dominio **son líneas de log**, no mensajes.
- **Ningún subject nuevo, ninguna plantilla nueva.** Los dos comandos ya están cubiertos por el
  comodín `jiku-commands.v1.>` de la plantilla existente del auth-callout.

### Patrones de integración

1. **Poll periódico con cap y sin solapamiento (IMAP).** Un tick no se solapa con otro; cada tick
   procesa a lo sumo N mails, los más nuevos primero, y un backlog grande se drena en varios ticks
   sin que el pedido más reciente espere detrás de mil viejos.
2. **Request/reply síncrono para toda escritura (NATS).** El conector publica y espera. Sin
   JetStream, si `core` está caído la operación no ocurrió.
3. **Escritura en dos planos separados: el permiso y el byte.** El permiso viaja por el bus; el byte
   va directo al storage.
4. **Una conexión por proceso, no una por mensaje.** Conectar cuesta un round-trip a Zitadel más un
   handshake de NATS que **corre el auth-callout**.
5. **El token es una función, no un string.** El callout evalúa el token **al conectar** y NATS no
   revalida después; un reconnect vuelve a correrlo, así que un token vencido hace que el
   **reconnect** sea rechazado. El SDK entrega al bus un getter y mantiene el token fresco detrás.
6. **Continue-on-failure en cada nivel.** Un adjunto que falla no cancela el requisito; un mail que
   falla no aborta el tick; un tick que falla no tumba el worker.
7. **Fail-fast sólo al arrancar.** La configuración se valida entera antes de empezar; después, el
   worker no muere por nada.

**Un patrón que deliberadamente no se usa: el timeout corto.** El default del SDK son 15 s, por
encima de los 10 s del servidor, porque PostgreSQL corta a los 8 s y la respuesta llega como un error
que se explica solo. Un timeout más corto del lado del cliente **convierte esa explicación en
silencio**, que es el peor resultado posible en un servicio sin nadie mirando.

---

## Requerimientos Técnicos

### Infraestructura

**Deployment:**

- **Containerización:** Docker. El conector es un proceso único, sin puerto expuesto.
- **Ubicación de red — la única restricción dura y está decidida:** el conector va **dentro de la red
  del bus de Jiku**, que **no está expuesta al ingress**. No puede desplegarse afuera y alcanzar
  NATS.
- **Pendiente de operaciones:** si el compose de Jiku lo incorpora como un servicio más o se
  despliega aparte alcanzando esa red **es una decisión de operaciones que el análisis técnico
  difiere explícitamente**. El registry de la imagen, en cambio, está decidido: el del proyecto en
  GitLab ([ADR-007](../adrs/ADR-007-ci-gitlab-registry-del-proyecto.md)).
- **Instancias: exactamente 1.** Sin idempotencia ni coordinación, dos instancias sobre la misma
  casilla duplicarían tickets (NFR-SC03).

**Entornos:**

- **dev:** local, apuntando a `JIKU_INSTANCE=dev` y a una casilla de prueba (el prefijo del
  subaddress es configurable justamente para eso).
- **production:** `JIKU_INSTANCE=prod`, logs en JSON, dentro de la red del bus.
- **staging:** no definido. Depende de si Jiku tiene una instancia intermedia — pendiente de
  operaciones.

**CI/CD:**

**Decidido (REQ-007, [ADR-007](../adrs/ADR-007-ci-gitlab-registry-del-proyecto.md)).** Jiku usa
GitHub Actions con una matriz de servicios, pero el conector es un repositorio aparte y **no hereda
ese workflow**: usa **GitLab CI** en su propio proyecto de `git.grava.io`, con el Container Registry
del proyecto.

- **Stages:** `build` (typecheck + build, y la imagen `--target production` sin publicar) → `test`
  (la suite **completa**, `npm run test:teardown`, sobre el checkout con `docker:dind`) →
  `release`.
- **Gate:** la suite completa, incluidos los NATS reales y los tests que construyen la imagen. Si
  algo falla, no se publica nada.
- **Tags:** `:dev` desde `dev`; `:<version.txt>` y después `:master` desde `main`. La versión sale
  de `version.txt`, independiente de `package.json#version`. Las ramas de feature, los merge requests
  y los tags de git no publican.
- **El deploy sigue fuera de alcance:** el pipeline entrega la imagen en el registry, no la despliega.

### Preocupaciones Transversales

**Logging:**

- **Estructurado a stdout, nunca a archivo.** JSON en producción. Nivel por defecto: `info`.
- Jiku tiene los transports de archivo de sus dos backends con `filename: undefined` en producción
  porque las variables no están en el compose; el conector **no repite el error**.
- **Es la preocupación transversal más importante de este producto y merece decirlo sin rodeos:** en
  Jiku, cuando una escritura falla, hay un usuario mirando una pantalla que recibe un error. Acá no
  hay nadie — el cliente mandó un mail y se fue. **Un ticket perdido no tiene síntoma.** Los logs no
  son un accesorio de diagnóstico, son el **único** lugar donde un mail perdido deja rastro.
- **Nunca se loguean:** credenciales, tráfico IMAP crudo, el cuerpo del mail, el contenido de un
  adjunto.
- **Cada mail deja al menos una línea** con su `Message-Id` y su resultado: creado (con `projectId` y
  `id`), descartado (con motivo, y con el slug cuando el motivo es que no está mapeado), o fallido
  (con la clase de error y el código).

**Monitoring:**

**Fuera de alcance v1.** Sin healthcheck, sin métricas exportadas, sin alertas. Jiku no tiene
healthcheck en ninguno de sus cuatro servicios: es el mismo hueco, y ninguno de los dos lo resuelve
acá. La única visibilidad agregada es una línea por tick con cinco contadores (ingestados, parseados,
creados, descartados, fallidos).

**Error Tracking:**

Ninguna herramienta. Los errores van al log estructurado, distinguiendo **qué sistema rechazó** por
la clase de error del SDK — es la diferencia entre "no puedo escribir" y saber dónde mirar:

| Clase del SDK | Quién rechazó | Dónde está el arreglo |
|---|---|---|
| `JikuPermissionDenied` | **El bus**, por subject, antes de que `core` viera nada | El rol en Zitadel. **No implica nada sobre `core`** |
| `JikuFailure` / `caller_not_authorized` | El bus dejó pasar y **`core` rechazó por rol** | Típicamente: sin fila en `users`. Reconectar lo corrige solo |
| `JikuFailure` / `invalid_fields` | `core` aceptó el caller y rechazó **la forma** | El payload del conector. **Es prueba de que el plano de escritura está abierto** |
| `JikuFailure` / `project_not_found` | `core`, el proyecto no existe | El Mapa de Tickets |
| `JikuTimeout` | Nada respondió: `core` caído o lento | **El mail se perdió**: ya está `\Seen`, sin reintento |
| `JikuNoEndpoint` | El bus dice **de inmediato** que nada está suscripto | Sin esperar el timeout |
| `JikuInvalidRequest` | Rechazado **localmente**, nada llegó a la red | Error de armado del conector |

### Seguridad

**Autenticación:**

Una sola identidad, de máquina, y ninguna sesión. El conector no autentica a personas —no tiene
usuarios— y no guarda sesión de nada.

| Contexto | Credencial | Formato | Almacenamiento | Vida |
|---|---|---|---|---|
| **Identidad en el bus** | Access token de Zitadel | JWT con claim de roles | En memoria, **nunca en disco** | ~1 h, refrescado en background por el SDK |
| **Credencial raíz** | Key JSON del machine user | JSON (RFC 7523) | **Archivo montado read-only** | Permanente hasta reemplazo. **Zitadel la entrega una sola vez** |
| **Sentinel del bus** | Creds de NATS | `.creds` | Archivo montado read-only | Permanente. **No concede nada por sí solo** |
| **Casilla de mail** | Usuario + password IMAP | — | Variables de entorno | Permanente (App Password en Gmail) |
| **Storage** | **Ninguna** | — | — | La autorización viaja en la URL firmada |

**Los tres puntos donde esto falla sin señalar su causa** (y por los que se usa el SDK):

1. **Sin el project id de Zitadel**, el token no lleva el claim de roles y un token sin roles **no
   conecta a nada**. El error dice sólo `Authorization Violation`.
2. **Las dos credenciales son necesarias y ninguna alcanza sola**: el creds del sentinel se niega
   permisos a sí mismo, y lo que mintea los permisos reales es el token.
3. **El prefijo de inbox**: una conexión puede suscribirse a exactamente un inbox. Cualquier otro
   —incluido el aleatorio que genera todo cliente NATS por default— hace que la reply se publique
   donde nadie escucha. **La request expira sin ningún error visible** y la violación de permisos
   queda en el log del *servidor* NATS. El síntoma apunta a que `core` está caído. No lo está.

**Autorización:**

- Rol **`internal-app`** en el project de gestión de Zitadel. **Sin cambios en `rules.yaml` ni en las
  plantillas del callout**: la plantilla existente ya publica sobre `jiku-commands.v1.>` con comodín.
- **El costo aceptado, declarado sin minimizar:** `internal-app` concede los dos planos completos
  —`commands: ALL`, `queries: ALL`— y ubica al caller en la clase `connector`, **que no recorta
  ninguna fila en las consultas**. El conector va a poder mucho más de lo que necesita. Se acepta en
  v1 porque acotarlo implica crear un rol nuevo con su plantilla y su entrada en el mapa de `core`, y
  eso **modifica el producto** (G-03).
- **La titularidad de los archivos se cumple por construcción**, sin que el conector haga nada:
  `core` resuelve el actor del subject —infalsificable— e ignora lo que el cuerpo declare, así que
  `uploaded_by == actor` se satisface siempre.
- **La autorización que el conector NO hace, y es deliberado:** no verifica quién mandó el mail. Un
  remitente cualquiera que conozca `tickets+<slug>@` crea un requisito en ese proyecto. El servicio
  actual tampoco lo valida; queda como pregunta abierta (NFR-S09).

**Gestión de secretos:**

- Variables de entorno más archivos montados read-only, igual que Jiku, **que no tiene gestor de
  secretos**. Nada horneado en la imagen.
- **La key del machine user se descarga una sola vez** y eso le pone un requisito propio al
  almacenamiento: si se pierde, hay que generar una nueva, no recuperarla.
- **Rotación de la key: sin procedimiento definido.** Pendiente.

### Performance

**Caching:** Ninguno, por diseño: el Mapa de Tickets se consulta en cada mail con un `get` al Espacio
KV, y no se guarda el resultado (un alta o una baja vale desde el mail siguiente). *(REQ-008: antes
el mapa se cargaba en memoria al arrancar)*

**Rate Limiting:** No aplica en el sentido habitual — el conector no recibe requests. El control de
caudal es **el cap por tick** (50 mails por default) más el intervalo del cron (5 min por default).

**Concurrencia: un mail a la vez, un tick a la vez.** Sin paralelismo, a propósito: el volumen no lo
justifica y el orden secuencial hace el log legible, que en este servicio es el único rastro que
queda.

**CDN:** No aplica.

---

## Estrategia de Deployment

**Fase v1:**

- Un contenedor Docker, una instancia, dentro de la red del bus de Jiku.
- Configuración entera por variables de entorno más dos archivos montados (la key del machine user y
  el creds del sentinel).
- **Precondición de `JIKU_KV`:** el bucket lo crea el deploy de Jiku, con `allow_direct` y sin TTL, y
  el rol `internal-app` concede los tres grants del Espacio KV (nunca la forma ancha `$JS.API.>`).
  Agregar un slug es un `nats kv put` sobre el Espacio KV, sin reiniciar. *(REQ-008: antes "por
  variable de entorno o archivo montado; se lee al arrancar", con reinicio para agregar un slug)*
- Sin base de datos, sin volumen que respaldar, sin migraciones que correr. **Es la ventaja operativa
  concreta de no tener persistencia propia.**
- Fail-fast: si falta configuración, el worker no arranca e informa la lista completa.

**Decisiones diferidas a operaciones** (el análisis técnico las declara fuera de su alcance, no son
omisiones de este documento):

| Tema | Estado |
|---|---|
| Compose propio vs. incorporarse al de Jiku | Pendiente. La restricción dura es estar en la red del bus |
| CI/CD, build y registry de la imagen | Decidido (REQ-007, ADR-007): GitLab CI + registry del proyecto. El deploy sigue pendiente |
| Entorno de staging | Depende de si Jiku tiene instancia intermedia |
| Rotación de la key del machine user | Sin procedimiento |
| Gestión de secretos más allá de env + archivos montados | Pendiente. Jiku tampoco tiene gestor |
| Estructura interna del proyecto | La define `/product-create-backend-architecture` |
| Estrategia de testing | Pendiente, con una particularidad: **no hay base contra la que testear**, así que desaparece el patrón de Jiku de correr contra PostgreSQL real. Lo que hay que doblar es el bus y el IMAP, y el SDK ofrece `Client.fromConnection(nc, ...)` para apuntarlo a un NATS de prueba |
| Healthchecks, métricas exportadas y alertas | Fuera de alcance v1 (Jiku tiene el mismo hueco) |

**Post-v1:** las dos evoluciones más probables ya están identificadas y ninguna es de deployment —
son de diseño: **la idempotencia** (el candidato número uno a revisar, y su lugar de resolución es el
producto Jiku, no este repo) y **el ruteo de respuestas a un hilo** para soportar comentarios, que
probablemente arrastre revisar la ausencia de estado propio.
