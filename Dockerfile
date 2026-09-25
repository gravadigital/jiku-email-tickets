# jiku-mail-connector — imagen del worker.
#
# Variante WORKER de la convencion `dockerfile`: tres etapas, usuario no-root, `npm ci --omit=dev`,
# y ningun secreto horneado. La key del machine user y el creds del sentinel se MONTAN read-only en
# tiempo de ejecucion (ADR-005); `JIKU_KEY_FILE` y `JIKU_CREDS` llevan esas RUTAS, no su contenido.
#
# node:22-alpine y no la 24 de la convencion: el `engines` floor del servicio es >=22.12 y fijar 22
# hace que la imagen corra el MISMO major que la maquina de desarrollo. La diferencia no es
# cosmetica: `await using` es un error de sintaxis en Node 22 y valido en 24, asi que un runtime de
# produccion mas nuevo que el de desarrollo acepta codigo que el otro rechaza, y el que se entera
# tarde es siempre produccion. Si el floor sube, sube en `engines`, aca y en el test, en el mismo
# cambio.

# ---------------------------------------------------------------------------------------------
# Etapa `test` — deja el contexto listo para correr la suite. NO la corre.
# ---------------------------------------------------------------------------------------------
# El `docker build` NO ejecuta los tests, y eso es obligatorio, no una comodidad: la suite levanta
# un contenedor NATS real con Testcontainers, asi que un `RUN npm test` necesitaria Docker DENTRO
# del build (docker-in-docker o el socket montado), que un `docker build` normal no tiene. La etapa
# queda preparada y la corre quien quiera la suite dentro de un contenedor; el CI la corre sobre el
# checkout, no aca (ver ADR-007):
#
#   docker build --target test -t jiku-mail-connector:test .
#   docker run --rm -v /var/run/docker.sock:/var/run/docker.sock jiku-mail-connector:test npm test
FROM node:22-alpine AS test
WORKDIR /app
# `package*.json` + `npm ci` ANTES de `COPY . .`: invertirlo hace que cualquier cambio de codigo
# invalide la capa de instalacion de dependencias.
# TEMPORAL (REQ-005 / S-024): `vendor/` viaja junto a `package*.json` porque el rango del SDK
# apunta a un tarball local mientras el minor 1.1.0 de S-023 no este publicado en el registry. Sin
# esta copia, `npm ci` falla con ENOENT sobre el .tgz y la imagen NO SE CONSTRUYE — verificado
# corriendo el build. Cuando 1.1.0 se publique, el rango vuelve a `^1.1.0`, `vendor/` se elimina y
# estas tres copias se borran con el.
COPY package*.json ./
COPY vendor ./vendor
RUN npm ci
COPY . .

# ---------------------------------------------------------------------------------------------
# Etapa `builder` — compila TypeScript a JavaScript ESM.
# ---------------------------------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
# Ver la nota TEMPORAL de la etapa `test`.
COPY vendor ./vendor
RUN npm ci
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------------------------
# Etapa `production` — la imagen final.
# ---------------------------------------------------------------------------------------------
FROM node:22-alpine AS production
WORKDIR /app

# Usuario no-root nombrado por el servicio. El `USER` va DESPUES de todos los COPY/RUN, porque esos
# pasos escriben en /app.
RUN addgroup -g 1001 -S nodejs \
    && adduser -S connector -u 1001 -G nodejs

# El `dist/` viene de `builder`, NUNCA del contexto: copiarlo del host haria que la imagen
# dependiera de que alguien corriera `npm run build` antes.
COPY --from=builder /app/dist ./dist

# `package.json` se queda en /app despues del `npm ci`, y no es un residuo: el campo `imports` vive
# ahi y es lo que le dice a Node como resolver `#config/*`, `#domain/*`, `#infra/*` y `#shared/*`.
# Borrarlo "para optimizar" produce una imagen que se construye perfecta y muere al arrancar con
# ERR_PACKAGE_IMPORT_NOT_DEFINED. Los prefijos apuntan a ./dist/*, asi que `dist/` tiene que quedar
# hermano de este archivo.
COPY package*.json ./
# Ver la nota TEMPORAL de la etapa `test`.
COPY vendor ./vendor

# `npm ci --omit=dev` y nunca `npm install`: la imagen instala exactamente el lockfile que la suite
# verifico. Sin devDependencies, la imagen no lleva vitest, testcontainers, typescript ni
# pino-pretty — y no lleva NINGUN cliente de base ni de storage porque el servicio no declara
# ninguno (ADR-001). El `npm cache clean` va en el MISMO RUN, o la capa conserva el cache.
#
# Sin `apk add python3 make g++`: ninguna de las cinco dependencias de produccion compila modulos
# nativos, y la propia convencion autoriza quitarlo cuando no hace falta.
RUN npm ci --omit=dev && npm cache clean --force

USER connector

# Sin EXPOSE, y no por olvido: el conector no expone HTTP. Es un unico proceso Node sin servidor, sin
# framework web y sin rutas (ADR-001), y va DENTRO de la red del bus, que no esta expuesta al
# ingress. Sin puerto declarado no hay puerto que publicar por error.
#
# Sin HEALTHCHECK, tampoco por olvido. La convencion sugiere para workers
# `HEALTHCHECK CMD node -e "process.exit(0)"`, y ese check SIEMPRE PASA: reporta "healthy" para un
# proceso que perdio la conexion al bus, que se quedo sin token o que esta colgado. Una señal verde
# que no prueba nada es peor que ninguna, porque el operador deja de mirar el log — que es lo unico
# que este servicio tiene (ADR-006: sin healthcheck ni metricas en v1). La consecuencia esta
# aceptada y documentada en el README: el orquestador no distingue un worker vivo de uno colgado,
# pero SI detecta el proceso muerto, que es lo que pasa con cualquier precondicion faltante; en ese
# caso reinicia y el log repite el mismo diagnostico legible en cada intento.
#
# Sin ninguna linea ENV: los defaults viven en el schema Zod (`src/config/schema.ts`), validados y
# tipados, y los secretos se inyectan en runtime. Este servicio no tiene `.env.defaults`.

# Forma exec y el ejecutable directo, no `npm run start`: `npm` interpone un proceso padre que no
# propaga señales al hijo, asi que el worker nunca recibiria un SIGTERM limpio y el orquestador
# terminaria matandolo. El apagado ordenado es de FG-2; la forma exec no lo agrega, lo habilita.
#
# Arranca el WORKER, nunca `dist/verify.js`. La separacion es estructural: un requisito creado no se
# modifica ni se borra nunca y no hay comando de compensacion (ADR-003), asi que si el arranque
# publicara, cada reinicio del contenedor dejaria un requisito permanente que nadie puede limpiar —
# y un contenedor sin HEALTHCHECK que falla por una precondicion faltante es reiniciado en loop. El
# binario de verificacion SI viaja en la imagen: se corre a mano contra el despliegue (ver README).
CMD ["node", "dist/index.js"]
