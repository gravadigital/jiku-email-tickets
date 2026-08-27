# Services - jiku-mail-connector

## loadAppConfig()

**Location:** `src/config/index.ts`

**Description:** Resolves the single configuration of the process. It validates the environment
against the Zod schema first, then reads the bus settings with the SDK's `loadConfig()`, and composes
both into one `AppConfig`. This is the only place in the service that calls the SDK's `loadConfig()`,
which is what lets the "one place reads the environment" property hold while still not duplicating any
SDK default.

**Signature:**

```ts
function loadAppConfig(): Promise<AppConfig>;
```

**Usage example:**

```ts
import { loadAppConfig } from '#config/index.js';

const config = await loadAppConfig();   // throws ConfigValidationError if the environment is short
```

**Notes:**

- **The order is intentional.** The environment is validated *before* `loadConfig()` runs, because
  `loadConfig()` reads the filesystem looking for `~/.config/jiku/config.yaml` and can throw on a
  malformed file. An incomplete environment must fail without attempting anything first.
- **Precedence per value.** `credsFile`, `keyFile`, `zitadelProjectId` and `instance` come from the
  SDK (it expands `~` in paths and already defaults `instance` to `dev`). `servers`, `issuer`,
  `timeoutMs`, `verifyProjectId` and `logLevel` come from the schema, because the SDK either does not
  default them or does so only at `connect()`.
- Throws `ConfigValidationError` with the complete list of offending variables — never a partial one,
  and never a value.

---

## createLogger()

**Location:** `src/shared/logger.ts`

**Description:** Builds a Pino logger for the connector: JSON to stdout, the level taken from the
validated configuration, `pino-pretty` only when `nodeEnv === 'development'`, and `redact` wired to
`REDACT_PATHS` / `REDACT_CENSOR`. It reads nothing from the environment — everything arrives through
the `AppConfig` parameter, which is what keeps `src/config/env.ts` the single reader of `process.env`.

**Production code should not call this directly.** It uses the singleton (`initLogger` / `getLogger`).

**Signature:**

```ts
function createLogger(
  config: AppConfig,
  destination?: pino.DestinationStream,
  transportTarget?: string,
): pino.Logger;
```

**Usage example:**

```ts
// In a test, asserting on the serialized line:
import { createLogger } from '#shared/logger.js';

import { createLogCapture } from './log-capture.js';

const capture = createLogCapture();
const logger = createLogger(config, capture.stream);

logger.info({ accessToken: 'eyJ...' }, 'token minted');

expect(capture.lines()[0]?.['accessToken']).toBe('[REDACTED]');
```

**Notes:**

- **`destination` is FOR TESTS.** It exists so a test can assert on the serialized line without
  intercepting `process.stdout`, which with `fileParallelism: false` would contaminate the rest of the
  suite. Production passes nothing and Pino writes to stdout (fd 1).
- **`transportTarget` is FOR TESTS too**, and only for one scenario: the degradation path. With
  `pino-pretty` installed as a devDependency the real target always resolves, so without this
  parameter the `catch` would have no automated coverage. The default is the real target.
- **Verified against `pino@10.3.1`: passing `transport` AND a `destination` does not throw, but the
  transport wins and the destination receives nothing.** A test injecting a sink would read empty and
  pass green. That is why the transport is built without the destination.
- **It never configures a file transport, in any environment** (ADR-006). The precedent is concrete:
  Jiku's two backends have their file transports with `filename: undefined` in production and their
  logs have not existed since, without anyone noticing.
- If the development transport fails to resolve — the real scenario of a production image running with
  `NODE_ENV=development` — it degrades to JSON on stdout instead of throwing, and **logs a `warn`
  saying why**. A worker with no logs is undiagnosable, and a silent fallback is how a diagnostic gets
  lost.

---

## initLogger() / getLogger()

**Location:** `src/shared/logger.ts`

**Description:** The process-wide logger singleton. `initLogger(config)` builds it once — called from
`src/index.ts` as soon as the configuration validates, and nowhere else. `getLogger()` returns it and
**throws a clear error if used before initialization**.

**Signature:**

```ts
function initLogger(config: AppConfig): pino.Logger;
function getLogger(): pino.Logger;
function resetLoggerForTests(): void;
```

**Usage example:**

```ts
// src/index.ts — the only initialization point
const config = await loadAppConfig();
const logger = initLogger(config);

logger.info({ instance: config.instance }, 'configuracion valida');

// Anywhere else
import { getLogger } from '#shared/logger.js';

getLogger().warn({ messageId }, 'mail descartado');
```

**Notes:**

- **Explicit initialization, not lazy construction on import.** `AppConfig` resolves asynchronously,
  so building the singleton at import time would force the configuration load to become a side effect
  of importing the module — breaking S-002's property that importing `#config/index.js` validates
  nothing on its own.
- **`getLogger()` fails loudly rather than degrading.** In a service whose only edge is the log,
  falling back to a silent logger — or worse, one with default options and therefore **no `redact`** —
  would be worse than failing. A logger without `redact` is exactly the failure mode S-003 exists to
  close.
- A second `initLogger()` call does **not** replace the instance: one instance, and every module
  derives from it (`logger.child()`).
- `resetLoggerForTests()` is only for tests, so one case can discard the singleton another built.
