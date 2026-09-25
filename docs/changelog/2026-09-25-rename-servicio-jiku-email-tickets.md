---
date: 2026-09-25
service: jiku-email-tickets
---

# El servicio pasa a llamarse `jiku-email-tickets` (antes `jiku-mail-connector`)

## Qué cambió

Es un renombre mecánico: **ningún comportamiento cambia**.

### Lo que cambia en runtime

- **El campo `service` de cada línea de log** (`SERVICE_NAME` en `src/shared/service-info.ts`) pasa
  de `jiku-mail-connector` a `jiku-email-tickets`. Si alguien filtra los logs por ese valor, tiene que
  actualizar el filtro. Todavía no hay un despliegue que consuma los logs (el deploy sigue diferido),
  así que hoy no hay nada que migrar.
- El título del requisito que crea el modo de verificación (`npm run verify`) pasa a
  `[verificacion de despliegue] jiku-email-tickets`.
- El `name` de `package.json` y los tags locales de imagen que usan el pipeline, el `Dockerfile` y los
  tests (`jiku-email-tickets:ci`, `:test`, `:vitest`).

### Lo que cambia en la documentación

- `docs/architectures/jiku-mail-connector/` → `docs/architectures/jiku-email-tickets/`, y `service:`
  del `manifest.yaml`. Los skills de la metodología resuelven el servicio por ese nombre.
- `docs/reusable-code/jiku-mail-connector/` → `docs/reusable-code/jiku-email-tickets/`.
- Los story plans `S-XXX.jiku-mail-connector.*.md` → `S-XXX.jiku-email-tickets.*.md`.
- Todas las menciones en requests, stories, flujos, ADRs, PRD, README y tests.

### Lo que no cambia

- El proyecto en GitLab sigue siendo `jiku-connectors/ticket-receptor`, y con él la imagen publicada:
  `$CI_REGISTRY_IMAGE` sale del path del proyecto, no del nombre del servicio. Las menciones a ese
  path en ADR-007, REQ-007, S-031 y su story plan se mantienen.
- Las variables `JIKU_*`: nombran la plataforma Jiku, no este servicio.
- `mail-connector` en ADR-005: es el nombre de un rol de Zitadel que se consideró como alternativa,
  no el servicio.
