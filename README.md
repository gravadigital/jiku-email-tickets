# jiku-email-tickets

Conector que ingesta mails de una casilla y publica comandos en el bus de Jiku.

Es un worker: un único proceso Node.js, sin servidor HTTP y sin base de datos propia
([ADR-001](docs/adrs/)). El único cliente del bus es el SDK `@gravadigital/jiku` ([ADR-002](docs/adrs/)).

## Precondiciones

- **Node.js >= 22.12** — es el `engines` floor del SDK, no una preferencia.
- **Docker** — la suite de tests levanta un contenedor NATS real con Testcontainers. Sin Docker, los
  tests no corren.

## Instalación

```bash
npm install
```

## Compilar

```bash
npm run build      # emite dist/ (sin los tests)
npm run typecheck  # tsc --noEmit sobre src/ y test/
```

## Ejecutar

```bash
npm start          # corre dist/index.js
```

`start` nunca publica comandos en el bus. El modo de verificación —que sí publica— es un script
separado (`npm run verify`).

## Verificar el despliegue (`npm run verify`)

Publica un `requirements.new` real con un payload fijo y traduce la respuesta, distinguiendo **cuál de
los tres sistemas rechazó**: el bus por subject, `core` por rol, o `core` por forma. Es la prueba de
que el conector puede escribir en Jiku.

```bash
npm run build && npm run verify
```

### Tres advertencias operativas, antes de correrlo

1. **Corré esto contra un proyecto de prueba.** Cada corrida deja un requisito **permanente** en el
   proyecto que indique `JIKU_VERIFY_PROJECT_ID`. El conector **no tiene comando de compensación**: no
   puede borrarlo ni modificarlo, y nadie puede limpiarlo desde acá. Dos corridas dejan dos requisitos.
2. **La primera corrida de un despliegue nuevo falla con `caller_not_authorized`, y eso es el
   resultado correcto.** La fila del conector en `users` la crea Jiku sola en su primera
   autenticación; hasta que exista, todo comando se rechaza. El conector no intenta crearla. **Volvé a
   correrlo** y esta vez tiene que tener éxito.
3. **No bajes el timeout.** El piso de 15000 ms es deliberado y está por encima de los 10 s del
   servidor: bajarlo convierte los errores explicados de PostgreSQL —que corta a los 8 s— en timeouts
   mudos. Parece una mejora y empeora exactamente lo que protege.

### Qué esperar

- **Éxito:** una línea de log con `{ projectId, requirementId }` juntos, y un requisito visible en Jiku
  en ese proyecto con `type: incidencia`, `priority: sin_prioridad`, `visibilityLevel: public` y
  `state: analisis`. Sale con código **0**.
- **Fallo:** una línea con `diagnosis`, `sdkErrorClass`, el `code` de `core` y el `projectId`. Sale con
  código **distinto de cero**. Nunca reintenta.

Los diagnósticos y dónde está el arreglo de cada uno:

| `diagnosis` | Quién rechazó | Dónde está el arreglo |
|---|---|---|
| `rechazo_del_bus_por_subject` | **El bus**, por subject | Zitadel: rol `internal-app`, Access Token Type en JWT, `JIKU_PROJECT_ID`. **No implica nada sobre `core`** |
| `bus_sin_endpoint` | **El bus**: nada suscripto | `core` caído, o `JIKU_INSTANCE` que no coincide |
| `error_de_armado_del_conector` | **El conector**, localmente | Nada llegó a la red. Es un bug del conector |
| `core_rechazo_por_rol` | **`core`**, por rol | La fila en `users`. **Reconectar lo corrige solo** |
| `core_rechazo_por_forma` | **`core`**, por forma | El payload o el `JIKU_VERIFY_PROJECT_ID`. **Prueba que el plano de escritura está abierto** |
| `core_rechazo_desconocido` | **`core`**, código nuevo | El `code` y el mensaje de `core` van en la línea. También prueba que el plano está abierto |
| `nada_respondio` | Nadie contestó | `core` caído o lento |
| `respuesta_ilegible` | `core` dijo éxito sin `id` | **Verificá en Jiku antes de repetir**: puede haberlo creado |

### Verificación manual complementaria

Después de una corrida exitosa, y **desde Jiku, no desde el conector** (el conector no consulta el
plano de lectura — ADR-003):

- Comprobá que el requisito existe en el proyecto, con los cuatro valores de arriba.
- Comprobá la fila del conector en `users`: `identity_type: service` y `email` en `NULL`. La creó Jiku
  sola en la primera autenticación; el conector **no la creó ni la pidió**.
