---
id: arranque-y-conexion-al-bus
title: Arranque y conexión al bus
type: event
status: Draft
created: 2026-08-27
last_updated: 2026-08-28
stories: [S-002, S-003, S-004, S-006, S-007, S-011, S-012]
---

# Arranque y Conexión al Bus

**Tipo:** Evento
**Status:** Draft
**Creado:** 2026-08-27
**Última actualización:** 2026-08-28 (S-011 implementada: el Paso 8 — schedular el tick y el apagado ordenado — ya está implementado, no pendiente. S-012 implementada: el Paso 1 valida también el Mapa de Tickets, el prefijo y los placeholders — ya no queda nada fuera del arranque)
**Stories:** S-002, S-003, S-004, S-006, S-007, S-011, S-012

## Descripción

Flujo completo del arranque del `jiku-mail-connector`, desde la validación de su configuración hasta
la conexión establecida con el bus NATS de Jiku. Se dispara al iniciar el proceso (`npm run start` o
el `CMD` del contenedor — desde S-006 ese `CMD` existe y es `node dist/index.js`, verificado sobre la
imagen construida). Cubre la validación fail-fast de la configuración, la construcción del
logger, la construcción de la identidad desde la key del machine user, el único `connect()` del
proceso, y el **efecto lateral no provocado** de que Jiku cree la fila del conector en `users`.

Este flujo **no publica ningún comando**: deja el proceso vivo con un cliente conectado. La
publicación es del flujo [publicacion-requirements-new](publicacion-requirements-new.md).

## Servicios Involucrados

| Servicio | Rol | Tipo de Participación |
|----------|-----|-----------------------|
| jiku-mail-connector | Valida su configuración, construye identidad y conexión | Iniciador |
| Zitadel | Emite el access token (JWT con claim de roles) a partir de la key firmada | Procesador |
| Bus NATS + auth-callout | Evalúa el token al conectar y autoriza los subjects de la identidad | Procesador |
| Jiku (`core`) | Consume el evento del auth-callout y crea la fila del conector en `users` | Consumidor |

## Pasos del Flujo

```mermaid
sequenceDiagram
    participant MC as jiku-mail-connector
    participant ZI as Zitadel
    participant BUS as Bus NATS (auth-callout)
    participant CORE as Jiku core

    MC->>MC: validar configuración (Zod, onValidationError)
    alt falta algo requerido
        MC-->>MC: exit ≠ 0 con la lista completa
    else configuración OK
        MC->>MC: construir logger Pino (stdout, redact)
        MC->>MC: ServiceUser.fromKeyFile() → auth.userId
        alt key inexistente o JSON inválido
            MC-->>MC: exit ≠ 0, sin volcar el contenido
        else key OK
            MC->>ZI: firmar con la key (RFC 7523)
            ZI-->>MC: access token (JWT, ~1 h, sólo en memoria)
            MC->>BUS: connect({ servers, instance, credsFile, auth, onTokenError })
            alt sin rol internal-app
                BUS-->>MC: Authorization Violation → exit ≠ 0 (rechazo del bus por subject)
            else autorizado
                BUS-->>MC: conexión establecida (una sola, conservada)
                BUS->>CORE: evento del auth-callout (no durable)
                CORE->>CORE: INSERT users (identity_type: service, email NULL)
                MC-->>MC: log de arranque exitoso (sin credenciales)
            end
        end
    end
    loop cada ~1 h
        MC->>ZI: refresh del token (lo hace el SDK, en background)
        alt refresh falla
            ZI-->>MC: onTokenError → log error, proceso VIVO
        else refresh OK
            ZI-->>MC: token nuevo, MISMA conexión
        end
    end
```

### Paso 1: Validar la configuración

**Origen:** jiku-mail-connector
**Destino:** (interno)
**Tipo:** Interno

**Acción:** `src/config/env.ts` — el **único** módulo que toca `process.env` — valida con
`createEnv({ ..., onValidationError })` de `@t3-oss/env-core` + Zod. El handler recibe **todos** los
issues en una sola invocación y lanza `ConfigValidationError` una sola vez con la lista completa.

> **Corregido en S-002.** La opción `emitErrors: true` que este paso documentaba no existe en
> `@t3-oss/env-core@0.13.11`; la API real es `onValidationError`. La agregación de issues que el paso
> describe se mantiene igual — se verificó que con varias variables inválidas el handler se invoca una
> vez con todas. Lo que no sirve es el handler *por defecto*: parte el reporte en un `console.error`
> con el array crudo de issues y un `Error` genérico sin ningún nombre adentro, así que el conector
> aporta el suyo (`src/config/errors.ts`), que nombra las variables y nunca interpola valores.

