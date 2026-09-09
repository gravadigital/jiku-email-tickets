---
id: arranque-y-conexion-al-bus
title: Arranque y conexión al bus
type: event
status: Active
created: 2026-08-27
last_updated: 2026-09-08
stories: [S-002, S-003, S-004, S-006, S-007, S-011, S-012, S-013, S-014, S-015, S-016, S-024, S-025]
---

# Arranque y Conexión al Bus

**Tipo:** Evento
**Status:** Active
**Creado:** 2026-08-27
**Última actualización:** 2026-08-31 (S-011 implementada: el Paso 8 — schedular el tick y el apagado
ordenado — ya está completo. S-012 implementada: el Paso 1 valida también el Mapa de Tickets, el
prefijo y los placeholders. S-016 implementada: el documento estaba completo desde S-012 — no se
reescribe ningún paso de contenido — y S-016 cierra el estado formal: `Status` pasa de `Draft` a
`Active` y se suman las stories del feature group que lo cerró. S-024 implementada: el Paso 5.5
—abrir y verificar los dos buckets del KV sobre la conexión ya establecida— entra entre conectar al
bus y schedular el tick, con sus filas en la tabla de errores. S-025 implementada: el Paso 5.6 carga
el Mapa de Tickets desde el bucket y lo sigue con `watch()`; el Paso 1 deja de validarlo y pierde su
única regla cross-field)
**Stories:** S-002, S-003, S-004, S-006, S-007, S-011, S-012, S-013, S-014, S-015, S-016, S-024, S-025

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
                MC->>BUS: Kvm(client.connection).open(TICKETS) + status()
                alt el bucket de slugs no existe
                    BUS-->>MC: StreamNotFoundError → exit ≠ 0 nombrando TICKETS
                else existe
                    MC->>BUS: open(MAIL_THREADS) + status()
                    alt el bucket de hilos no existe
                        BUS-->>MC: StreamNotFoundError → exit ≠ 0 nombrando MAIL_THREADS
                    else existe
                        MC-->>MC: compara el TTL del de hilos (warn si difiere, arranca igual)
                        MC-->>MC: buckets del KV abiertos y verificados
                        MC->>BUS: status() + watch() del bucket de slugs
                        BUS-->>MC: carga inicial (0..N entradas) y despues las novedades
                        MC-->>MC: Mapa de Tickets en memoria; el watch queda corriendo
                    end
                end
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
| `SUBADDRESS_PREFIX` | No | `tickets` |
| `PLACEHOLDER_TITLE` | No | `Ticket recibido por mail` |
| `PLACEHOLDER_BODY` | No | `(mail sin contenido)` |
| `KV_TICKETS_BUCKET` | No | `TICKETS` |
| `KV_THREADS_BUCKET` | No | `MAIL_THREADS` |
| `KV_THREADS_TTL_DAYS` | No | `90` |
| `KV_WATCH_RETRY_MS` | No | `30000` |

Las de **IMAP ya se declaran y son requeridas** (S-007): con la ingesta en alcance dejaron de ser
opcionales, y esto **supera el criterio 5 de REQ-001**. S-024 sumó las cuatro del KV.

**El Mapa de Tickets ya no se valida acá, y su regla cross-field desapareció (S-025).** Hasta S-024
este paso validaba `TICKET_MAP` / `TICKET_MAP_FILE` —dos fuentes **excluyentes**, la única regla
cross-field de todo el schema— y **leía el archivo del mapa desde adentro de la validación**, con lo
que el schema tocaba el filesystem. Nada de eso existe más: el mapa vive en un bucket KV y se carga
en el **Paso 5.6**, sobre la conexión al bus. Este paso volvió a ser una validación de variables
sueltas, sin ninguna regla entre claves y sin tocar el disco.

Las tres consecuencias de esa eliminación:

1. **`createFinalSchema` desapareció de `src/config/env.ts`.** Existía **sólo** para hospedar esa
   regla; sin ella, `createEnv` vuelve a validar por su camino normal (ver el hallazgo de abajo, que
   sigue siendo la razón por la que la lista sale completa).
