# Reusable Code - jiku-mail-connector

This document lists all reusable code available in this service. Each category has its own file with
detailed documentation.

Created by S-001 (bootstrap). The service is a `worker` in Node.js with no HTTP surface and no
database, so several categories do not apply and stay empty until a story creates them.

## Components

N/A (Backend service)

## Utils/Helpers

No utils/helpers documented yet.

## Middlewares

N/A (no HTTP surface - ADR-001)

## Services/Repositories

No services documented yet.

## Test Helpers

**Total: 1**

- **setupTestBus** (`test/bus/helpers.ts`) - Opens a NATS connection against the suite's shared
  container and builds a bus `Client` with `Client.fromConnection()`, returning a context with
  `cleanup()`.

See full details in [test-helpers.md](./test-helpers.md)

## Types

**Total: 1**

- **TestBusContext** (`test/bus/helpers.ts`) - Return type of `setupTestBus()`: the NATS connection,
  the bus client, and a `cleanup()` that drains the connection.

See full details in [types.md](./types.md)

## Constants

**Total: 3**

- **SERVICE_NAME** (`src/shared/service-info.ts`) - The service name, used wherever the process has to
  identify itself.
- **TEST_USER_ID** (`test/bus/helpers.ts`) - Fixed caller identity used by the test bus context.
- **TEST_INSTANCE** (`test/bus/helpers.ts`) - Bus instance name used by the test bus context.

See full details in [constants.md](./constants.md)

## Validators

No validators documented yet.
