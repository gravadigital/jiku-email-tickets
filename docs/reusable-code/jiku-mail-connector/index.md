# Reusable Code - jiku-mail-connector

This document lists all reusable code available in this service. Each category has its own file with
detailed documentation.

Created by S-001 (bootstrap), extended by S-002 (typed configuration) and S-003 (structured logging
with redaction). The service is a `worker` in Node.js with no HTTP surface and no database, so several
categories do not apply and stay empty until a story creates them.

## Components

N/A (Backend service)

## Utils/Helpers

No utils/helpers documented yet.

## Middlewares

N/A (no HTTP surface - ADR-001)

## Services/Repositories

**Total: 3**

- **loadAppConfig()** (`src/config/index.ts`) - Resolves the single, validated configuration of the
  process: the Zod-validated environment composed with the bus settings the SDK's `loadConfig()`
  returns.
- **createLogger()** (`src/shared/logger.ts`) - Builds a Pino logger: JSON to stdout, level from the
  validated configuration, `pino-pretty` only in development, and `redact` wired. Its optional
  `destination` and `transportTarget` parameters are for tests.
- **initLogger() / getLogger()** (`src/shared/logger.ts`) - The process-wide logger singleton.
  Initialized once from `src/index.ts`; `getLogger()` throws a clear error if used before that.

See full details in [services.md](./services.md)

## Test Helpers

**Total: 2**

- **setupTestBus** (`test/bus/helpers.ts`) - Opens a NATS connection against the suite's shared
  container and builds a bus `Client` with `Client.fromConnection()`, returning a context with
  `cleanup()`.
- **createLogCapture** (`test/shared/log-capture.ts`) - In-memory `DestinationStream` for the logger,
  exposing the emitted lines both parsed (`lines()`) and raw (`raw()`) so a test can assert on the
  **serialized** line. Needed by S-004 and S-005 for their own diagnostic lines.

See full details in [test-helpers.md](./test-helpers.md)

## Types

**Total: 4**

- **AppError** (`src/shared/errors/base.ts`) - Abstract base of the service's error hierarchy, with a
  public `code`, an `httpStatus` and optional non-sensitive `details`.
- **ConfigValidationError** (`src/config/errors.ts`) - Raised when the environment fails validation.
  Carries the complete list of offending variable names in `variables`.
- **AppConfig** (`src/config/index.ts`) - The process-wide configuration contract consumed by S-003,
  S-004 and S-005. Ten fields since S-003 added `nodeEnv`; five of them must never reach a log line.
- **TestBusContext** (`test/bus/helpers.ts`) - Return type of `setupTestBus()`: the NATS connection,
  the bus client, and a `cleanup()` that drains the connection.

See full details in [types.md](./types.md)

## Constants

**Total: 9**

- **SERVICE_NAME** (`src/shared/service-info.ts`) - The service name, used wherever the process has to
  identify itself.
- **MIN_TIMEOUT_MS** (`src/config/schema.ts`) - Floor for the command timeout, 15000 ms. A shorter
  timeout turns an explained error into a mute one.
- **DEFAULT_ISSUER** (`src/config/schema.ts`) - Default Zitadel issuer of this deployment. The SDK
  deliberately has no default for it.
- **DEFAULT_SERVERS_URL** (`src/config/schema.ts`) - Default bus endpoint. The SDK applies this one
  only at `connect()`, not at `loadConfig()`.
- **TEST_USER_ID** (`test/bus/helpers.ts`) - Fixed caller identity used by the test bus context.
- **TEST_INSTANCE** (`test/bus/helpers.ts`) - Bus instance name used by the test bus context.
- **REDACT_PATHS** (`src/shared/log-redaction.ts`) - The `redact` paths the logger censors: tokens,
  credentials, machine-user key content, NATS creds, secret file paths, and — declared before the data
  exists — mail body and attachment content. Read its notes before editing: Pino's wildcards match a
  single level and there is no deep wildcard, so entries are deliberately duplicated.
- **REDACT_CENSOR** (`src/shared/log-redaction.ts`) - The replacement value for every redacted path:
  `'[REDACTED]'`.
- **DEVELOPMENT_TRANSPORT_TARGET** (`src/shared/logger.ts`) - The development-only transport target,
  `'pino-pretty'`. Absent from the production image, which is why the logger degrades.

See full details in [constants.md](./constants.md)

## Validators

**Total: 1**

- **envSchema** (`src/config/schema.ts`) - Zod shapes of the ten environment variables in scope, with
  their defaults and the timeout floor. The source of truth for the `Env` type. S-003 added `NODE_ENV`,
  defaulted to `production`.

See full details in [validators.md](./validators.md)
