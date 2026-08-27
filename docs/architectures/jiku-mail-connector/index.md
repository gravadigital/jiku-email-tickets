# jiku-mail-connector — Arquitectura

> Auto-generado desde [manifest.yaml](./manifest.yaml). No editar a mano.

**Tipo:** worker | **Lenguaje:** node

## Especifico del servicio

- [Overview](./overview.md)
- [Manifest](./manifest.yaml)

## Convenciones activas

- **[Convenciones generales](../../../.claude/conventions/node/_base.md)** — Base conventions for any Node service (always active) (siempre activa)
- **[Logging estructurado (Pino)](../../../.claude/conventions/node/logging.md)** — Structured logging with Pino
- **[Configuración de entorno (@t3-oss/env-core)](../../../.claude/conventions/node/env-config.md)** — Type-safe environment variable validation at startup using @t3-oss/env-core and Zod
- **[Validacion de inputs (Zod)](../../../.claude/conventions/node/validation.md)** — Input validation with Zod
- **[Manejo de errores](../../../.claude/conventions/node/error-handling.md)** — Error modeling, propagation, and canonical error shape
- **[Testing (Vitest + NATS de Testcontainers, sin base de datos)](./conventions/testing.md)** — Unit and integration testing with Vitest against a real NATS container; no database anywhere, IMAP and the presigned PUT are doubled at the boundary **(custom del servicio — reemplaza la del catálogo)**
- **[Dockerfile (Node)](../../../.claude/conventions/node/dockerfile.md)** — Multi-stage Dockerfile for Node.js services — test, builder, and production stages

---

**Total:** 7 convenciones activas (1 custom del servicio: `testing`).