**Variable del `projectId` de prueba:** se llama `JIKU_VERIFY_PROJECT_ID` (fijado en S-002). Es el
proyecto de **Jiku** (entero) del modo de verificación, y no debe confundirse con `JIKU_PROJECT_ID`,
que es el project de **Zitadel** (UUID).

**Composición con el SDK:** la configuración del bus se lee con `loadConfig()` del SDK, invocado
dentro de `src/config/index.ts`, y su resultado se compone con el `env` validado en un único
`AppConfig`. El `env` se valida **antes** de llamar a `loadConfig()`, porque este último lee el
filesystem y CA-2 exige fallar sin intentar nada antes.

**Variables del alcance:**

| Variable | Requerida | Default |
|---|---|---|
| `JIKU_CREDS` | Sí | — |
| `JIKU_KEY_FILE` | Sí | — |
| `JIKU_PROJECT_ID` | Sí | — |
| `JIKU_VERIFY_PROJECT_ID` | Sí | — |
| `JIKU_INSTANCE` | No | `dev` |
| `JIKU_SERVERS` | No | `nats://localhost:4222` |
| `JIKU_ISSUER` | No | `https://id.grava.io` |
| `JIKU_TIMEOUT` | No | `15000` (**piso**, no baja) |
| `LOG_LEVEL` | No | `info` |
| `NODE_ENV` | No | `production` (agregada en S-003 — ver la nota del Paso 2) |
| `IMAP_HOST` | Sí | — |
| `IMAP_PORT` | No | `993` |
| `IMAP_USER` | Sí | — |
| `IMAP_PASSWORD` | Sí | — |
| `POLL_CRON` | No | `*/5 * * * *` |
| `POLL_ENABLED` | No | `true` |
| `POLL_MAX_PER_TICK` | No | `50` |
| `TICKET_MAP` | **Condicional** (una de las dos) | — |
| `TICKET_MAP_FILE` | **Condicional** (una de las dos) | — |
| `SUBADDRESS_PREFIX` | No | `tickets` |
| `PLACEHOLDER_TITLE` | No | `Ticket recibido por mail` |
| `PLACEHOLDER_BODY` | No | `(mail sin contenido)` |

Las de **IMAP ya se declaran y son requeridas** (S-007): con la ingesta en alcance dejaron de ser
opcionales, y esto **supera el criterio 5 de REQ-001**. Con S-012 **ya no queda nada afuera**: las
cinco del ruteo se validan en este mismo paso, y el Mapa de Tickets pasó a ser **requerido**
(supersede el criterio 40 de REQ-002).

**La validación cruzada de las dos fuentes del mapa.** `TICKET_MAP` (inline) y `TICKET_MAP_FILE`
(archivo montado) son **excluyentes**: exactamente una tiene que estar declarada. Ninguna → no
arranca; las dos → tampoco, porque elegir una en silencio dejaría a U-02 editando la que no tiene
efecto. Es la única regla **cross-field** de todo el schema, y por eso no vive en una clave: vive en
el `createFinalSchema` de `src/config/env.ts`.

**La lectura del archivo ocurre DENTRO de la validación del schema**, en el `.transform()` de
`TICKET_MAP_FILE`, y no después de `loadEnvFromProcess()`. La razón es la lista única: si la carga
ocurriera después, un despliegue sin `IMAP_HOST` y con el archivo del mapa roto informaría **dos
veces, en dos formatos distintos** — que es exactamente lo que este paso existe para evitar. La
consecuencia aceptada es que la validación del schema deja de ser pura y toca el **filesystem**: es
la misma clase de excepción que `POLL_CRON` ya hace llamando a `cron.validate()` en el arranque, y
por la misma razón. La lectura es **sincrónica** (`readFileSync`) porque el schema de `createEnv` no
admite refinements asincrónicos, y ocurre **una sola vez al arrancar**, antes de que exista ningún
trabajo concurrente.

`POLL_CRON` se valida con **`cron.validate()` de `node-cron`, en el arranque** — no al schedular.
Sin esa validación temprana, un cron mal formado explotaría recién en `cron.schedule()` (Paso 8, ya
con el logger construido y la conexión abierta): un worker vivo que nunca ingesta nada y **sin
síntoma**, que es exactamente el fallo diferido que este paso existe para evitar.

`POLL_ENABLED` **no** usa `z.coerce.boolean()`: `Boolean('false')` es `true`, así que la coerción
automática habilitaría el poll cuando se pidió deshabilitarlo, en silencio. La coerción es explícita
sobre `z.enum(['true','false'])`, y un valor que no sea uno de los dos **no arranca**.

La configuración del bus se lee con `loadConfig()` del SDK, invocado **dentro de `src/config/`** para
no duplicar sus defaults ni romper el punto de lectura único.

