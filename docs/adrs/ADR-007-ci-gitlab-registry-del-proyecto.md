# ADR-007: CI en GitLab con el registry del proyecto, la suite completa como gate

**Status:** Accepted
**Date:** 2026-09-25
**Deciders:** Technical Leader
**Tags:** ci, build, registry, testing

## Context

**El PRD difería el CI/CD** (`docs/prd/architecture.md`, §CI/CD: *"el pipeline, la publicación de la
imagen y el registry quedan como decisión pendiente"*). Jiku usa GitHub Actions con una matriz de
servicios, pero el conector es un repositorio aparte en `git.grava.io` (proyecto
`jiku-connectors/email-tickets`) y **no hereda ese workflow**. Hasta REQ-007 nada impedía que un
cambio llegara a `dev` o `main` sin correr la suite, y la imagen que se desplegaba era la que alguien
construyera a mano.

**La suite necesita Docker real, y eso condiciona el entorno del job:**

- NATS es un **contenedor real** levantado con Testcontainers (`nats:2.10-alpine` compartido en el
  `globalSetup`, `nats:2.11-alpine -js` en los tests del KV), nunca un doble
  (`conventions/testing.md`). No alcanza con un `services: nats`: la suite levanta sus propios
  contenedores.
- `test/docker-image.test.ts` ejecuta el binario `docker` (`docker build --target production`,
  `docker run`, `docker image rm`) con contexto `PROJECT_ROOT`, y **monta archivos con `-v`** creados
  con `mkdtemp(tmpdir())`.
- `test/bus/shared-container.test.ts` y `scripts/verify-teardown.mjs` corren `docker ps` y tienen que
  ver el mismo daemon que Testcontainers.
- Los archivos de test de documentación (`deployment-docs`, `story-011-docs`, `story-028-docs`,
  `story-029-docs` y `story-031-docs`)
  leen `README.md` y `docs/**`.

**Los repos de referencia del mismo GitLab resuelven el pipeline de dos formas que acá no sirven tal
cual**: `mattermost-integration` publica `:$CI_PIPELINE_ID` en el build y lo retaggea, y ambos corren
los tests con `docker run $PIPELINE_IMAGE npm test` dentro de la imagen. Esta ADR registra por qué
este repo no los copia, porque es lo primero que un lector futuro va a querer "corregir".

## Decision

**GitLab CI, con el Container Registry del proyecto, tres stages `build` → `test` → `release`, y la
suite completa como único gate de la publicación.**

### Plataforma, registry y tags

| Evento | Pipeline | Publica |
|---|---|---|
| Push a una rama de feature | `build` + `test` | Nada |
| Merge request contra `dev` / `main` | `build` + `test` (pipeline de MR, sin el de rama duplicado) | Nada |
| Push a `dev` | `build` + `test` + `release:dev` | `$CI_REGISTRY_IMAGE:dev` |
| Push a `main` | `build` + `test` + `release:main` | `$CI_REGISTRY_IMAGE:<version.txt>` y después `:master` |
| Cambio sólo de docs | No hay pipeline | Nada |
| Tag de git | No hay pipeline: el release sale de `main` | Nada |

La versión sale de **`version.txt`** en la raíz (una línea semver), **independiente** de
`package.json#version`. Las ramas de feature, los MR y los tags de git **no publican nada**.

### Decisión 1: la suite corre sobre el checkout, no dentro de la etapa `test`

El job `test` usa `node:22-alpine` (el mismo major que el `Dockerfile` y que el floor de `engines`)
con `docker-cli` y un servicio `docker:dind`, y corre `npm ci` + `npm run test:teardown` **sobre el
checkout**, que es lo mismo que corre un desarrollador. Dos razones verificadas en el código:

1. **El `.dockerignore` excluye `docs`, `*.md` y `.claude` del contexto.** Dentro de la imagen `test`
   los tests de docs fallarían por un motivo que no tiene que ver con el cambio. Sacarlos del
   `.dockerignore` debilita la garantía de "ningún secreto en la imagen" de S-006.
2. **`test/docker-image.test.ts` construye con contexto `PROJECT_ROOT`** y afirma que no hay `.git`
   en la imagen. Dentro del contenedor `test` el contexto sería el `/app` ya filtrado, y la aserción
   se volvería trivial.

La etapa `test` del `Dockerfile` **se conserva** como camino para correr la suite a mano.

### Decisión 2: el release reconstruye la imagen, no retaggea una publicada en el build

`build-image` construye `--target production` **sin publicarla**: si no se construye, no corren los
tests ni el release. `release:*` la **reconstruye** desde el mismo commit y el mismo
`package-lock.json` (`npm ci`), con `--cache-from` del tag anterior y `BUILDKIT_INLINE_CACHE=1`.

Publicar `:$CI_PIPELINE_ID` en cada push y cada MR llenaría el registry de tags por pipeline y
obligaría a una cleanup policy. Reconstruyendo, **las ramas de feature y los MR no escriben nada en
el registry por construcción**, no por una regla que alguien pueda romper.

### Docker-in-Docker sin tocar código

- `DOCKER_HOST=tcp://docker:2376` con TLS (`/certs/client`): Testcontainers, el CLI del job y
  `docker ps` hablan con el mismo daemon.
- `TESTCONTAINERS_HOST_OVERRIDE=docker`: los NATS quedan alcanzables en `docker:<puerto>`.
- `TMPDIR=$CI_PROJECT_DIR/.ci-tmp`: el volumen de builds es lo único que el job comparte con dind, y
  los `-v` de `docker-image.test.ts` se resuelven del lado de dind. `os.tmpdir()` respeta `TMPDIR`,
  así que ningún test cambia. `.ci-tmp` (donde también vive la caché de npm) está en el
  `.dockerignore`, así las keys de prueba no viajan en el contexto de build.

### "Sólo docs" como allowlist

`rules:changes` no admite negación, así que el pipeline corre si cambió alguna ruta de código:
`src/`, `test/`, `scripts/`, `vendor/`, `package.json`, `package-lock.json`, `tsconfig*.json`,
`vitest.config.ts`, `Dockerfile`, `.dockerignore`, `version.txt` y **el propio `.gitlab-ci.yml`**
(editar el CI tiene que correr el CI). `test/gitlab-ci.test.ts` exige que cada entrada de la raíz
esté en la allowlist o en una lista explícita de exclusiones.

### Duplicados, interrupción y orden

- Un push a una rama con MR abierto no crea pipeline de rama (ya corre el del MR), **salvo en `dev` y
  `main`**: suprimirlo ahí dejaría de publicar `:dev` mientras haya un MR `dev → main` abierto.
- `build` y `test` son `interruptible: true`; los releases son `interruptible: false` con
  `resource_group` por tag, así nunca se publica medio build de uno y medio de otro.
- `release:main` valida `version.txt` **antes** del login y del build, construye los dos tags juntos
  y publica **`:$VERSION` antes que `:master`**.

## Implementation Rules

- El job de test MUST correr la suite **completa** con `npm run test:teardown`. MUST NOT filtrarla
  (`--exclude`, `--project`, rutas, `-t`, un script `test:ci`)
- El job de test MUST correr **sobre el checkout** con `node:22-alpine` y un servicio `docker:dind`.
  MUST NOT correrse con `docker run` sobre la etapa `test` del `Dockerfile`
- La imagen de producción MUST construirse en el stage `build` **sin publicarse**, y el release MUST
  reconstruirla con `--target production`
- Sólo `release:dev` y `release:main` (y su plantilla `.release`) MUST hacer `docker login` o
  `docker push`. Los demás jobs MUST NOT tocar el registry
- Los releases MUST depender de `test` (`needs: [test]`) y sus `rules` MUST nombrar exactamente `dev`
  y `main`, con `CI_PIPELINE_SOURCE == "push"`
- El login MUST usar `--password-stdin` con `$CI_REGISTRY_USER` / `$CI_REGISTRY_PASSWORD`. MUST NOT
  pasar la contraseña con `-p`
- `release:main` MUST validar `version.txt` (existe, no vacío, semver) **antes** del `docker login` y
  del `docker build`
- `release:main` MUST publicar `:$VERSION` **antes** que `:master`
- `version.txt` MUST NOT atarse a `package.json#version`: ningún job ni test los compara
- Toda entrada nueva de la raíz del repo MUST clasificarse en la allowlist `.code-changes` o en
  `EXCLUDED_ROOT_ENTRIES` de `test/gitlab-ci.test.ts`, y `.gitlab-ci.yml` y `version.txt` MUST estar
  en la allowlist
- El job de test MUST tener `TMPDIR` bajo `$CI_PROJECT_DIR`, y `.ci-tmp` MUST estar en el
  `.dockerignore`
- Los releases MUST ser `interruptible: false` y llevar `resource_group` (`release-dev`,
  `release-main`)
- MUST NOT publicarse imágenes desde tags de git, ramas de feature ni merge requests

## Consequences

### Positive

- **Ningún cambio llega a `dev` o `main` sin la suite completa**, incluidos los NATS reales y los
  tests que construyen y ejecutan la imagen
- La imagen publicada es siempre una cuya construcción pasó la suite en ese mismo pipeline
- Feature y MR no tocan el registry, así que un MR de una rama no confiable no puede publicar
- Sin secretos ni variables nuevas en el proyecto: todo sale de las variables predefinidas
- Las propiedades del pipeline están fijadas por un test declarativo que corre en milisegundos

### Negative

- **La imagen se construye tres veces por pipeline de `dev`/`main`** (build, `docker-image.test.ts`
  y release). La segunda y la tercera reusan capas. Aceptado a cambio de no publicar tags por
  pipeline
- **Un cambio sólo de docs puede romper un test de docs sin que el CI lo vea** hasta el siguiente
  push de código: acá, a diferencia de `core`, hay tests que leen `docs/**` y `README.md`
- Cada pipeline tarda varios minutos: la suite construye la imagen y levanta contenedores
- La allowlist exige clasificar cada entrada nueva de la raíz (mitigado por el test)

### Risks

- **Runner no privilegiado:** sin `privileged = true`, `docker:dind` no arranca y ningún job de
  Docker corre. Fallback si faltan los certificados TLS: `DOCKER_HOST=tcp://docker:2375` con
  `DOCKER_TLS_CERTDIR=""`
- **Volumen de builds no compartido con dind:** los `-v` de `docker-image.test.ts` montarían un
  directorio vacío. Fallback: reemplazarlos en ese test por `docker create` + `docker cp` +
  `docker start -a`
- **Pull-rate de Docker Hub:** `node:22-alpine`, `docker:27-*` y los `nats:*` salen de Docker Hub.
  Un `toomanyrequests` da un rojo que no es del código; se reintenta
- **`freeHostPort()`** de los helpers del bus pregunta el puerto al SO del job, no al de dind. Con un
  dind nuevo por job no hay colisión

## Alternatives Considered

### Alternativa 1: publicar `:$CI_PIPELINE_ID` en el build y retaggearlo en el release

Es el patrón de `mattermost-integration` y el que propone la convención de catálogo `ci-gitlab`.

**Pros:**
- La imagen publicada es byte a byte la que se construyó en el build
- El release es un retag, sin rebuild

**Cons:**
- Cada push de feature y cada MR escriben un tag en el registry
- Obliga a una cleanup policy para tags inmutables que el request deja fuera de alcance
- "Feature y MR no tocan el registry" pasa a depender de una regla y no de la construcción

**Why rejected:** llena el registry y hace que la ausencia de publicación desde ramas no confiables
dependa de una regla. Reconstruir desde el mismo commit y lockfile con `npm ci` da la misma imagen
funcional con cache.

---

### Alternativa 2: correr la suite con `docker run $PIPELINE_IMAGE npm test`

**Pros:**
- Es el patrón de los dos repos de referencia y el camino que documentaba el README
- La suite corre en el mismo entorno que la imagen

**Cons:**
- El `.dockerignore` saca `docs/` y `*.md`: los tests de docs fallan
- `docker-image.test.ts` construiría con un contexto ya filtrado y su aserción sobre `.git` se
  vuelve trivial
- Sacar esas entradas del `.dockerignore` debilita la garantía de "ningún secreto en la imagen"

**Why rejected:** rompe la suite o debilita el `.dockerignore`. La etapa `test` queda para correr la
suite a mano.

---

### Alternativa 3: `services: nats` en lugar de `docker:dind`

**Pros:**
- Sin runner privilegiado
- Pipeline más rápido

**Cons:**
- La suite levanta **sus propios** contenedores con Testcontainers (dos versiones de NATS, una con
  JetStream) y construye la imagen: sin daemon Docker no corre
- Habría que cambiar los tests para apuntarlos a un NATS externo, con lo que dejarían de verificar
  el teardown y el contenedor compartido

**Why rejected:** exige cambiar la suite para adaptarla al CI, al revés de lo que se quiere.

---

### Alternativa 4: excluir del CI los tests que necesitan Docker

**Pros:**
- Pipeline rápido y sin dind

**Cons:**
- Los tests excluidos son justamente los de integración real (bus, KV, imagen), que son los que
  detectan lo que los unitarios no
- La imagen se publicaría sin que `docker-image.test.ts` verificara que es no-root, sin secretos y
  sin devDependencies

**Why rejected:** el request pide la suite completa como gate. Un CI que corre una suite parcial da
una señal verde que no prueba lo que importa.

## References

- [REQ-007](../requests/REQ-007.pipeline-ci.md) y [S-031](../stories/S-031.pipeline-ci-gitlab-verificacion-publicacion.md)
- [`.gitlab-ci.yml`](../../.gitlab-ci.yml) y `test/gitlab-ci.test.ts`
- [ADR-001](ADR-001-worker-unico-sin-persistencia.md) y [ADR-006](ADR-006-observabilidad-por-logs.md):
  se conservan; el pipeline publica la misma imagen de S-006, sin puerto ni `HEALTHCHECK`
- `README.md`, §Integración continua (GitLab CI)
- **Siguen diferidos:** el deploy (compose propio o el de Jiku), el entorno de staging, la rotación
  de la key del machine user y la gestión de secretos más allá de env + archivos montados
