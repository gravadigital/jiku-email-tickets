# jiku-mail-connector

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
| 8 | **JetStream habilitado en el bus, permisos de KV para la cuenta del conector en el auth-callout, y los dos buckets creados** (REQ-005) | …**no arranca**. `code: KV_BUCKET_MISSING_ERROR`. Si falta un bucket, `diagnosis: bucket_inexistente` y el log **nombra cuál**; si falta JetStream o los permisos, `diagnosis: kv_no_disponible` (son indistinguibles desde el cliente, así que el mensaje nombra las dos cosas) |

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
- **La precondición 8 la crea el operador, y el conector NO la crea por él.** Los dos buckets se
  crean a mano, una vez por despliegue:

  ```bash
  nats kv add TICKETS                    # el Mapa de Tickets: slug -> projectId
  nats kv add MAIL_THREADS --ttl=90d     # el Mapa de Hilos: sha256(Message-Id) -> requirementId
  ```

  (los nombres son los defaults; se cambian con `KV_TICKETS_BUCKET` y `KV_THREADS_BUCKET`.)

  Que el conector no los cree es deliberado: un typo en el nombre del bucket crearía un bucket
  **vacío** en silencio, y el síntoma sería un conector aparentemente sano que descarta todos los
  mails sin decir por qué. Un arranque que falla nombrando el bucket que falta es mucho mejor.

  El **TTL tampoco lo fija el conector**: lo compara contra `KV_THREADS_TTL_DAYS` y avisa con un
  `warn` si difieren, pero arranca igual. Un TTL distinto no rompe el ruteo —sólo cambia la ventana
  en la que una respuesta a un hilo viejo sigue encontrando su requisito— y fijarlo exigiría el
  permiso de escritura de streams que la decisión de no crear buckets existe para evitar.

Cuando el contenedor no arranque, el `diagnosis` de la línea de log dice quién rechazó y dónde está
el arreglo: la tabla de **diagnósticos** está más arriba, en
[Verificar el despliegue](#verificar-el-despliegue-npm-run-verify). No se duplica acá a propósito —
dos copias de la misma tabla divergen, y la que se lee termina siendo la vieja.

### Configuración: variables y montajes

Las veintiséis variables que valida el arranque. Las dos credenciales del bus son **rutas a archivos
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
| `KV_TICKETS_BUCKET` | No | `TICKETS` | Nombre del bucket KV del Mapa de Tickets. **El conector no lo crea:** lo crea el operador con `nats kv add` |
| `KV_THREADS_BUCKET` | No | `MAIL_THREADS` | Nombre del bucket KV del Mapa de Hilos. **El conector no lo crea** |
| `KV_THREADS_TTL_DAYS` | No | `90` | TTL **esperado** del bucket de hilos, en **días**. El conector lo **compara** contra el real y avisa con un `warn` si difiere; **no lo fija** |
| `KV_WATCH_RETRY_MS` | No | `30000` | Cada cuánto reintenta el `watch()` del Mapa de Tickets si se cae. Mientras tanto el mapa **se conserva** y el ruteo sigue funcionando con la última copia buena |

#### El Mapa de Tickets vive en un bucket KV del bus

El Mapa de Tickets es lo que traduce el slug del subaddress al `projectId` de Jiku donde se crea el
requisito. **Desde REQ-005 no es una variable de entorno**: es un bucket KV de NATS, con el slug
como clave y el `projectId` como valor.

```bash
nats kv add TICKETS                 # una vez, al preparar el despliegue
nats kv put TICKETS alfa 42         # y un put por proyecto
nats kv put TICKETS beta 7
```

**El cambio que esto compra: agregar un proyecto ya no necesita redeploy.** El conector sigue el
bucket con `watch()` sobre una copia en memoria, así que un `nats kv put` aparece en el ruteo en
segundos, con el worker corriendo. Antes había que editar la variable y redesplegar el contenedor.

Seis cosas que conviene saber antes de operarlo:

- **Los slugs se normalizan a minúsculas.** La comparación es en minúsculas en las dos puntas —la
  del mapa y la del mail—, así que `nats kv put TICKETS Alfa 42` se guarda tal cual pero **no
  matchea** `tickets+alfa@…`. Usá siempre minúsculas en la clave.
- **El valor es el entero de Jiku**, nunca el nombre del proyecto ni su slug. Un valor que no sea un
  entero positivo se **ignora con un `warn`** que nombra la clave: no tumba el watch ni el proceso,
  porque un dato malo cargado a mano no debe dejar sin ruteo a los demás proyectos.
- **Un bucket vacío es válido y arranca.** Es el estado de todo despliegue nuevo. El worker arranca
  y descarta todo con log hasta que se cargue el primer slug.
- **El bucket tiene que existir.** Si no existe, el conector **no arranca** y el log nombra cuál
  falta (S-024). El conector no lo crea a propósito: un typo en el nombre crearía un bucket vacío en
  silencio, y el síntoma sería que descarta todos los mails sin decir por qué.
- **Borrar una clave la saca del ruteo**, también en caliente: el `watch()` recibe el `DEL` y la
  quita de la copia en memoria.
- **Los `projectId` no se verifican contra Jiku.** Uno que apunte a un proyecto inexistente arranca
  igual; el síntoma aparece más tarde, por mail, como `project_not_found`.

**Si el `watch()` se cae, el ruteo sigue funcionando con la última copia buena** y el conector
reintenta cada `KV_WATCH_RETRY_MS`. Lo que se pierde mientras tanto son las actualizaciones, no el
mapa: vaciarlo ante una caída del bus dejaría de rutear mails que se podían rutear perfectamente.

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
arrancar**, igual que el Mapa de Tickets: **agregar o cambiar la política local de archivos (listas
blancas, tamaño máximo) exige redeploy** — no hay recarga en caliente. El filtro local es
conveniencia, no autoridad (ADR-003): `core` decide en última instancia, así que una lista
desactualizada no rompe el sistema, sólo cambia qué se rechaza **antes** de tocar el bus.

Los montajes, y son los únicos — **dos, siempre**. Desde REQ-005 no hay un tercero: el Mapa de
Tickets dejó de poder declararse como archivo montado y vive en un bucket KV del bus.

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
docker build --target production -t jiku-mail-connector:latest .

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
  jiku-mail-connector:latest
```

(El Mapa de Tickets no aparece acá porque ya no es una variable: se carga con `nats kv put` sobre
el bucket, y el conector lo sigue en caliente.)

Con la configuración completa, el arranque emite **tres líneas JSON por stdout** (`configuracion
valida`, `conectado al bus` y la del Mapa de Tickets cargado desde el KV) y el proceso **queda vivo**
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
docker run --rm --entrypoint node <mismo entorno y montajes> jiku-mail-connector:latest dist/verify.js
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
etapa `test` deja el contexto listo y quien la corre es el pipeline:

```bash
docker build --target test -t jiku-mail-connector:test .
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock jiku-mail-connector:test npm test
```

CI/CD, el registry y el pipeline están **fuera del alcance de este repo**: lo que el repo entrega es
la etapa lista y el comando exacto.

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

## Imports absolutos

Los imports internos usan las subpath imports nativas de Node, con la extensión `.js` que ESM exige:

```ts
import { SERVICE_NAME } from '#shared/service-info.js';
```

El mapeo está configurado en los dos lados: `paths` en `tsconfig.json` (compilación, apunta a `src/`) e
`imports` en `package.json` (runtime, apunta a `dist/`).