> **Implementado en S-012.** El paso quedó como lo describe la acción, con **un hallazgo que vale la
> pena dejar registrado** porque es contraintuitivo y le ahorra el descubrimiento a la próxima story
> que toque el módulo.
>
> **`createEnv` no valida un `z.object()`, y eso decide dónde puede vivir cada validación.** La
> librería recorre el schema como un **diccionario plano de shapes** (`parseWithDictionary()`),
> validando cada clave por separado y **acumulando** todos los issues antes de invocar
> `onValidationError` una sola vez. Eso es lo que hace que un `IMAP_HOST` ausente y un
> `TICKET_MAP_FILE` roto salgan juntos: sale gratis, por construcción, siempre que la validación
> viva **en una clave**.
>
> **La trampa está en la regla cross-field.** El diseño de REQ-003 decía "un `superRefine` sobre el
> objeto parseado" para la regla de las dos fuentes. Escrito de la forma obvia —
> `z.object(shape).superRefine(...)` dentro de `createFinalSchema`— **rompe la lista única en
> silencio**: Zod **no corre el refinement si alguna clave del objeto ya falló**, así que en el caso
> que más importa (falta una variable del bus **y** el mapa no está declarado) el issue del mapa
> **nunca aparece**, y el operador arregla una cosa para descubrir la otra en la corrida siguiente.
> `.check()` se comporta igual. Verificado empíricamente contra `@t3-oss/env-core@0.13.11` y
> `zod@4.4.3`, no inferido de la documentación.
>
> **La forma que sí cumple es un híbrido.** Las seis formas de mapa mal formado viven en las claves,
> como `.transform()` con `ctx.addIssue()`, y se agregan solas. **Sólo** la regla de las dos fuentes
> —que es genuinamente cross-field— vive en `createFinalSchema`, implementada como un **Standard
> Schema propio** que corre el `safeParse()` del objeto **y además** la regla, y **concatena las dos
> listas de issues siempre**, sin cortar. Hay un test que lo protege
> (`test/config/env.test.ts` → *reports the absent map together with a missing bus variable*): falla
> con la implementación ingenua y pasa con esta, que es la única forma de saber que el test protege
> lo que dice proteger.
>
> **Un detalle de tipos que sorprende:** con `createFinalSchema` declarado, la librería **deja de
> usar `parseWithDictionary()`** y delega la validación entera en ese schema — así que hay que
> reponer ahí lo que aquella función hacía (acumular con la clave como primer segmento del `path`).
> `z.object()` ya hace las dos cosas; alcanza con no cortar después.

**Ref:** S-002, S-007, S-012; ADR-002, ADR-004; convención `env-config`

---

### Paso 2: Construir el logger

**Origen:** jiku-mail-connector
**Destino:** (interno)
**Tipo:** Interno

**Acción:** `src/shared/logger.ts` construye **una** instancia de Pino con destino **stdout**, nivel
tomado de `LOG_LEVEL`, `pino-pretty` sólo con `NODE_ENV === 'development'` y JSON en producción, y
`redact` con `censor: '[REDACTED]'` sobre credenciales, tokens y contenido de key/creds.

**Por qué antes de conectar:** el arranque y **cada fallo de conexión** ya tienen que salir por un
logger que redacta. Un logger agregado después dejaría sin cubrir el tramo más sensible.

