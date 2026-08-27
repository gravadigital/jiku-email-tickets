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
separado (`npm run verify`), y se implementa en S-005.

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
