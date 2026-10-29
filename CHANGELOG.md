# Changelog

Los cambios de cada versión publicada. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones siguen
[Semantic Versioning](https://semver.org/lang/es/).

La versión vive en `version.txt`. Un tag `vX.Y.Z` publica la imagen en Docker Hub
(`gravadigital/jiku-email-tickets`) y exige que el tag coincida con `version.txt` y que este archivo
tenga su sección. El detalle de cada story está en [`docs/changelog/`](docs/changelog/).

## [Unreleased]

## [1.0.1] - 2026-10-28

### Changed

- **El SDK se consume del registry**: `@gravadigital/jiku@^1.1.0`, la primera versión publicada con
  el Espacio KV (`client.kv()`). Es el mismo código que el build de `jiku-ts@edd1064` que viajaba en
  `vendor/`, que se borró junto con sus copias en el `Dockerfile`.

### Added

- **CI en GitHub Actions**, con la misma base que jiku-docs: `ci.yml` corre la suite completa en cada
  push a `main`/`dev` y en cada pull request; `dev-images.yml` publica `:dev` y `:dev-<sha>` desde
  `dev`; `release.yml` publica `X.Y.Z`, `X.Y` y `latest` desde un tag `vX.Y.Z`. El pipeline de
  GitLab sigue igual.

## [1.0.0] - 2026-10-09

Primera versión. El conector ingesta los mails de una casilla IMAP y los publica como tickets en el
bus de Jiku a través del SDK `@gravadigital/jiku`, con el estado en el Espacio KV del SDK.

[Unreleased]: https://github.com/gravadigital/jiku-email-tickets/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/gravadigital/jiku-email-tickets/releases/tag/v1.0.1
[1.0.0]: https://git.grava.io/jiku/conector-email-tickets/-/commit/0931104