> **Implementado en S-003.** El paso quedó como lo describe la acción, con cuatro divergencias
> respecto de lo que el documento predecía. Se registran porque las cuatro se descubrieron
> verificando contra la versión instalada y le ahorran el descubrimiento a quien venga después.
>
> **1. La firma es `createLogger(config, destination?, transportTarget?)`, no una constante de
> módulo.** El catálogo `logging` muestra `export const logger = pino({...})`. Acá el logger se
> construye con una factory y el singleton se inicializa explícitamente desde `src/index.ts` con
> `initLogger(config)`; `getLogger()` lo devuelve y **falla claro** si se lo usa antes. La razón es
> que el `AppConfig` se resuelve de forma asíncrona: construir el singleton en el import obligaría a
> disparar la carga de configuración como efecto de importar el módulo, y eso rompe la propiedad de
> S-002 de que importar `#config/index.js` no valida nada por su cuenta. Los dos parámetros
> opcionales son para tests (ver punto 3).
>
> **2. `NODE_ENV` no existía en el schema y se agregó acá.** El paso asume poder discriminar el
> formato por `NODE_ENV`, pero S-002 declaró nueve variables y ninguna era esa. Eso es un choque real
> entre dos criterios: CA-2 exige discriminar por entorno y CA-5 prohíbe que el logger lea
> `process.env` por su cuenta. Se resolvió **declarando `NODE_ENV` en `envSchema`** como
> `z.enum(['development', 'test', 'production']).default('production')` y propagándola a `AppConfig`
> como `nodeEnv`, que el logger recibe por parámetro como todo lo demás. No se resolvió leyendo
> `process.env.NODE_ENV` en el logger porque eso rompería la propiedad verificable de S-002 (el
> `grep process.env src/` devuelve un solo archivo), que es más valiosa que la comodidad. **El
> default es `production`, no `development`, y es deliberado:** el modo caro y bonito se pide
> explícitamente; un despliegue que se olvidó de declararla emite JSON, que es lo correcto, y el
> error inverso —producción intentando cargar un `pino-pretty` que `--omit=dev` dejó afuera de la
> imagen— es peor. El schema pasó de nueve variables a diez y `AppConfig` de nueve campos a diez.
>
> **3. `transport` y `destination` NO son incompatibles en `pino@10.3.1`, pero el transporte gana.**
> Se esperaba que pasar los dos lanzara. Verificado: no lanza, y el `destination` queda sin recibir
> nada. Eso es peor que un error, porque un test que inyecta un sink leería vacío y **pasaría en
> verde** — el peor modo de falla para una suite cuyo trabajo es detectar un secreto sin censurar.
> Por eso el transporte se construye sin destino, y el destino gana en el camino sin transporte. El
> tercer parámetro (`transportTarget`) existe para que la degradación del punto 4 sea afirmable en
> CI: con `pino-pretty` instalado como devDependency el target siempre resuelve, así que sin ese
> parámetro el `catch` quedaría sin cobertura automatizada.
>
> **4. Los comodines de `redact.paths` son de UN SOLO NIVEL y no hay comodín profundo.** Verificado
> contra `pino@10.3.1`: `'*.token'` cubre `{ auth: { token } }` pero **no** cubre `{ token }` en la
> raíz ni `{ a: { b: { token } } }` a dos niveles, y **`'**.token'` no redacta nada** — no falla, no
> avisa, deja el secreto en claro. Es exactamente la clase de detalle donde una suposición razonable
> produce una lista que parece proteger y no protege. Por eso cada campo va **duplicado** en
> `src/shared/log-redaction.ts` (la forma en raíz y la forma con comodín) y la duplicación está
> comentada para que nadie la "limpie". El índice con comodín (`'attachments[*].content'`) sí está
> soportado, en las dos formas. Los contextos de tres niveles o más quedan fuera de alcance
> declarado: los puntos de log del conector son planos o de un nivel, y una story que anide más tiene
> que agregar la ruta explícita.
>
> **También se agregaron `keyFile` y `credsFile` a la lista de redacción**, que el plan no preveía:
> son rutas a archivos de secretos, y dónde está el secreto también es información sobre el secreto.
> Es el mismo criterio por el que la línea de arranque los excluye deliberadamente; la diferencia es
> que ahí se resuelve por omisión y acá por redacción, que cubre el log que los incluya por error.

**Ref:** S-003; convención `logging`; NFR-O01, NFR-S06

---

### Paso 3: Construir la identidad desde la key

**Origen:** jiku-mail-connector
**Destino:** (interno — lee un archivo montado read-only)
**Tipo:** Interno

**Acción:** `ServiceUser.fromKeyFile(keyFile, { issuer, projectId })`. El `user-id` que irá en el
subject sale de `auth.userId`, **derivado de la key y nunca del entorno** (invariante 17).

**Ref:** S-004; ADR-005; NFR-S03

