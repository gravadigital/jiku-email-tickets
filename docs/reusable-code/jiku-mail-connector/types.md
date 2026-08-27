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
  nodeEnv: 'development' | 'test' | 'production';
}
```

**Notes:** Written by hand on purpose, and that does not contradict the "types are inferred" rule:
`Env` is inferred from the schema, while `AppConfig` *composes* `Env` with the SDK's `LoadedConfig`.
It is the contract three later stories consume, so an inferred type that changed silently would break
their tests. `credsFile` and `keyFile` are **paths** to read-only mounted files, never contents.

`nodeEnv` was added by S-003 and its default is **`production`**, not `development`: the logger uses
it to pick the format, and the expensive pretty mode must be asked for explicitly rather than obtained
by omission. `logLevel` and `nodeEnv` are the two fields the logger consumes; it receives them as
parameters because it must not read `process.env` itself.

**Five of the ten fields must never reach a log line:** `credsFile` and `keyFile` (paths to secrets —
where a secret lives is information about the secret), plus `zitadelProjectId` and `servers`
(deployment topology). The startup line in `src/index.ts` deliberately carries only `instance`,
`logLevel` and `timeoutMs`.

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

---

## KeyLoadError

**Location:** `src/infra/bus/errors.ts`

**Description:** The machine-user key could not be loaded. Collapses the SDK's four `fromKeyFile()`
failure modes into one error, because all four have the same fix — check the mounted file — while the
exact cause travels intact in `cause`.

**Interface:**

```ts
class KeyLoadError extends AppError {
  readonly code = 'BUS_KEY_LOAD_ERROR';
  readonly httpStatus = 500;
}
```

**Notes:**

- The **path** goes in the message, which is what the operator reads to fix the deployment. It does
  **not** go in `details`, because `details` ends up in the structured log context and a path to a
  secret is information about that secret (ADR-006).
- Never contains the file's contents at any level of the chain — asserted by a test using a sentinel
  value, because what the SDK does not leak today it could leak in a minor.

---

## BusConnectError

**Location:** `src/infra/bus/errors.ts`

**Description:** The bus connection failed at startup. Exposes the diagnosis, the SDK error class and
the cause-chain messages as **fields**, not only inside the message — the same shape as
`ConfigValidationError` with its `variables`, so the log point and the tests assert on structure
instead of on captured text.

**Interface:**

```ts
class BusConnectError extends AppError {
  readonly code = 'BUS_CONNECT_ERROR';
  readonly httpStatus = 500;
  readonly diagnosis: ConnectDiagnosis;
  readonly sdkErrorClass: string;
  readonly causes: string[];
}
```

**Notes:**

- `sdkErrorClass` comes from `constructor.name`, not from an `instanceof` per class: it is for the log
  and does not depend on constructor identity across duplicate copies of the package.
- `causes` keeps the SDK's own messages, which already spell out the likely causes. Dropping them on
  wrapping would throw away the best available diagnosis.

---

## ConnectDiagnosis

**Location:** `src/infra/bus/errors.ts`

**Description:** Which system rejected the connection. A literal union rather than loose strings, so a
`switch` at the log point is exhaustive for the typechecker.

**Interface:**

```ts
type ConnectDiagnosis =
  | 'key_ilegible'
  | 'zitadel_no_entrego_token'
  | 'rechazo_del_bus_por_subject'
  | 'bus_inalcanzable'
  | 'creds_ilegible'
  | 'refresh_del_token_fallo'
  | 'desconocido';
```

**Notes:**

- Each value names a **different system and a different fix**. That is the whole point (ADR-006): a log
  that says only "could not connect" forces checking Zitadel, the network, and both file mounts at once.
- `'desconocido'` is a legitimate result and is **never mapped to another one**. A wrong diagnosis is
  worse than an absent one: it sends the operator to the wrong system.

---

## diagnoseConnectFailure() / causeChain()

**Location:** `src/infra/bus/errors.ts`

**Signature:**

```ts
function diagnoseConnectFailure(error: unknown): ConnectDiagnosis;
function causeChain(error: unknown): Error[];
```

**Notes:**

- **Classifies by structure, never by the SDK's message text.** The SDK's own regex is
  `/no servers available|CONNECTION_REFUSED|ECONNREFUSED|ENOTFOUND/i`, but `@nats-io/transport-node`
  reports a closed port as `"connection refused"` — lowercase, with a space — which matches none of
  them. Verified: a closed port lands in the SDK's **generic** branch while an unresolvable host lands
  in the specific one, and both are "unreachable bus" to the connector. Reading the text would make a
  closed port undiagnosable — or worse, send the operator to Zitadel for a network problem.
- What it reads instead: `isJikuError()`, the transport error's `name`, and the `errno` `code`s along
  the cause chain. Structured data, not prose.
- `causeChain()` walks with **both** a depth cap and a visited set: a cyclic `cause` would otherwise
  hang the startup at the one moment the process still has no logger to explain itself.
- **The terminal branch returns `'desconocido'`, never a guess.** Closing it with
  `'zitadel_no_entrego_token'` by elimination is tempting and wrong: a `TokenSource` can throw
  anything, so there is no positive structural signal for it. The token failure is recognised
  elsewhere — `connectToBus()` asks for the token *before* `connect()`, so its failure is attributed
  by the call that produced it rather than by what is left over.
