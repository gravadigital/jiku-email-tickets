# Types - jiku-mail-connector

## AppError

**Location:** `src/shared/errors/base.ts`

**Description:** Abstract base of the service's error hierarchy. Domain code never throws
`new Error(...)`; it throws a subclass that declares a `code` — part of the public contract, so
changing one is a breaking change. Neither `message` nor `details` may carry sensitive information.

**Interface:**

```ts
abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>);
}
```

**Usage example:**

```ts
import { AppError } from '#shared/errors/index.js';

export class SomeFailure extends AppError {
  readonly code = 'SOME_FAILURE';
  readonly httpStatus = 500;
}
```

**Notes:** `httpStatus` is declared even though the service exposes no HTTP surface (ADR-001), to
avoid diverging from the `error-handling` convention. Its value is not consumed anywhere.

---

## ConfigValidationError

**Location:** `src/config/errors.ts`

**Description:** Raised when the environment fails validation at startup. Its `message` is a single
multiline string naming every offending variable and what was expected of each — never a value.
`variables` exposes the same names as data, so tests assert on structure instead of on captured
stdout.

**Interface:**

```ts
class ConfigValidationError extends AppError {
  readonly code = 'CONFIG_VALIDATION_ERROR';
  readonly httpStatus = 500;
  readonly variables: string[];   // sorted, deduplicated
}

function toConfigValidationError(issues: readonly ValidationIssueLike[]): ConfigValidationError;
```

**Usage example:**

```ts
import { ConfigValidationError } from '#config/errors.js';

main().catch((error: unknown) => {
  if (error instanceof ConfigValidationError) process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
```

**Notes:** `toConfigValidationError` reads **only** `issue.path` and derives each description from a
module-local map. The Zod `message` is never interpolated, so no value can reach the output even if a
future Zod version starts including the offending input in the issue.

---

## AppConfig

**Location:** `src/config/index.ts`

**Description:** The process-wide configuration contract: the validated environment composed with the
bus settings the SDK resolves. Consumed by S-003 (logger), S-004 (bus adapter) and S-005 (publishing).

**Interface:**

```ts
interface AppConfig {
  servers: string;
  instance: string;
  credsFile: string;
  keyFile: string;
  zitadelProjectId: string;
  issuer: string;
  timeoutMs: number;
  verifyProjectId: number;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
}
```

**Notes:** Written by hand on purpose, and that does not contradict the "types are inferred" rule:
`Env` is inferred from the schema, while `AppConfig` *composes* `Env` with the SDK's `LoadedConfig`.
It is the contract three later stories consume, so an inferred type that changed silently would break
their tests. `credsFile` and `keyFile` are **paths** to read-only mounted files, never contents.

---

## TestBusContext

**Location:** `test/bus/helpers.ts`

**Description:** Return type of `setupTestBus()`. Declared explicitly rather than inferred, because
S-004 and S-005 consume this helper and a silently changing inferred type would break their tests.

**Interface:**

```ts
type TestBusContext = {
  connection: NatsConnection;
  client: Client;
  cleanup: () => Promise<void>;
};
```

**Usage example:**

```ts
import { setupTestBus, type TestBusContext } from './helpers.js';

let bus: TestBusContext;
bus = await setupTestBus(inject('natsUrl'));
```