> **Implementado en S-004** — `src/infra/bus/identity.ts` (`buildServiceUser()`), con dos
> divergencias verificadas contra `@gravadigital/jiku@1.0.0`:
>
> **1. `ServiceUser` valida la key en el CONSTRUCTOR, y tiene cuatro modos de fallo, no dos.** El
> paso —y CA-4— mencionan el archivo ausente y el JSON mal formado. Los verificados son cuatro, y
> los cuatro salen por la misma llamada porque el constructor lee, parsea, valida la forma y carga
> la private key:
>
> | Entrada | `cause` del `JikuError` |
> |---|---|
> | Archivo inexistente | `Error` con `code: 'ENOENT'` |
> | JSON mal formado | `SyntaxError` de `JSON.parse` |
> | JSON válido sin `key`/`keyId`/`userId` | — (mensaje del SDK) |
> | `key` que no es una private key leíble | `Error` con `code: 'ERR_OSSL_UNSUPPORTED'` |
>
> Los cuatro se traducen a un único `KeyLoadError`, porque los cuatro tienen el mismo arreglo:
> revisar el archivo montado. La causa exacta viaja intacta en `cause`. **Ninguno de los cuatro
> filtra el contenido de la key** — verificado con un archivo cuyo contenido era
> `-----BEGIN RSA PRIVATE KEY-----SUPERSECRETVALUE`. Se afirma igual con un test, porque lo que hoy
> no filtra puede filtrar en un minor y CA-4 es exactamente sobre eso: la garantía se mantiene
> **estructural** encadenando por `cause` en vez de interpolar el mensaje del SDK en el propio.
>
> **2. La identidad no necesita red, y por eso CA-2 es afirmable en un test unitario.**
> `serviceUser.userId` y `await serviceUser.subject()` salen de la key directamente. Verificado con
> un `issuer` inalcanzable: ambos resuelven igual. El token recién se pide al conectar.
>
> **Nota sobre `scopes`, que parece una omisión y no lo es:** el código **no pasa `scopes`** a
> propósito. El default del SDK ya es `['openid', 'profile']`, y `profile` es **obligatorio** aunque
> parezca innecesario para un servicio: el auth-callout publica un evento que `core` convierte en la
> fila de `users`, y `core` **exige un nombre** en ese evento. El nombre llega por el endpoint de
> userinfo, que sólo lo devuelve si se pidió `profile`. Un token con `openid` solo produce un evento
> sin nombre, `core` lo descarta, **la fila no se crea**, y todo pedido posterior se rechaza con
> `caller_not_authorized` — un fallo silencioso que aparece **tres servicios más allá** de su causa.
> Optimizarlo a `['openid']` rompería el Paso 6.

---

### Paso 4: Obtener el access token

**Origen:** jiku-mail-connector
**Destino:** Zitadel
**Tipo:** REST (HTTPS, RFC 7523)

**Acción:** el SDK firma con la key y obtiene el access token — un JWT con claim de roles, ~1 h de
vida. El conector **no implementa nada** del intercambio.

**Response (éxito):** access token, **sólo en memoria**. Nunca a disco, nunca al log. El SDK lo expone
como **getter, no como string**.

**Ref:** S-004; ADR-005; NFR-S02

> **Implementado en S-004** (por el SDK; el conector no codea nada del intercambio), con una
> divergencia que **cambia la forma de la tabla de errores**:
>
> **El SDK pide el token ANTES de abrir el socket, deliberadamente.** De su propio código:
> *"Fail before connecting if no token can be had. A NATS authorization violation says nothing about
> which of the two credentials was the problem."*
>
> Consecuencia: donde el flujo veía **un** fallo de conexión, hay **dos**, con arreglos en lugares
> distintos — *Zitadel no entregó el token* (`jiku: obtaining an access token`) y *el bus rechazó el
> token* (`jiku: the bus refused the credentials`). El conector los distingue como
> `zitadel_no_entrego_token` y `rechazo_del_bus_por_subject`. Es el criterio de ADR-006 —decir qué
> sistema rechazó— aplicado un nivel más adentro de lo que el ADR lo escribió.
>
> Efecto observable, verificado ejecutando el `dist/`: con una key válida y un bus apuntado a un
> puerto cerrado, el arranque **no falla por red** sino por token, porque nunca llega a la red. No es
> un bug: es el orden que el SDK eligió.
>
> **Por eso el conector pide el token él mismo, antes de `connect()`.** No duplica trabajo —el SDK
> cachea el token, así que no cuesta un round-trip de más— y no es una preferencia de estilo: es lo
> único que permite atribuir el fallo **positivamente**. Si se deja fallar adentro de `connect()`, el
> error llega como un `JikuError` envolviendo lo que sea que el `TokenSource` haya lanzado (un fetch
> fallido, un `OAuthError`, un `TypeError`), y por estructura es indistinguible de un fallo
> inclasificable. La alternativa habría sido atribuirlo **por descarte** —"si no es red ni creds ni
> autorización, debe ser Zitadel"— y eso es exactamente adivinar: convertiría cualquier fallo de
> conexión desconocido en "revisá Zitadel", que es el diagnóstico equivocado que ADR-006 existe para
> evitar.

---

### Paso 5: Conectar al bus

**Origen:** jiku-mail-connector
**Destino:** Bus NATS + auth-callout
**Tipo:** Interno (conexión NATS vía SDK)

**Acción:** `connect({ servers, instance, credsFile, auth, onTokenError })` — **exactamente una vez**.
El cliente resultante se conserva por toda la vida del proceso. El callout evalúa el token **al
conectar** y NATS **no revalida** después. `onTokenError` queda registrado.

**Response (éxito):** cliente conectado. Una línea de log de arranque exitoso, **sin ninguna
credencial**.

