---
date: 2026-10-28
service: jiku-email-tickets
---

# El SDK se consume del registry: `@gravadigital/jiku@^1.1.0`

## Qué cambió

`@gravadigital/jiku` 1.1.0 está publicado en npm y trae el Espacio KV (`client.kv()`), el mismo
código que el `npm pack` de `jiku-ts@edd1064` que el conector consumía desde S-032. Con eso se
cumple lo que la nota TEMPORAL del `Dockerfile` anticipaba:

- `package.json` declara `^1.1.0` y el lockfile resuelve contra `registry.npmjs.org`.
- `vendor/` se borró, junto con las tres `COPY vendor ./vendor` del `Dockerfile` y su nota.
- `vendor/**/*` salió de la allowlist de `rules:changes` del CI y del README.
- TS-1, TS-2 (manifest) y TS-6 (Dockerfile) ahora afirman el rango del registry y la ausencia de
  `vendor/`. TS-3 sigue afirmando sobre lo instalado, que es lo que importa.

ADR-002 y el overview de arquitectura se actualizaron. Las stories, requests y changelogs
anteriores describen el estado de su momento y no se tocaron.
