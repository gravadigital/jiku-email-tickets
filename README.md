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