**Ref:** S-004; ADR-002; C-14, NFR-P05

> **Implementado en S-004** — `src/infra/bus/connection.ts` (`connectToBus()`), el **único** lugar
> del código que invoca `connect()`, afirmado por un test que escanea `src/`. Tres notas:
>
> **1. La clasificación del fallo NO puede leer el texto del mensaje del SDK, y esto es lo más fácil
> de "simplificar" mal.** El regex de `connectError()` del SDK es
> `/no servers available|CONNECTION_REFUSED|ECONNREFUSED|ENOTFOUND/i`, pero
> `@nats-io/transport-node` reporta un puerto cerrado como `"connection refused"` — **minúscula y con
> espacio** — que no matchea ninguna de las cuatro alternativas. Verificado: **un puerto cerrado cae
> en la rama genérica del SDK (`jiku: connecting to ...`) mientras un host irresoluble cae en la
> específica**, y las dos son "bus inalcanzable" para el conector. Por eso `diagnoseConnectFailure()`
> clasifica por **estructura** — `isJikuError()`, el `name` del error del transporte, y los `code` de
> `errno` de la cadena de `cause` — y nunca por `String(error).includes(...)`. Si alguien "arregla"
> esto leyendo el mensaje, el diagnóstico de un puerto cerrado empieza a mandar a revisar Zitadel.
>
> **2. Hay un quinto modo de fallo que ni la story ni este flujo enumeraban: el creds ilegible.** El
> SDK lee `credsFile` **antes** de abrir el socket y lo envuelve en
> `jiku: the sentinel creds file "..." is unreadable`. Su arreglo está en el **montaje del archivo**,
> no en Zitadel ni en la red, así que se diagnostica aparte (`creds_ilegible`) en lugar de colapsarlo
> en "bus inalcanzable".
>
> **3. `onTokenError` no es opcional en la práctica, y registrarlo cierra un agujero de S-003.** Su
> default documentado es *"a warning on the console"* — un `console.warn` **fuera de Pino y por lo
> tanto sin `redact`**, en un servicio cuyo único borde es el log. Registrarlo no es sólo el Paso 7:
> es cerrar un escape a la redacción.
>
> **Lo que NO se pasa, y es deliberado:** `userId` (el `d.ts` dice *"LEAVE IT UNSET"*; se deriva del
> `sub`) y `inboxPrefix` (lo fija el SDK siempre). Hay un test de escaneo que lo afirma sobre el
> objeto de opciones de `connect()`.

---

### Paso 6: Jiku crea la fila del conector en `users` (efecto lateral)

**Origen:** Bus NATS (auth-callout)
**Destino:** Jiku (`core`)
**Tipo:** Evento

**Evento consumido:** el evento del auth-callout de la primera autenticación de esta identidad.

**Operación de BD:**
- **Tabla:** `users` (base de Jiku)
- **Operación:** INSERT
- **Campos:** `identity_type: service`, `email` en `NULL`

**El conector no la crea ni la pide** (G-03, ADR-005). La **verifica**, no la provoca. La entrega de
este evento **no es durable** (NATS sin JetStream): si se pierde, el conector queda sin fila hasta su
próxima autenticación, y reconectar lo resuelve.

**Ref:** S-004 CA-9, CA-16 de S-005; ADR-005

> **Verificado en S-004, no implementado** — y la distinción es el punto entero de este paso. El
> conector no codea nada para que ocurra: la fila la crea Jiku sola. Lo que S-004 aporta es la
> **verificación por escaneo de fuentes** de que no hay ningún camino que la cree o la pida —
> ninguna invocación de `client.command(`, ningún literal `'users.*'`, ningún `INSERT` — más el
> `scopes` sin tocar del Paso 3, que es la precondición real de que el evento llegue con nombre.
>
> **Los tests no cubren este paso**, y no pueden: el auth-callout no existe en un NATS pelado.

---

### Paso 7: Refresh del token en background

**Origen:** jiku-mail-connector (SDK)
**Destino:** Zitadel
**Tipo:** REST (HTTPS), recurrente

**Acción:** el SDK renueva el token al acercarse su expiración y actualiza el valor que el getter
devuelve. **La misma conexión sigue en uso** — no se abre una segunda.

**Si falla:** el callback `onTokenError` loguea `error` y **el proceso sigue vivo**. El token vigente
sigue sirviendo; lo que se rompe es el próximo reconnect.

**Ref:** S-004; C-15, NFR-R04

> **Implementado en S-004** — el callback registrado en `connectToBus()` loguea `error` con el
> diagnóstico `refresh_del_token_fallo`, la clase del SDK y la cadena de causas, y **no termina el
> proceso**: no llama a `process.exit()`, no lanza y no cierra el cliente.
>
> Detalle verificado del SDK que explica por qué esto no puede matar al worker aunque falle en
> bucle: el timer del refresh se crea con `setInterval(...).unref()`, así que ni siquiera mantiene
> vivo el event loop por su cuenta.