2. **La validación del schema volvió a ser pura**: ya no hay `readFileSync` en el camino, ni la
   excepción de "el schema toca el filesystem" que había que justificar.
3. **El fail-fast del mapa no se perdió, se mudó**: un bucket inexistente impide el arranque en el
   Paso 5.5, con un error que nombra el bucket. Lo que cambió es *cuándo* falla y *qué* nombra.

`POLL_CRON` se valida con **`cron.validate()` de `node-cron`, en el arranque** — no al schedular.
Sin esa validación temprana, un cron mal formado explotaría recién en `cron.schedule()` (Paso 8, ya
con el logger construido y la conexión abierta): un worker vivo que nunca ingesta nada y **sin
síntoma**, que es exactamente el fallo diferido que este paso existe para evitar.

`POLL_ENABLED` **no** usa `z.coerce.boolean()`: `Boolean('false')` es `true`, así que la coerción
automática habilitaría el poll cuando se pidió deshabilitarlo, en silencio. La coerción es explícita
sobre `z.enum(['true','false'])`, y un valor que no sea uno de los dos **no arranca**.

La configuración del bus se lee con `loadConfig()` del SDK, invocado **dentro de `src/config/`** para
no duplicar sus defaults ni romper el punto de lectura único.

> **Implementado en S-012, y ACOTADO en S-025.** El hallazgo de abajo sigue vigente y es la razón
> por la que la lista de errores sale completa; lo que S-025 eliminó es el caso que lo hacía difícil.
>
> **`createEnv` no valida un `z.object()`, y eso decide dónde puede vivir cada validación.** La
> librería recorre el schema como un **diccionario plano de shapes** (`parseWithDictionary()`),
> validando cada clave por separado y **acumulando** todos los issues antes de invocar
> `onValidationError` una sola vez. Eso es lo que hace que un `IMAP_HOST` ausente y un
> `POLL_MAX_PER_TICK` inválido salgan juntos: sale gratis, por construcción, siempre que la
> validación viva **en una clave**. Desde S-025 **todas** viven en una clave, así que se obtiene
> gratis siempre.
>
> **La trampa que ya no aplica, y que conviene dejar escrita para que nadie la reintroduzca.** Hasta
> S-024 había una regla genuinamente **cross-field** (las dos fuentes del mapa). Escrita de la forma
> obvia —`z.object(shape).superRefine(...)`— **rompe la lista única en silencio**: Zod **no corre el
> refinement si alguna clave del objeto ya falló**, así que en el caso que más importa (falta una
> variable del bus **y** el mapa no está declarado) el issue del mapa **nunca aparece**, y el
> operador arregla una cosa para descubrir la otra en la corrida siguiente. `.check()` se comporta
> igual. Verificado empíricamente contra `@t3-oss/env-core@0.13.11` y `zod@4.4.3`.
>
> Aquello se resolvió con un `createFinalSchema` que corría el objeto y la regla por separado y
> concatenaba las dos listas sin cortar. **S-025 lo eliminó entero**, porque al mudarse el mapa al
> KV el schema se quedó sin ninguna regla cross-field que hospedar.
>
> **Si alguna vez hace falta agregar una regla entre claves, este es el problema que va a aparecer**,
> y la solución conocida es esa: un Standard Schema propio que no corte. No se conserva el código
> "por las dudas" —código sin usuario se pudre— pero sí el diagnóstico, que es la parte cara.

**Ref:** S-002, S-007, S-012, S-025; ADR-002, ADR-004; convención `env-config`

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

### Paso 5.5: Abrir y verificar los dos buckets del KV

**Origen:** `jiku-mail-connector`
**Destino:** Bus NATS (JetStream)
**Tipo:** Operación del bus (no es un comando de `core`)