- Corré una tercera vez y comprobá que hay **dos** requisitos de prueba, y que ninguno de los
  anteriores se modificó ni se borró.

## Desplegar

El conector se despliega como una imagen de contenedor: un worker, una sola instancia, **sin ningún
secreto adentro**. La key del machine user y el creds del sentinel se **montan read-only** en tiempo
de ejecución, y todo lo demás entra por variables de entorno.

### Las ocho precondiciones, a cargo de U-02

**El conector no puede resolver ninguna de las ocho.** Ninguna es código: viven en Zitadel, en el
bus, en Jiku, en la red y en el storage. Lo único que el conector hace —y lo que sí garantiza— es
**fallar de forma legible**, nombrando **cuál de los sistemas rechazó**, porque el arreglo de cada uno
está en un lugar distinto.

| # | Precondición | Si falta, el conector… |
|---|---|---|
| 1 | **Machine user en Zitadel** con **Access Token Type = JWT** y el rol **`internal-app`** asignado en el project de gestión | …no arranca. `diagnosis: rechazo_del_bus_por_subject` (`Authorization Violation`) |
| 2 | **Key JSON descargada y guardada.** Zitadel la entrega **una sola vez**: no se puede volver a bajar, sólo reemplazar por una nueva | …no arranca. `code: BUS_KEY_LOAD_ERROR`, `diagnosis: key_ilegible`, sin volcar el contenido ni la ruta |
| 3 | **Creds del sentinel del bus** montado y alcanzable, y **`JIKU_PROJECT_ID`** configurado | …no arranca. Sin `JIKU_PROJECT_ID` el token **no lleva el claim de roles** y el bus rechaza sin nombrar la causa |
| 4 | **Una instancia de Jiku desplegada y alcanzable**, con al menos un `projectId` real para la prueba (`JIKU_VERIFY_PROJECT_ID`) | …**arranca igual** —el worker no consulta a `core`— pero `verify` falla con `nada_respondio` o `core_rechazo_por_forma` |
| 5 | **Red al bus:** el conector va **dentro** de la red del bus, que **no está expuesta al ingress** | …no arranca. `diagnosis: bus_inalcanzable` |
| 6 | **La casilla acepta subaddress** (`+slug`, p. ej. `tickets+alfa@grava.io`) y tiene **IMAP habilitado**. En Gmail hace falta **App Password**, no la contraseña de la cuenta | …arranca igual —el conector no verifica la casilla al arrancar— pero la ingesta **no funciona**: sin IMAP habilitado el `connect()` del tick falla en cada disparo del cron, y sin subaddress el slug del proyecto destino no se puede extraer (FG-3) |
| 7 | **El storage S3-compatible es alcanzable por red** desde donde corre el conector (FG-4) | …arranca igual —el conector no verifica el storage al arrancar— pero la subida de adjuntos falla: cada `PUT` a la `uploadUrl` prefirmada agota su timeout (`PUT_TIMEOUT_MS`) y el adjunto queda con aviso de fallo en la description, sin cancelar el requisito |
| 8 | **`JIKU_KV` creado por el deploy de Jiku con `allow_direct` y sin TTL, y los tres grants del Espacio KV en la plantilla de `internal-app`**. U-02 la **verifica** antes de desplegar: no la crea U-02 ni el conector | …**no arranca**. `code: KV_SPACE_UNAVAILABLE_ERROR`, con uno de tres `diagnosis`. `bucket_no_usable`: `JIKU_KV` no existe, no tiene `allow_direct` o JetStream está apagado — lo arregla el **deploy de Jiku**, la causa exacta va en `causes`, y **no** es un problema de grants. `kv_sin_permisos`: al rol le faltan los grants — el log trae el `subject` rechazado y los grants que faltan, y se arregla en la **plantilla de `internal-app`**. `desconocido`: no encaja en ninguno — la clase y la cadena de causas van en la línea |

Cinco aclaraciones que no son obvias:

- **La key no tiene procedimiento de rotación definido.** Zitadel la entrega una sola vez; si se
  pierde, lo único posible es generar una nueva y reemplazar el montaje. Decirlo es información;
  inventar un procedimiento que no existe sería peor que el silencio.
- **La precondición 5 no es una preferencia.** Desplegar el conector fuera de la red del bus no es
  una versión degradada: es imposible, porque esa red no tiene ingress.
- **La precondición 4 no afecta el arranque.** El worker arranca sin una instancia de Jiku
  alcanzable, porque no consulta a `core` para arrancar. Lo que falla es `verify`. Si `core` está
  caído, un contenedor sano **no** es evidencia de que Jiku esté sano.