### Paso 8: Schedular el tick

**Origen:** jiku-mail-connector
**Destino:** (interno)
**Tipo:** Interno

**Acción:** `src/index.ts` decide entre las dos ramas de `config.poll.enabled`, ya validado en el
Paso 1 junto con `POLL_CRON` (validado con `cron.validate()` en el schema, nunca inválido en este
paso):

- **Rama `true`:** llama a `scheduleTick(config, logger)` (`src/domain/ingesta/scheduler.ts`), que
  invoca `cron.schedule(config.poll.cron, () => triggerTick(config, logger))` y devuelve la tarea
  programada. El proceso queda vivo con un tick scheduleado.
- **Rama `false`:** loguea `logger.info({}, 'poll deshabilitado: no se schedula ningún tick')` y
  **no** llama a `cron.schedule()` en ningún camino. El proceso queda vivo igual — **no** por código
  de este paso, sino por el handle abierto de la conexión al bus, heredado del Paso 5.

**Sin tick inmediato:** en ningún camino corre un tick antes del primer disparo real del cron — es
una propiedad de `node-cron`, no código adicional de este paso.

**Apagado ordenado:** los handlers de `SIGTERM`/`SIGINT` se registran **antes** de invocar
`scheduleTick()` (para no dejar una ventana sin apagado ordenado instalado). Al recibir la señal:
`scheduledTask?.stop()` (si existía) → `await waitForCurrentTick()` (espera el tick en vuelo **sin
cancelarlo nunca**) → `await closeBus()` → `process.exit(0)`.

**Ref:** S-007 (`poll.cron`, `poll.enabled`), S-010 (el tick que se schedula), S-011

---

## Manejo de Errores

| Paso | Error | Código | Response | Comportamiento |
|------|-------|--------|----------|---------------|
| 1 | Faltan variables requeridas | — | Lista **completa** en un solo mensaje | **No arranca**, exit ≠ 0. No conecta a nada |
| 1 | Valor con forma inválida | — | Entra en la lista agregada, **sin volcar el valor** | **No arranca**, exit ≠ 0 |
| 2 | Falla el transporte de desarrollo | — | — | Se degrada a JSON en stdout: un worker sin logs es indiagnosticable |
| 3 | Key ilegible — los **cuatro** modos (ausente, JSON inválido, forma equivocada, `key` no leíble) | `BUS_KEY_LOAD_ERROR` | Log `fatal` con `diagnosis: key_ilegible`, **sin volcar su contenido ni su ruta** | **No arranca**, exit ≠ 0 |
| 4 | Zitadel no entregó el token (firma rechazada, issuer inalcanzable, reloj) | `BUS_CONNECT_ERROR` | Log `fatal` con `diagnosis: zitadel_no_entrego_token`, la clase del SDK y la cadena de causas | **No arranca**, exit ≠ 0 |
| 5 | Machine user **sin** rol `internal-app` (o Access Token Type ≠ JWT, o sin `JIKU_PROJECT_ID`) | `BUS_CONNECT_ERROR` | Log `fatal` con `diagnosis: rechazo_del_bus_por_subject` — **el arreglo está en Zitadel**, no en el payload ni en `core` | **No arranca**, exit ≠ 0 |
| 5 | Bus inalcanzable (host irresoluble o puerto cerrado) | `BUS_CONNECT_ERROR` | Log `fatal` con `diagnosis: bus_inalcanzable` | **No arranca**: el proceso no queda vivo en un estado inútil |
| 5 | Creds del sentinel ilegible | `BUS_CONNECT_ERROR` | Log `fatal` con `diagnosis: creds_ilegible` — el arreglo está en el **montaje del archivo** | **No arranca**, exit ≠ 0 |
| 5 | Cualquier otro fallo de conexión | `BUS_CONNECT_ERROR` | Log `fatal` con `diagnosis: desconocido`, la clase del SDK y la cadena de causas, **sin mapearse a otra causa** | **No arranca**, exit ≠ 0 |
| 6 | Se pierde el evento del auth-callout | — | — | El conector queda sin fila en `users` hasta su próxima autenticación. Reconectar lo resuelve. **Dependencia declarada del producto, no un bug del conector** |
| 7 | Falla el refresh del token | — | Log `error` con `diagnosis: refresh_del_token_fallo`, la clase del SDK y la cadena de causas | **El proceso NO muere** (NFR-R04). El token vigente sigue sirviendo |