**Operación:** `new Kvm(client.connection)` y, sobre él, `open()` + `status()` de los dos buckets:
el del Mapa de Tickets (`KV_TICKETS_BUCKET`, por default `TICKETS`) y el del Mapa de Hilos
(`KV_THREADS_BUCKET`, por default `MAIL_THREADS`).

**Ref:** S-024; ADR-002; REQ-005

> **Implementado en S-024** — `src/infra/kv/stores.ts` (`openKvStores()`). Va **después** del Paso 5
> y **antes** del Paso 8 por dos razones que no son de estilo: el `Kvm` se construye sobre
> `client.connection`, así que sin conexión no hay nada sobre lo que construirlo; y un bucket
> faltante tiene que impedir el arranque en vez de descubrirse en el primer mail.
>
> **Cuatro hallazgos verificados contra el paquete instalado, que la próxima story del KV no debería
> tener que redescubrir:**
>
> **1. `open()` NO verifica que el bucket exista, y su docstring engaña.** Dice *"If the KV doesn't
> exist, this API will fail on accessing the KV"*, que se lee fácil como "`open()` lanza". No lanza:
> `open()` fija `bindOnly: true` (`lib/kv.js:158-160`) y delega en `Bucket.bind()`
> (`lib/kv.js:228-246`), que valida el nombre, construye el objeto y **nunca llama a `streams.info`**.
> El fallo está diferido al primer acceso real. **La verificación es `status()`**, que sí consulta
> (`lib/kv.js:812`). Sin ese `status()`, el conector arrancaría feliz contra un despliegue sin
> buckets y descartaría todos los mails en silencio — el modo de falla exacto que este paso cierra.
> Si alguien ve el `status()` como "redundante después del `open()`" y lo borra, reintroduce eso.
>
> **2. `status().ttl` viene en MILISEGUNDOS, y `0` significa "sin TTL".** Es
> `millis(si.config.max_age)` (`lib/kv.js:835-837`): un bucket creado con `--ttl=90d` reporta
> `7776000000`. La configuración está en **días**, porque es la unidad con la que el operador crea el
> bucket, así que la comparación convierte explícitamente.
>
> **3. "Sin permisos de KV" es INDISTINGUIBLE de "JetStream deshabilitado", y no hay que intentar
> distinguirlos.** Una violación de permisos sobre `$JS.API.>` no llega como respuesta a la request:
> llega como un `-ERR` asincrónico por el stream de status de la conexión, y el cliente la envuelve
> igual que la ausencia de JetStream, como `JetStreamNotEnabled`. Separarlas exigiría correlacionar
> el error asincrónico con la request. El diagnóstico `kv_no_disponible` nombra **las dos** cosas a
> revisar, que es lo único que el operador necesita.
>
> **4. Las clases de error del KV no son importables desde el subpath del SDK**, así que `instanceof`
> es imposible y `diagnoseKvFailure()` clasifica por `name` y por `code` (`10059`) — nunca por el
> texto del mensaje. El propio `Kvm.create()` de la librería compara
> `err.message === "stream not found"`, que es el bug que este módulo no replica.
>
> **El conector NO crea buckets y NO fija el TTL**, y las dos cosas están afirmadas por tests que
> escanean `src/`. Crear un bucket ante un typo en el nombre dejaría un bucket vacío en silencio, con
> el mismo síntoma indiagnosticable de arriba. Fijar el TTL exigiría el permiso de escritura de
> streams que la decisión de no crear buckets existe para evitar. **Los crea el operador** — es una
> precondición de despliegue, no un paso del arranque.
>
> **Los dos buckets se verifican en orden y se corta en el primero que falta**, empezando por el de
> slugs: sin el Mapa de Tickets no se puede rutear nada, mientras que sin el de hilos sólo degradan
> las respuestas. No son equivalentes, y el error nombra **un** bucket para que el operador sepa cuál
> crear.

---

### Paso 5.6: Cargar el Mapa de Tickets y seguirlo con `watch()`

**Origen:** `jiku-mail-connector`
**Destino:** Bus NATS (JetStream)
**Tipo:** Operación del bus