- **La precondición 7 no exige CORS ni credenciales de S3.** El `PUT` del byte del adjunto lo hace un
  proceso de servidor (`fetch` nativo de Node), no un navegador — CORS no aplica. La única
  autorización es la `uploadUrl` que `core` firmó: el conector nunca ve ni usa una credencial de S3
  propia (ADR-003).
- **La precondición 8 la crea el deploy de Jiku: ni U-02 ni el conector crean `JIKU_KV`.** El
  bucket es **uno** para todo el bus, y cada identidad usa adentro su propio **Espacio KV**: el
  prefijo `<instance>.<sub>.` que el SDK agrega delante de cada clave. Lo que hace U-02 es
  **verificarla** antes de desplegar (`nats kv info JIKU_KV`: que exista, con `allow_direct` y sin
  TTL) y pedir los grants si faltan.

  **El conector no crea `JIKU_KV`, y es deliberado**: un bucket creado por error —con otro nombre o
  con otra configuración— queda **vacío** en silencio, y el síntoma sería un conector aparentemente
  sano que descarta todos los mails sin decir por qué. Un arranque que falla nombrando el bucket es
  mucho mejor.

  Los **tres grants** que la plantilla de `internal-app` tiene que tener, copiados de
  `requiredKVPermissions()` del SDK (`<instance>` es la de `JIKU_INSTANCE`; `{{user_id}}` es el
  placeholder del auth-callout para el `sub` del token, y es lo que confina a cada rol a sus propias
  claves):

  ```yaml
  pub:
    allow:
      - "$JS.API.STREAM.INFO.KV_JIKU_KV"
      - "$KV.JIKU_KV.<instance>.{{user_id}}.>"
      - "$JS.API.DIRECT.GET.KV_JIKU_KV.$KV.JIKU_KV.<instance>.{{user_id}}.>"
  ```

  **No** se otorga ninguna forma ancha en su lugar —`$KV.JIKU_KV.>`, `$JS.API.DIRECT.GET.KV_JIKU_KV`,
  `$JS.API.STREAM.MSG.GET.KV_JIKU_KV` ni `$JS.API.>`—: cada una alcanza las claves de **todas** las
  identidades. Si el arranque sale con `kv_sin_permisos`, la línea de log ya trae el `subject`
  rechazado y esta misma lista.

  **Un `JIKU_KV` con TTL arranca igual, y el conector no puede detectarlo al arrancar** (el SDK sólo
  exige `allow_direct`). El síntoma aparece después: descartes `slug_no_mapeado` de slugs que
  estaban cargados, sin que nadie los haya borrado, y respuestas a hilos viejos descartadas como
  `hilo_desconocido`. El arreglo es sacarle el TTL al bucket en el deploy de Jiku y volver a cargar
  los slugs que expiraron.

