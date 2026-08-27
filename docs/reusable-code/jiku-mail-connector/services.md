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
