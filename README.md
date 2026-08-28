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

### Las cinco precondiciones, a cargo de U-02

**El conector no puede resolver ninguna de las cinco.** Ninguna es código: viven en Zitadel, en el
bus, en Jiku y en la red. Lo único que el conector hace —y lo que sí garantiza— es **fallar de forma
legible**, nombrando **cuál de los tres sistemas rechazó**, porque el arreglo de cada uno está en un
lugar distinto.

| # | Precondición | Si falta, el conector… |
|---|---|---|
| 1 | **Machine user en Zitadel** con **Access Token Type = JWT** y el rol **`internal-app`** asignado en el project de gestión | …no arranca. `diagnosis: rechazo_del_bus_por_subject` (`Authorization Violation`) |
| 2 | **Key JSON descargada y guardada.** Zitadel la entrega **una sola vez**: no se puede volver a bajar, sólo reemplazar por una nueva | …no arranca. `code: BUS_KEY_LOAD_ERROR`, `diagnosis: key_ilegible`, sin volcar el contenido ni la ruta |
| 3 | **Creds del sentinel del bus** montado y alcanzable, y **`JIKU_PROJECT_ID`** configurado | …no arranca. Sin `JIKU_PROJECT_ID` el token **no lleva el claim de roles** y el bus rechaza sin nombrar la causa |
| 4 | **Una instancia de Jiku desplegada y alcanzable**, con al menos un `projectId` real para la prueba (`JIKU_VERIFY_PROJECT_ID`) | …**arranca igual** —el worker no consulta a `core`— pero `verify` falla con `nada_respondio` o `core_rechazo_por_forma` |
| 5 | **Red al bus:** el conector va **dentro** de la red del bus, que **no está expuesta al ingress** | …no arranca. `diagnosis: bus_inalcanzable` |

Tres aclaraciones que no son obvias:

- **La key no tiene procedimiento de rotación definido.** Zitadel la entrega una sola vez; si se
  pierde, lo único posible es generar una nueva y reemplazar el montaje. Decirlo es información;
  inventar un procedimiento que no existe sería peor que el silencio.
- **La precondición 5 no es una preferencia.** Desplegar el conector fuera de la red del bus no es
  una versión degradada: es imposible, porque esa red no tiene ingress.
- **La precondición 4 no afecta el arranque.** El worker arranca sin una instancia de Jiku
  alcanzable, porque no consulta a `core` para arrancar. Lo que falla es `verify`. Si `core` está
  caído, un contenedor sano **no** es evidencia de que Jiku esté sano.

Cuando el contenedor no arranque, el `diagnosis` de la línea de log dice quién rechazó y dónde está
el arreglo: la tabla de **diagnósticos** está más arriba, en
[Verificar el despliegue](#verificar-el-despliegue-npm-run-verify). No se duplica acá a propósito —
dos copias de la misma tabla divergen, y la que se lee termina siendo la vieja.

### Configuración: variables y montajes

Las diez variables que valida el arranque. **Ninguna lleva un secreto en su valor**: las dos
credenciales son **rutas a archivos montados**, no su contenido.

| Variable | Req. | Default | Qué es |
|---|---|---|---|
| `JIKU_CREDS` | **Sí** | — | **Ruta** al creds del sentinel de NATS (montado read-only) |
| `JIKU_KEY_FILE` | **Sí** | — | **Ruta** a la key JSON del machine user (montada read-only) |
| `JIKU_PROJECT_ID` | **Sí** | — | Project de **Zitadel** (UUID). Sin él el token no lleva roles |
| `JIKU_VERIFY_PROJECT_ID` | **Sí** | — | Proyecto de **Jiku** (entero) donde `verify` crea el requisito de prueba. **No es `JIKU_PROJECT_ID`** |
| `JIKU_INSTANCE` | No | `dev` | Primer segmento del subject |
| `JIKU_SERVERS` | No | `nats://localhost:4222` | Endpoint del bus |
| `JIKU_ISSUER` | No | `https://id.grava.io` | Issuer de Zitadel |
| `JIKU_TIMEOUT` | No | `15000` (ms) | Piso de 15000: valores menores se elevan. No bajarlo |
| `LOG_LEVEL` | No | `info` | `trace\|debug\|info\|warn\|error\|fatal\|silent` |
| `NODE_ENV` | No | `production` | Sólo `development` activa `pino-pretty`, que **no está en la imagen** |

Los dos montajes, y son los únicos:

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
  -v /ruta/host/machine-user.json:/run/secrets/machine-user.json:ro \
  -v /ruta/host/sentinel.creds:/run/secrets/sentinel.creds:ro \
  --network <la-red-del-bus> \
  jiku-mail-connector:latest
```

Con la configuración completa, el arranque emite **dos líneas JSON por stdout** (`configuracion
valida` y `conectado al bus`) y el proceso **queda vivo** con la conexión abierta. Con configuración
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
