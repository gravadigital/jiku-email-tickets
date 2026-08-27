# Reusable Code - jiku-mail-connector

This document lists all reusable code available in this service. Each category has its own file with
detailed documentation.

Created by S-001 (bootstrap), extended by S-002 (typed configuration), S-003 (structured logging with
redaction) and S-004 (identity and the single bus connection). The service is a `worker` in Node.js
with no HTTP surface and no database, so several categories do not apply and stay empty until a story
creates them.

## Components

N/A (Backend service)

## Utils/Helpers

No utils/helpers documented yet.

## Middlewares

N/A (no HTTP surface - ADR-001)

## Services/Repositories

**Total: 7**

- **loadAppConfig()** (`src/config/index.ts`) - Resolves the single, validated configuration of the
  process: the Zod-validated environment composed with the bus settings the SDK's `loadConfig()`
  returns.
- **createLogger()** (`src/shared/logger.ts`) - Builds a Pino logger: JSON to stdout, level from the
  validated configuration, `pino-pretty` only in development, and `redact` wired. Its optional
  `destination` and `transportTarget` parameters are for tests.
- **initLogger() / getLogger()** (`src/shared/logger.ts`) - The process-wide logger singleton.
  Initialized once from `src/index.ts`; `getLogger()` throws a clear error if used before that.
- **buildServiceUser()** (`src/infra/bus/identity.ts`) - Builds the connector's identity from the
  machine-user key file, translating the SDK's four `fromKeyFile()` failure modes into a single
  `KeyLoadError` that names the path and never the contents. Makes no network call.
- **connectToBus()** (`src/infra/bus/connection.ts`) - Opens and retains the process's **single** bus
  connection. The only place that calls the SDK's `connect()`; registers `onTokenError` and turns any
  failure into a `BusConnectError` with a structural diagnosis.
- **reportTokenRefreshFailure()** (`src/infra/bus/connection.ts`) - Logs a failed background token
  refresh at `error` level and leaves the process alive.
- **closeBus()** (`src/infra/bus/connection.ts`) - Drains and closes the retained connection. Never use
  `await using` — it is a syntax error on Node 22.

See full details in [services.md](./services.md)

## Test Helpers

**Total: 5**

- **setupTestBus** (`test/bus/helpers.ts`) - Opens a NATS connection against the suite's shared
  container and builds a bus `Client` with `Client.fromConnection()`, returning a context with
  `cleanup()`.
- **createLogCapture** (`test/shared/log-capture.ts`) - In-memory `DestinationStream` for the logger,
  exposing the emitted lines both parsed (`lines()`) and raw (`raw()`) so a test can assert on the
  **serialized** line. Needed by S-004 and S-005 for their own diagnostic lines.
- **startAuthenticatedNats** (`test/bus/auth-helpers.ts`) - Starts a NATS container with `--auth`, so a
  wrong token yields a **real** `Authorization Violation`. Read its notes: it does **not** exercise the
  auth-callout, the `internal-app` role, or the real inbox prefix.
- **fakeTokenSource / rotatingTokenSource / failingTokenSource** (`test/bus/auth-helpers.ts`) -
  `TokenSource` doubles at the edge for the connection tests, since the real `ServiceUser` would call
  Zitadel.
- **generateServiceAccountKeyFile / writeRawKeyFile** (`test/bus/auth-helpers.ts`) - Writes a
  `ServiceAccountKey` JSON with a **real** RSA private key, plus its invalid variants.

See full details in [test-helpers.md](./test-helpers.md)

## Types

**Total: 8**

- **AppError** (`src/shared/errors/base.ts`) - Abstract base of the service's error hierarchy, with a
  public `code`, an `httpStatus` and optional non-sensitive `details`.
- **ConfigValidationError** (`src/config/errors.ts`) - Raised when the environment fails validation.
  Carries the complete list of offending variable names in `variables`.
- **AppConfig** (`src/config/index.ts`) - The process-wide configuration contract consumed by S-003,
  S-004 and S-005. Ten fields since S-003 added `nodeEnv`; five of them must never reach a log line.
- **TestBusContext** (`test/bus/helpers.ts`) - Return type of `setupTestBus()`: the NATS connection,
  the bus client, and a `cleanup()` that drains the connection.
- **KeyLoadError** (`src/infra/bus/errors.ts`) - The machine-user key could not be loaded. Names the
  path in its message and never the contents, at any level of the cause chain.
- **BusConnectError** (`src/infra/bus/errors.ts`) - The bus connection failed at startup. Exposes
  `diagnosis`, `sdkErrorClass` and `causes` as fields so the log point and the tests assert on
  structure, not on captured text.
- **ConnectDiagnosis** (`src/infra/bus/errors.ts`) - Which system rejected the connection, as a literal
  union. `'desconocido'` is legitimate and is never mapped to another value.
- **diagnoseConnectFailure() / causeChain()** (`src/infra/bus/errors.ts`) - Classify a connection
  failure by **structure**, never by the SDK's message text — the SDK's own regex misses a closed port.

See full details in [types.md](./types.md)

## Constants

**Total: 12**

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
- **RIGHT_TOKEN / WRONG_TOKEN** (`test/bus/auth-helpers.ts`) - The token the authenticated test
  container accepts, and one it rejects.
- **TEST_SUBJECT** (`test/bus/auth-helpers.ts`) - The `sub` the identity doubles declare,
  `'machine-user-abc'`.

See full details in [constants.md](./constants.md)

## Validators

**Total: 1**

- **envSchema** (`src/config/schema.ts`) - Zod shapes of the ten environment variables in scope, with
  their defaults and the timeout floor. The source of truth for the `Env` type. S-003 added `NODE_ENV`,
  defaulted to `production`.

See full details in [validators.md](./validators.md)