Cuando el contenedor no arranque, el `diagnosis` de la línea de log dice quién rechazó y dónde está
el arreglo: la tabla de **diagnósticos** está más arriba, en
[Verificar el despliegue](#verificar-el-despliegue-npm-run-verify). No se duplica acá a propósito —
dos copias de la misma tabla divergen, y la que se lee termina siendo la vieja.

### Configuración: variables y montajes

Las veinticuatro variables que valida el arranque. Las dos credenciales del bus son **rutas a archivos
montados**, no su contenido. **`IMAP_PASSWORD` es la única que lleva un secreto en su valor** — y por
eso llega por entorno y nunca se hornea en la imagen (NFR-S05).

#### El `.env` y por qué no se carga en los tests

Los dos entry points cargan un `.env` del directorio de trabajo si existe, y lo que ya esté en el
entorno real siempre gana. **En producción no hay ninguno**: la imagen no lo lleva y la
configuración entra por variables del orquestador.

La carga **se saltea** con `NODE_ENV=test` o con `DOTENV_DISABLED=true`, y eso no es un detalle
cosmético: `dotenv` no pisa lo que ya existe, pero **sí rellena lo que falta**, así que un `.env` en
la máquina del desarrollador se colaba en la suite completando variables que cada caso deja
deliberadamente ausentes. El síntoma era una suite que pasaba o fallaba según el contenido de un
archivo **no versionado** — verde en CI, rojo en local, y el diff sin explicar nada.

Son **dos** interruptores y no uno porque son dos preguntas independientes: `NODE_ENV` dice *qué es*
el proceso y `DOTENV_DISABLED` dice *si carga el archivo*. Los tests que lanzan el `dist/` como
proceso hijo necesitan declararle un `NODE_ENV` propio (`production`, para probar el formato de la
línea de arranque) **sin** por eso reactivar la carga del `.env`.

**`JIKU_VERIFY_PROJECT_ID` es la única cuya obligatoriedad depende del proceso**: la lee `verify` y
nadie más, así que el worker arranca sin ella. No es una excepción a la validación estricta — es la
misma regla aplicada donde corresponde: la variable se valida como entero positivo si está
declarada, y su ausencia sólo es un error para el proceso que la necesita.

| Variable | Req. | Default | Qué es |
|---|---|---|---|
| `JIKU_CREDS` | **Sí** | — | **Ruta** al creds del sentinel de NATS (montado read-only) |
| `JIKU_KEY_FILE` | **Sí** | — | **Ruta** a la key JSON del machine user (montada read-only) |
| `JIKU_PROJECT_ID` | **Sí** | — | Project de **Zitadel** (UUID). Sin él el token no lleva roles |
| `JIKU_VERIFY_PROJECT_ID` | Sólo `verify` | — | Proyecto de **Jiku** (entero) donde `verify` crea el requisito de prueba. **No es `JIKU_PROJECT_ID`**: aquél es el project de Zitadel. **El worker no la lee**, así que un despliegue que sólo corre el worker no la declara; `verify` sale distinto de cero si falta |
| `JIKU_INSTANCE` | No | `dev` | Primer segmento del subject |
| `JIKU_SERVERS` | No | `nats://localhost:4222` | Endpoint del bus |
| `JIKU_ISSUER` | No | `https://id.grava.io` | Issuer de Zitadel |
| `JIKU_TIMEOUT` | No | `15000` (ms) | Piso de 15000: valores menores se elevan. No bajarlo |
| `LOG_LEVEL` | No | `info` | `trace\|debug\|info\|warn\|error\|fatal\|silent` |
| `NODE_ENV` | No | `production` | Sólo `development` activa `pino-pretty`, que **no está en la imagen**. `test` además impide que se cargue el `.env` |
| `DOTENV_DISABLED` | No | — | `true` impide que los entry points carguen un `.env` del disco. Para tests y desarrollo local; **en producción no hace falta** — la imagen no lleva `.env` |
| `IMAP_HOST` | **Sí** | — | Host del servidor IMAP de la casilla de tickets |
| `IMAP_PORT` | No | `993` | IMAPS. Entero entre 1 y 65535 |
| `IMAP_USER` | **Sí** | — | Usuario de la casilla |
| `IMAP_PASSWORD` | **Sí** | — | **App Password** de la casilla, **no** la password de la cuenta. Es el único secreto que viaja en el valor de una variable |
| `POLL_CRON` | No | `*/5 * * * *` | Se valida con `cron.validate()` de `node-cron` **en el arranque**: una expresión mal formada **no arranca** |
| `POLL_ENABLED` | No | `true` | Sólo `true` o `false` literales. Cualquier otro valor **no arranca** |
| `POLL_MAX_PER_TICK` | No | `50` | Máximo de mails por tick. Mínimo `1` |
| `SUBADDRESS_PREFIX` | No | `tickets` | Prefijo del subaddress del que se extrae el slug (`tickets+alfa@…`) |
| `PLACEHOLDER_TITLE` | No | `Ticket recibido por mail` | Título del requisito cuando el mail llega sin asunto |
| `PLACEHOLDER_BODY` | No | `(mail sin contenido)` | Cuerpo del requisito cuando el mail llega sin contenido |
| `ATTACHMENT_ALLOWED_EXTENSIONS` | No | `.png,.jpg,.jpeg,.gif,.pdf,.doc,.docx,.xls,.xlsx,.txt,.log,.zip` | Extensiones permitidas por la política **local** de adjuntos (conveniencia, no autoritativa — `core` decide) |
| `ATTACHMENT_ALLOWED_MIME_TYPES` | No | `image/png,image/jpeg,image/gif,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,application/zip` | MIME permitidos por la política local de adjuntos |
| `ATTACHMENT_MAX_SIZE_BYTES` | No | `10485760` (10 MB) | Tamaño máximo de un adjunto, evaluado sobre el `Buffer` real descargado |
| `PUT_TIMEOUT_MS` | No | `30000` | Timeout del `PUT` directo del byte del adjunto al storage S3-compatible |

> **Variables eliminadas (REQ-008):** `KV_TICKETS_BUCKET`, `KV_THREADS_BUCKET`,
> `KV_THREADS_TTL_DAYS` y `KV_WATCH_RETRY_MS` ya no existen. El estado del conector vive en su
> **Espacio KV**, dentro del bucket `JIKU_KV` que crea el deploy de Jiku, y no tiene nada
> configurable: ni nombre de bucket, ni TTL que verificar, ni `watch()` que reintentar. Si alguna
> quedó declarada en el entorno de un despliegue viejo, **se ignora**: no hace fallar el arranque ni
> cambia ningún comportamiento.

#### El Mapa de Tickets vive en el Espacio KV del conector

El Mapa de Tickets es lo que traduce el slug del subaddress al `projectId` de Jiku donde se crea el
requisito. No es una variable de entorno: son claves `tickets.<slug>` en el **Espacio KV** del
conector —su porción del bucket `JIKU_KV`—, con el `projectId` como valor. U-02 las opera con el
CLI de NATS, siempre con la **clave completa**:

```bash
nats kv put JIKU_KV <instance>.<sub>.tickets.<slug> <projectId>   # cargar o cambiar
nats kv del JIKU_KV <instance>.<sub>.tickets.<slug>               # borrar
nats kv get JIKU_KV <instance>.<sub>.tickets.<slug>               # verificar
```

**`<instance>.<sub>.` no se adivina: se copia.** Es el campo `kvPrefix` de la línea
`espacio KV abierto` que el conector emite al arrancar, tal cual, con el punto final incluido:

```json
{"bucket":"JIKU_KV","kvPrefix":"prod.387842544790142978.","msg":"espacio KV abierto"}
```

Con esa línea, cargar el proyecto `42` para el slug `alfa` es
`nats kv put JIKU_KV prod.387842544790142978.tickets.alfa 42`. `<instance>` es la de
`JIKU_INSTANCE` y `<sub>` es el `sub` del machine user del conector. Por eso el espacio es
**por instancia**: `dev` y `prod` tienen prefijos distintos y se cargan por separado, aunque el
machine user sea el mismo.

**Un alta, un cambio o una baja valen desde el mail siguiente, sin redesplegar ni reiniciar.** El
conector no guarda ninguna copia del mapa: consulta la clave del slug con un `get` puntual por cada
mail nuevo, así que lo que está en el KV en ese momento es lo que rutea.

Siete cosas que conviene saber antes de operarlo:

- **La credencial con la que U-02 corre el CLI** tiene que poder escribir bajo el prefijo del
  conector (`$KV.JIKU_KV.<instance>.<sub>.>`). **No puede ser la de un usuario común**: los grants
  confinan a cada rol a su propio `{{user_id}}`, así que un usuario común sólo escribe en su propio
  espacio, nunca en el del conector.
- **Los slugs van en minúsculas.** La comparación es en minúsculas en las dos puntas —la de la
  clave y la del mail—, así que una clave `…tickets.Alfa` se guarda tal cual pero **no matchea**
  `tickets+alfa@…`.
- **El valor es el entero de Jiku**, nunca el nombre del proyecto ni su slug. Un valor que no sea un
  entero positivo se **ignora con un `warn`** que nombra el **slug** (nunca el valor), y el mail se
  descarta como `slug_no_mapeado`: un dato malo cargado a mano no deja sin ruteo a los demás
  proyectos.
- **Un espacio vacío es válido y arranca.** Es el estado de todo despliegue nuevo: el worker arranca
  y descarta todo con log hasta que se cargue el primer slug.
- **Un slug que no está cargado se descarta con un log que lo nombra** (`slug_no_mapeado`): es el
  dato que hace falta para cargarlo. El mail queda `\Seen` y no se reintenta.
- **Si el KV no responde, los mails nuevos se descartan como `slug_no_consultable`**, no como
  `slug_no_mapeado`: el arreglo es el bus, no cargar el slug. Cada descarte nombra el slug y el
  `messageId`, así que esos mails se reconstruyen desde la **casilla** (quedaron `\Seen` y no se
  reintentan solos). Cuando el KV vuelve, el mail siguiente rutea sin reiniciar nada: no hay estado
  que reconstruir.
- **Los `projectId` no se verifican contra Jiku.** Uno que apunte a un proyecto inexistente arranca
  igual; el síntoma aparece más tarde, por mail, como `project_not_found`.

Tres cosas de la configuración de la casilla que conviene saber antes de desplegar:

- **No hay variable de carpeta.** En v1 la carpeta es **`INBOX`, fija y no es configurable**: vive
  como constante del módulo de ingesta. Si buscás una `IMAP_FOLDER`, no existe, y la ausencia es una
  decisión y no un olvido.
- **Las tres credenciales de IMAP son requeridas incluso con `POLL_ENABLED=false`.** `POLL_ENABLED`
  es un **interruptor operativo**, no un modo de despliegue distinto: apagar el poll no convierte al
  conector en un servicio que no necesita la casilla.
- **Un `POLL_CRON` mal formado impide el arranque**, no falla más tarde al schedular. Es deliberado:
  un cron inválido dejaría un worker vivo que nunca ingesta nada y **sin síntoma**.
- **La casilla tiene que aceptar subaddress (`+slug`) y tener IMAP habilitado**, y ninguna de las
  dos es verificable por el conector al arrancar. En Gmail hace falta generar un **App Password**
  específico —**nunca** la contraseña de la cuenta— desde la configuración de seguridad de la
  cuenta, y habilitar IMAP en la configuración de Gmail (**Configuración → Ver toda la
  configuración → Reenvío y POP/IMAP → Habilitar IMAP**). Sin esto el arranque **no falla**, pero
  la ingesta tampoco funciona: es una precondición operativa de U-02, no algo que el software pueda
  detectar de antemano.

#### La política local de archivos y su redeploy

Las cuatro variables `ATTACHMENT_ALLOWED_EXTENSIONS`, `ATTACHMENT_ALLOWED_MIME_TYPES`,
`ATTACHMENT_MAX_SIZE_BYTES` y `PUT_TIMEOUT_MS` (tabla de arriba) se leen **una sola vez al
arrancar** —a diferencia del Mapa de Tickets, que se consulta en cada mail—: **agregar o cambiar la política local de archivos (listas
blancas, tamaño máximo) exige redeploy** — no hay recarga en caliente. El filtro local es
conveniencia, no autoridad (ADR-003): `core` decide en última instancia, así que una lista
desactualizada no rompe el sistema, sólo cambia qué se rechaza **antes** de tocar el bus.

Los montajes, y son los únicos — **dos, siempre**. Desde REQ-005 no hay un tercero: el Mapa de
Tickets dejó de poder declararse como archivo montado y vive en el Espacio KV del conector, dentro
de `JIKU_KV`.

```
/run/secrets/machine-user.json   (ro)   <- JIKU_KEY_FILE apunta acá
/run/secrets/sentinel.creds      (ro)   <- JIKU_CREDS apunta acá
```

**No hay ningún montaje de escritura**, y no es un olvido: el conector no persiste estado en disco —
sin archivos de estado, sin SQLite, sin caché (ADR-001). Los logs salen por stdout y los levanta el
recolector del cluster. Un volumen de escritura en la configuración de despliegue sería un error, no
una opción.

### Construir y correr la imagen

```bash
docker build --target production -t jiku-email-tickets:latest .

docker run --rm \
  -e JIKU_PROJECT_ID=... \
  -e JIKU_VERIFY_PROJECT_ID=... \
  -e JIKU_KEY_FILE=/run/secrets/machine-user.json \
  -e JIKU_CREDS=/run/secrets/sentinel.creds \
  -e JIKU_SERVERS=nats://bus:4222 \
  -e JIKU_INSTANCE=prod \
  -e IMAP_HOST=imap.gmail.com \
  -e IMAP_USER=tickets@grava.io \
  -e IMAP_PASSWORD=... \
  -v /ruta/host/machine-user.json:/run/secrets/machine-user.json:ro \
  -v /ruta/host/sentinel.creds:/run/secrets/sentinel.creds:ro \
  --network <la-red-del-bus> \
  jiku-email-tickets:latest
```

(El Mapa de Tickets no aparece acá porque no es una variable: se carga con `nats kv put JIKU_KV` y
la clave completa, y vale desde el mail siguiente.)

Con la configuración completa, el arranque emite **tres líneas JSON por stdout** (`configuracion
valida`, `conectado al bus` y `espacio KV abierto`, con el `kvPrefix` que se copia en las claves del
Mapa de Tickets) y el proceso **queda vivo**
con la conexión abierta. Con configuración
incompleta **no arranca**: sale con código distinto de cero e informa por stderr **la lista completa**
de lo que falta, no la primera variable que encontró.

### Correr `verify` contra el despliegue

El `CMD` de la imagen arranca el **worker** y **nunca** el modo de verificación. La razón es
estructural: un requisito creado no se modifica ni se borra, y no hay comando de compensación
(ADR-003). Si publicar fuera un efecto del arranque, **cada reinicio dejaría un requisito permanente
que nadie puede limpiar**.

El binario **sí viaja en la imagen** y se corre a mano, contra un **proyecto de prueba** (cada corrida
deja un requisito permanente — ver las tres advertencias de la sección anterior):

```bash
docker run --rm --entrypoint node <mismo entorno y montajes> jiku-email-tickets:latest dist/verify.js
# o, contra el contenedor ya corriendo:
docker exec <container> node dist/verify.js
```

**La primera corrida de un despliegue nuevo falla con `caller_not_authorized`, y ese es el resultado
correcto.** La fila del conector en la tabla `users` la crea Jiku sola en su primera autenticación;
hasta que exista, todo comando se rechaza. El conector **no la crea ni la pide**. **Volvé a correrlo**
y esta vez tiene éxito, sin que nadie tenga que crear la fila **a mano**.

### Dos restricciones operativas sin guard técnico

**Una sola instancia por casilla.** El despliegue tiene que correr **exactamente 1 instancia** por
casilla de mail (ADR-001). La deduplicación se apoya en el flag `\Seen` de IMAP, así que dos
instancias sobre la misma casilla se pisan. **No hay ningún guard técnico que lo impida**: es una
restricción operativa, y por eso mismo tiene que estar escrita acá.

**La imagen no declara `HEALTHCHECK`, y es deliberado.** El único check disponible sería un
`node -e "process.exit(0)"`, que **siempre pasa**: reportaría "healthy" para un proceso que perdió la
conexión al bus, que se quedó sin token o que está colgado. Una señal verde que **no prueba nada** es
peor que ninguna, porque el operador deja de mirar el log — que es lo único que este servicio tiene
(ADR-006: sin healthcheck ni métricas exportadas en v1).

La consecuencia está aceptada: el orquestador **no puede distinguir un worker vivo de uno colgado**.
Lo que sí detecta es el proceso **muerto** —que es exactamente lo que pasa con cualquier precondición
faltante— y en ese caso **reinicia**, repitiendo el mismo diagnóstico legible en cada intento. Eso es
lo deseado, no un loop ciego: el log dice en cada vuelta qué falta.

### Correr la suite contra la imagen

El `docker build` **no** ejecuta los tests, y no es una omisión: la suite levanta un contenedor NATS
real con **Testcontainers**, así que correrla dentro del build exigiría Docker dentro del build. La
etapa `test` deja el contexto listo para correr la suite **a mano** dentro de un contenedor:

```bash
docker build --target test -t jiku-email-tickets:test .
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock jiku-email-tickets:test npm test
```

El CI **no** usa esta etapa: corre la suite sobre el checkout. Ver
[Integración continua (GitLab CI)](#integración-continua-gitlab-ci).

## Testear

```bash
npm test
```

La suite levanta **un solo** contenedor NATS en el `globalSetup` de Vitest, compartido por todos los
archivos, y corre secuencialmente (`fileParallelism: false`).

Para verificar ademas que el teardown no deja el contenedor colgado:

```bash
npm run test:teardown
```

Corre la suite y despues le pregunta a Docker por el contenedor que levanto el `globalSetup`. Es un
paso separado porque el teardown ocurre cuando todos los archivos de test ya terminaron: ningun `it`
puede observarlo desde adentro.

Comprobacion manual equivalente, si se prefiere:

```bash
npm test
docker ps --filter ancestor=nats:2.10-alpine   # no debe listar nada tras la corrida
```

## Integración continua (GitLab CI)

El pipeline vive en [`.gitlab-ci.yml`](.gitlab-ci.yml) y tiene tres stages: `build` → `test` →
`release`. Las decisiones y su por qué están en
[ADR-007](docs/adrs/ADR-007-ci-gitlab-registry-del-proyecto.md).

| Evento | Qué corre | Qué se publica |
|---|---|---|
| Push a una rama de feature | `compile`, `build-image`, `test` | Nada |
| Merge request contra `dev` o `main` | `compile`, `build-image`, `test` (pipeline de MR, visible en el MR). Un push a la rama de origen no crea además un pipeline de rama | Nada |
| Push a `dev` (incluido el merge de un MR) | `build`, `test` y `release:dev` | `$CI_REGISTRY_IMAGE:dev`, que reemplaza al anterior. Corre aunque haya un MR `dev → main` abierto |
| Push a `main` | `build`, `test` y `release:main` | `$CI_REGISTRY_IMAGE:<version.txt>` y después `$CI_REGISTRY_IMAGE:master`, la misma imagen |
| Cambio sólo de documentación | Nada: no se crea pipeline | Nada |
| Push de un tag de git | Nada: el release sale de `main`, no de tags | Nada |

**Qué verifica.** `compile` corre `npm ci` → `npm run typecheck` → `npm run build`, y `build-image`
construye `--target production` **sin publicarla**. Si cualquiera de los dos falla, `test` y el
release no corren. `test` corre la suite **completa** con `npm run test:teardown`, sin filtros:
incluye los NATS reales por Testcontainers y `test/docker-image.test.ts`, que construye y ejecuta la
imagen. Corre **sobre el checkout** (`node:22-alpine` + `docker-cli`) con un servicio `docker:dind`
como daemon, y no dentro de la etapa `test` del `Dockerfile`: el `.dockerignore` saca `docs/` y
`*.md`, que varios tests leen. El `TMPDIR` del job es `$CI_PROJECT_DIR/.ci-tmp`, porque el checkout es
lo único que el job comparte con dind y los `-v` de los tests de imagen se resuelven del lado de
dind. `.ci-tmp` está en el `.dockerignore`.

**Qué se publica.** Sólo `release:dev` y `release:main` hacen `docker login` (con
`--password-stdin`) y `docker push`: las ramas de feature y los merge requests **no tocan el
registry**. El release **reconstruye** `--target production` desde el mismo commit, con
`--cache-from` del tag anterior. En `main`, la versión se publica **antes** que `:master`, así un
fallo entre los dos pushes nunca deja `:master` apuntando a una imagen sin versión. Si un test falla,
no corre ningún release y los tags siguen en la imagen anterior.

**Cómo subir la versión.** Editar `version.txt` (una sola línea semver, p. ej. `0.2.0` o
`0.2.0-rc1`, con salto de línea final) y mergear a `main`. Es **independiente** del `version` de
`package.json`. Si `version.txt` falta, está vacío o no es semver (incluidos `dev`, `master` o
`latest`), `release:main` falla antes del login y del build, y no se publica nada. Si no se cambia,
el tag de versión se sobrescribe con la imagen nueva.

**Qué dispara el pipeline.** `rules:changes` no admite negación, así que "sólo docs" se expresa
como una allowlist de rutas de código (`src/`, `test/`, `scripts/`, `package*.json`, `tsconfig*.json`,
`vitest.config.ts`, `Dockerfile`, `.dockerignore`, `version.txt` y el propio `.gitlab-ci.yml`).
El primer push de una rama nueva siempre dispara, aunque sea sólo de docs. Una entrada nueva en la
raíz del repo hace fallar `test/gitlab-ci.test.ts` hasta que se clasifique en
la allowlist o en su lista de exclusiones.

**Precondiciones del runner.** Executor Docker **privilegiado** (para `docker:dind`) y Container
Registry habilitado en el proyecto. No hace falta ninguna variable ni secreto propio: todo sale de
las variables predefinidas de GitLab (`CI_REGISTRY*`).

## Integración continua (GitHub Actions)

El repo también vive en [GitHub](https://github.com/gravadigital/jiku-email-tickets), con los
workflows de [`.github/workflows/`](.github/workflows/) armados sobre la misma base que jiku-docs.
Publican en Docker Hub, en `gravadigital/jiku-email-tickets`. El pipeline de GitLab no cambia.

| Workflow | Cuándo corre | Qué se publica |
|---|---|---|
| `ci.yml` | Push a `main` o `dev`, y cada pull request | Nada |
| `dev-images.yml` | Push a `dev` (o a mano) | `:dev` y `:dev-<sha>` |
| `release.yml` | Push de un tag `vX.Y.Z` | `:X.Y.Z`, `:X.Y` y `:latest` |

Los tres corren la suite completa con `npm run test:teardown`. El runner trae Docker, así que no
hace falta dind. Los cambios que tocan sólo `*.md` o `docs/` no disparan nada.

**Cómo publicar una versión.** Subir `version.txt`, mover `[Unreleased]` de
[`CHANGELOG.md`](CHANGELOG.md) a la sección de la versión, mergear a `main` y taggear:

```sh
git tag -a v1.0.2 -m "v1.0.2"
git push github v1.0.2
```

`release.yml` falla antes de construir nada si el tag no coincide con `version.txt` o si
`CHANGELOG.md` no tiene la sección `## [X.Y.Z]`.

**Secretos del repo.** `DOCKERHUB_USERNAME` y `DOCKERHUB_TOKEN`, los mismos que usa jiku-docs.

## Imports absolutos

Los imports internos usan las subpath imports nativas de Node, con la extensión `.js` que ESM exige:

```ts
import { SERVICE_NAME } from '#shared/service-info.js';
```

El mapeo está configurado en los dos lados: `paths` en `tsconfig.json` (compilación, apunta a `src/`) e
`imports` en `package.json` (runtime, apunta a `dist/`).
