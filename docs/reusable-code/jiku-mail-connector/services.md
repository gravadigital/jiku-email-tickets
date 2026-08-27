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

---

## buildServiceUser()

**Location:** `src/infra/bus/identity.ts`

**Description:** Builds the connector's identity from the machine-user key file that Zitadel produced,
wrapping the SDK's `ServiceUser.fromKeyFile()` and translating its four failure modes into a single
`KeyLoadError`. Reads no environment and calls no logger: everything arrives by parameter.

**Signature:**

```ts
function buildServiceUser(config: AppConfig): Promise<ServiceUser>;
```

**Usage example:**

```ts
// src/index.ts — after initLogger(), before connecting
const auth = await buildServiceUser(config);

// The user-id that goes in every subject, derived from the key and never from the environment:
auth.userId;              // synchronous, no network call
await auth.subject();      // the same value
```

**Notes:**

- **Makes no network call.** `userId` and `subject()` come straight from the key file, so the identity
  is available before any token exists. Verified with an unreachable issuer.
- **Four failure modes, not two.** `ServiceUser` validates in its **constructor** — it reads, parses,
  checks the shape and loads the private key — so a missing file, malformed JSON, a JSON that is not a
  machine-user key, and a `key` that OpenSSL cannot read all surface through this one call. All four
  become `KeyLoadError` with the SDK's `JikuError` intact in `cause`.
- **The SDK's message is chained by `cause`, never interpolated into ours.** That is what keeps the
  "never dumps the key contents" guarantee **structural** instead of dependent on the SDK continuing
  to behave well.
- **Do not pass `scopes`.** The SDK's default is `['openid', 'profile']` and `profile` is mandatory:
  without it the auth-callout's event carries no name, `core` discards it, the connector's `users` row
  is never created, and every later request fails with `caller_not_authorized` — three services away
  from the cause.

---

## connectToBus()

**Location:** `src/infra/bus/connection.ts`

**Description:** Opens the process's **single** bus connection and retains it for the lifetime of the
process. The only place in the codebase that calls the SDK's `connect()`, asserted by a source scan.
Registers `onTokenError` and translates any connection failure into a `BusConnectError` carrying a
structural diagnosis.

**Signature:**

```ts
interface ConnectToBusOptions {
  readonly config: AppConfig;
  readonly auth: TokenSource;
  readonly logger: Logger;
  readonly creds?: string | null | undefined;   // tests only
}

function connectToBus(options: ConnectToBusOptions): Promise<Client>;
function connectInvocationCount(): number;      // tests only
function resetBusForTests(): void;              // tests only
```

**Usage example:**

```ts
const client = await connectToBus({ config, auth, logger });

logger.info(
  { instance: client.instance, userId: client.userId, inboxPrefix: client.inboxPrefix },
  'conectado al bus',
);
```

**Notes:**

- **One connection per process, never one per operation.** Connecting costs a round trip to Zitadel
  plus the handshake that runs the auth-callout. The SDK says the same of its `Client`: *"should be
  long-lived: one per process, not one per request"*.
- **A second call does not open a second connection**: it returns the retained client and logs a
  `warn`. Returning rather than throwing keeps the invariant that matters while still leaving a trace
  to fix the caller — throwing would turn a wiring slip into a crash at an arbitrary point.
- **`userId` and `inboxPrefix` are never passed.** The SDK derives the first from the token's `sub`
  (*"LEAVE IT UNSET"*) and always sets the second to `_INBOX.<hash(sub)>`. Any other inbox prefix makes
  replies land where nobody listens and the request time out **with no visible error**.
- **`credsFile` goes as a path, not as contents** — the SDK reads it at connect time, so that byte
  never needs to be in the connector's memory. The `creds` option is for tests pointing at a plain NATS.
- Registering `onTokenError` also closes a redaction hole: its documented default is a `console.warn`,
  which is **outside Pino and therefore not redacted**.
- **It asks for the token itself before calling `connect()`**, which is not duplicated work (the SDK
  caches it) but the only way to attribute a token failure **positively**. Left to fail inside
  `connect()`, that error is structurally indistinguishable from an unclassifiable one, and
  attributing it by elimination would turn every unknown connection failure into "check Zitadel".
- `capturedConnectOptions()` is a **diagnostic seam for tests**, not a mock: a missing `onTokenError`
  key, or a stray `userId`, has no other observable symptom — the SDK would silently fall back to its
  unredacted default.

---

## reportTokenRefreshFailure()

**Location:** `src/infra/bus/connection.ts`

**Description:** The `onTokenError` callback's body: logs a failed background token refresh at `error`
level with its diagnosis, the SDK error class and the cause chain — and leaves the process alive.

**Signature:**

```ts
function reportTokenRefreshFailure(logger: Logger, error: unknown): void;
```

**Notes:**

- **Never terminates the process.** A failure **at startup** is fatal; a failure of the background
  refresh is not. The live token keeps working and what breaks is the next reconnect (NFR-R04).
- The log context is **flat, one level deep**, because S-003's redaction has no deep wildcard: a
  three-level context would leave a secret in the clear without failing or warning.

---

## closeBus()

**Location:** `src/infra/bus/connection.ts`

**Description:** Drains and closes the retained connection, clearing it so a later call can reconnect.

**Signature:**

```ts
function closeBus(): Promise<void>;
```

**Notes:**

- Uses `client.close()`, which **drains** — in-flight replies are delivered before the socket goes away.
- **Never use `await using`.** `Symbol.asyncDispose` exists on the `Client`, but the syntax needs Node
  24 and is a **syntax error** on Node 22, this service's runtime.
- Production does not call it in this scope: the process stays alive with the connection open and S-005
  inherits it. It exists for tests and for the ordered shutdown that arrives with FG-2's tick.