**Operación:** `startTicketMapWatch()` sobre el handle del bucket de slugs que abrió el Paso 5.5:
espera la **carga inicial completa** y deja corriendo un `watch()` que mantiene la copia en memoria
actualizada por el resto de la vida del proceso.

**Ref:** S-025; ADR-004; REQ-005

> **Implementado en S-025.** Es el paso que hace que agregar un proyecto **no necesite un redeploy**:
> un `nats kv put` sobre el bucket aparece en el ruteo en segundos.
>
> **El arranque ESPERA la carga inicial completa**, y no es una preferencia: schedular el primer tick
> con el mapa a medio llenar haría que los mails de un slug que sí está cargado se descarten como
> `slug_no_mapeado`. Un descarte es definitivo —el mail queda `\Seen`— así que la ventana no se
> puede tolerar.
>
> **Cinco hallazgos verificados empíricamente** contra `nats:2.11-alpine` con `-js` y
> `@nats-io/kv@3.4.0`. Cada uno invalida una implementación que parece obviamente correcta, así que
> valen más escritos que redescubiertos:
>
> **1. Un bucket VACÍO no emite NUNCA ningún entry, y esperar uno cuelga el arranque para siempre.**
> Es la trampa central. `watch()` marca el fin de la carga inicial con `isUpdate`, pero con cero
> entradas **el callback no se invoca jamás**. Una espera escrita como *"resolver cuando llegue el
> primer entry con `isUpdate: true`"* **no resuelve nunca** contra un bucket vacío: el proceso queda
> vivo, sin loguear, sin schedular el tick y sin morirse — **sin ningún síntoma**. Y un bucket vacío
> es el estado del **primer arranque de todo despliegue nuevo**. La solución es consultar
> `status().values` **antes** de arrancar el watch: con `0`, la carga inicial está completa por
> definición.
>
> **2. El ÚLTIMO entry de la carga inicial ya trae `isUpdate: true`.** Con tres entradas se emite
> `false, false, true`. Por eso el orden es **aplicar primero, resolver después**: un
> `if (entry.isUpdate) resolver()` colocado antes de aplicar se saltearía la última entrada.
>
> **3. Cuando el watch se cae, el `for await` TERMINA NORMALMENTE — no lanza.** La librería empuja un
> centinela que termina el iterador limpiamente, así que un `try { for await } catch { reintentar }`
> **no detecta la caída más común**: el loop sale por la puerta de adelante y nadie reintenta. La
> detección va **después** del loop, en el camino normal.
>
> **4. Un `delete` llega como `operation: 'DEL'`, con el valor VACÍO.** Aplicar todo como `set()`
> deja un slug borrado por el operador ruteando para siempre; y parsear el valor antes de mirar la
> operación produce un `NaN`.
>
> **5. `entry.json()` LANZA** con un valor cargado a mano que no sea JSON válido. Un dato malo no
> debe matar el watch entero, así que el parseo es propio y tolerante: la entrada inválida se
> **ignora con un `warn` que nombra la clave** y las demás siguen funcionando.
>
> **Si el watch se cae, el mapa NO se vacía.** Se conserva la última copia buena y se reintenta cada
> `KV_WATCH_RETRY_MS`; lo que se pierde son las actualizaciones, no el ruteo. Vaciarlo dejaría de
> rutear mails que se podían rutear perfectamente, convirtiendo una caída del bus en pérdida de
> tickets.
>
> **El `Map` es el MISMO objeto durante toda la vida del proceso.** El watch lo muta con
> `set`/`delete` y **nunca lo reemplaza**, que es lo que permite que `config.ruteo.ticketMap` sea una
> referencia fija y vea las actualizaciones. Un `new Map(...)` defensivo, un spread o un
> `structuredClone` en el camino romperían la vivacidad **sin fallar en compilación**: el conector
> rutearía bien los slugs iniciales y no vería ninguno nuevo, nunca.

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
| 5.5 | El bucket del Mapa de **Tickets** no existe | `KV_BUCKET_MISSING_ERROR` | Log `fatal` con `diagnosis: bucket_inexistente` y **`bucket: TICKETS`** — el nombre del bucket es el dato que hace accionable el fallo | **No arranca**, exit ≠ 0. Lo crea el operador (`nats kv add`), no el conector |
| 5.5 | El bucket del Mapa de **Hilos** no existe | `KV_BUCKET_MISSING_ERROR` | Log `fatal` con `diagnosis: bucket_inexistente` y **`bucket: MAIL_THREADS`** | **No arranca**, exit ≠ 0. Sin él las respuestas no rutearían, y arrancar a medias lo escondería |
| 5.5 | JetStream deshabilitado **o** sin permisos de KV en el auth-callout | `KV_BUCKET_MISSING_ERROR` | Log `fatal` con `diagnosis: kv_no_disponible`. El mensaje nombra **las dos** cosas a revisar: son indistinguibles desde el cliente | **No arranca**, exit ≠ 0. **No** dice que el bus esté inalcanzable: la conexión funcionó |
| 5.5 | Nombre de bucket inválido en la configuración | `KV_BUCKET_MISSING_ERROR` | Log `fatal` con `diagnosis: nombre_de_bucket_invalido`. Se detecta **antes** de cualquier I/O, así que el diagnóstico es positivo y no por descarte | **No arranca**, exit ≠ 0 |
| 5.5 | Cualquier otro fallo del KV | `KV_BUCKET_MISSING_ERROR` | Log `fatal` con `diagnosis: desconocido`, la clase del error y la cadena de causas, **sin mapearse a otra causa** | **No arranca**, exit ≠ 0 |
| 5.5 | El TTL del bucket de hilos **difiere** del configurado | — | Log `warn` con `bucket`, `expectedTtlDays` y `actualTtlMs` | **Arranca igual.** Un TTL distinto no rompe el ruteo: sólo cambia la ventana, y una entrada expirada degrada a `hilo_desconocido`, que es una falla segura. El conector **no** lo fija |
| 5.6 | El `watch()` del Mapa de Tickets no se puede dar de alta | `KV_BUCKET_MISSING_ERROR` | Log `fatal` con el bucket y la operación | **No arranca**, exit ≠ 0. Sin el mapa no se puede rutear nada |
| 5.6 | Una entrada del bucket tiene un valor inválido (no es un entero positivo) | — | Log `warn` que **nombra la clave** | **Arranca igual** y la entrada se **ignora**. Un dato malo cargado a mano no debe dejar sin ruteo a los demás proyectos, y con el mapa en el KV ya no hay un "momento de carga" en el que fallar |
| 5.6 | El `watch()` se cae con el proceso vivo | — | Log `warn` con el bucket y el intervalo de reintento | **El proceso NO muere.** El mapa **conserva la última copia buena** y el ruteo sigue; se reintenta cada `KV_WATCH_RETRY_MS`. Lo que se pierde son las **actualizaciones**, no el mapa |
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

> **Agregado en S-024: las seis filas del Paso 5.5, y una rama de reporte propia.** El KV **no**
> comparte la rama de `BusConnectError` en `reportStartupFailure()`, y la separación es el punto:
> cuando falta un bucket, la conexión al bus funcionó perfectamente. Reportarlo como *"el conector no
> pudo conectarse al bus"* mandaría al operador a revisar Zitadel, la red y los montajes de
> credenciales cuando el arreglo es un `nats kv add` — exactamente el diagnóstico equivocado que
> ADR-006 existe para evitar. De ahí que el mensaje de esta rama sea *"un bucket del KV no está
> usable"* y que el contexto lleve `bucket` y `operation`.
>
> **La única fila `warn` de todo el arranque es la del TTL**, y es deliberado: es el único hallazgo
> del Paso 5.5 que no impide operar. Todo lo demás del KV es fatal, por la misma regla que gobierna
> la tabla — un fallo al arrancar es fatal.

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