**Regla que gobierna la tabla:** un fallo **al arrancar** es fatal; un fallo del refresh **en
background** no lo es. Son dos momentos distintos y las dos reglas conviven.

> **Corregido en S-004: la tabla prometía un `hint()` que estos errores no tienen.** Las filas 4, 5
> y 7 decían "clase del SDK + `hint()`", pero **`hint()` sólo existe en `JikuFailure`**, que es la
> clase de los fallos de **comando** (S-005). Los fallos de **conexión** llegan como `JikuError` a
> secas — verificado en los seis escenarios — y no tienen `hint()`. Lo que el log emite en su lugar
> es el **diagnóstico del conector**, el nombre de la clase del SDK y la **cadena de causas**, cuyos
> mensajes ya traen las causas probables redactadas por el propio SDK. El `hint()` se consulta si
> existe, sin asumirlo.
>
> **Corregido en S-004: `JikuPermissionDenied` no es la clase del rechazo de conexión.** La fila 5
> la nombraba; esa clase es la del rechazo de **publicación** de un comando. El rechazo del
> handshake llega como `JikuError` envolviendo un `AuthorizationError` de `@nats-io/nats-core`, y es
> por esa **estructura** —no por el texto— que el conector lo reconoce.
>
> **Agregado en S-004:** las filas de *creds ilegible* y *desconocido*, que la tabla no tenía. La
> segunda es deliberada y no un cajón de sastre: un diagnóstico equivocado es **peor** que uno
> ausente, porque manda a revisar el sistema equivocado, que es el fallo exacto que ADR-006 existe
> para evitar.

## Resultado

**Éxito:** un proceso vivo con **exactamente una** conexión al bus, una línea de log de arranque
exitoso en stdout **sin ninguna credencial**, y el tick scheduleado **o explícitamente sin
ninguno** — las dos son estados finales válidos según `POLL_ENABLED`.

**Estado final:**
- Proceso: vivo, con una conexión conservada por toda su vida
- Access token: en memoria, refrescándose en background
- Fila del conector en `users` de Jiku: creada por Jiku sola, `identity_type: service`, `email` en
  `NULL`
- Logs: estructurados en stdout (JSON en producción). **Ningún archivo escrito**
- Tick: **scheduleado** con `cron.schedule()` según `POLL_CRON` (rama `POLL_ENABLED=true`), o
  **explícitamente sin ninguno** con el mensaje de deshabilitado ya logueado (rama
  `POLL_ENABLED=false`)
- Apagado: `SIGTERM`/`SIGINT` ya cableados — el worker sale ordenadamente y con código `0` cuando
  se le pide, esperando cualquier tick en vuelo antes de cerrar el bus

## Notas

- **Exactamente una conexión por proceso, no una por operación** (NFR-P05): conectar cuesta un
  round-trip a Zitadel más el handshake que corre el auth-callout.
- El token se entrega **como getter, no como string** (patrón 5 del PRD): es lo que permite que el
  refresh en background no requiera reconectar.
- **Las cinco precondiciones de este flujo son manuales y no verificables por código** (machine user,
  rol `internal-app`, key JSON, creds, red al bus). Son de U-02, no del software. Lo que el conector
  aporta es que **cada fallo diga cuál de los sistemas lo produjo**.
- **Los tests no cubren este flujo de punta a punta, y S-004 sólo mejoró parcialmente eso.** La nota
  original decía que `Client.fromConnection()` saltea el handshake de auth y por lo tanto no prueba
  nada sobre Zitadel, el rol ni el prefijo de inbox. Sigue siendo cierto para ese helper — pero S-004
  agregó un contenedor NATS levantado con `--auth`, que **sí** produce un `Authorization Violation`
  real y por lo tanto ejercita de verdad la traducción del rechazo. Lo que sigue **sin** estar
  cubierto, y ninguna documentación debe afirmar que lo está: **el auth-callout, el rol
  `internal-app`, el claim de roles del token y el prefijo de inbox derivado del `sub`**. Nada de eso
  existe en un NATS pelado, que sólo compara un string. La verificación real sólo ocurre contra un
  despliegue.
- **Nota de infraestructura de tests, para que no se redescubra:** el test de reconexión necesita que
  el puerto del **host** esté fijo. `restart()` de testcontainers levanta el contenedor con un mapeo
  de puerto nuevo, y el cliente NATS sigue reintentando contra el endpoint original — así que con el
  puerto efímero por default el reconnect **no puede ocurrir nunca** y el test expira sin haber
  probado nada.
- El rol `internal-app` concede **los dos planos completos** para un conector que usa 1 comando y
  ninguna consulta. Acotarlo modificaría el producto (G-03): fuera de alcance v1, **no descartado**.
