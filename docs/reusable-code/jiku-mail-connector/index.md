# Reusable Code - jiku-mail-connector

This document lists all reusable code available in this service. Each category has its own file with
detailed documentation.

Created by S-001 (bootstrap), extended by S-002 (typed configuration). The service is a `worker` in
Node.js with no HTTP surface and no database, so several categories do not apply and stay empty until
a story creates them.

## Components

N/A (Backend service)

## Utils/Helpers

No utils/helpers documented yet.

## Middlewares

N/A (no HTTP surface - ADR-001)

## Services/Repositories

**Total: 1**

- **loadAppConfig()** (`src/config/index.ts`) - Resolves the single, validated configuration of the
  process: the Zod-validated environment composed with the bus settings the SDK's `loadConfig()`
  returns.

See full details in [services.md](./services.md)

## Test Helpers

**Total: 1**

- **setupTestBus** (`test/bus/helpers.ts`) - Opens a NATS connection against the suite's shared
  container and builds a bus `Client` with `Client.fromConnection()`, returning a context with
  `cleanup()`.

See full details in [test-helpers.md](./test-helpers.md)

## Types

**Total: 4**

- **AppError** (`src/shared/errors/base.ts`) - Abstract base of the service's error hierarchy, with a
  public `code`, an `httpStatus` and optional non-sensitive `details`.
- **ConfigValidationError** (`src/config/errors.ts`) - Raised when the environment fails validation.
  Carries the complete list of offending variable names in `variables`.
- **AppConfig** (`src/config/index.ts`) - The process-wide configuration contract consumed by S-003,
  S-004 and S-005.
- **TestBusContext** (`test/bus/helpers.ts`) - Return type of `setupTestBus()`: the NATS connection,
  the bus client, and a `cleanup()` that drains the connection.

See full details in [types.md](./types.md)

## Constants

**Total: 6**

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

See full details in [constants.md](./constants.md)

## Validators

**Total: 1**

- **envSchema** (`src/config/schema.ts`) - Zod shapes of the nine environment variables in scope, with
  their defaults and the timeout floor. The source of truth for the `Env` type.

See full details in [validators.md](./validators.md)
