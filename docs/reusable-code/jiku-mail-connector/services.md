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

---

## runStartup()

**Location:** `src/startup.ts`

**Description:** The startup sequence shared by both entry points: load configuration → build the
logger → log `configuracion valida` → build the identity → connect → log `conectado al bus`. Returns
the three things the caller needs to keep working.

**Signature:**

```ts
interface Startup {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly client: Client;
}

function runStartup(): Promise<Startup>;
```

**Usage:**

```ts
const { config, logger, client } = await runStartup();
```

**Notes:**

- Extracted by S-005 because the repo now has **two** processes that start the same way: the worker
  (`npm run start`) and the verification mode (`npm run verify`). Copying the sequence would produce
  two startups that diverge on the first change, and the one that would diverge silently is the one
  that is almost never run.
- Extracting it does **not** introduce a second connection: `connectToBus()` still retains the client
  and still has the counter that asserts one `connect()` per process (ADR-002).
- It does **not** publish anything, and must not: `start` publishing a command would leave a permanent
  requirement in Jiku on every restart (invariant 9, no compensating command). There is a property
  test that asserts `startup.ts` imports nothing from `#domain/publicacion/`.

---

## reportStartupFailure()

**Location:** `src/startup.ts`

**Description:** Reports a startup failure through the channel that matches the moment it happened.

**Signature:**

```ts
function reportStartupFailure(error: unknown): void;
```

**Notes:**

- `ConfigValidationError` goes to **stderr**, not through the logger, and the asymmetry is deliberate:
  step 1 (validation) fails **before the logger exists**. From step 2 onwards failures go through the
  logger with `fatal`.
- `KeyLoadError` and `BusConnectError` go through the logger, with a flat context carrying the
  diagnosis — which system refused — because the fixes live in different places.
- Extracted so the two entry points do not keep two copies of the same reporting logic.

---

## publishVerificationRequirement()

**Location:** `src/domain/publicacion/publish-requirement.ts`

**Description:** Publishes the fixed `requirements.new` payload, validates the reply, logs the success
line with `{ projectId, requirementId }` together, and translates any failure into a `PublishError`.
The first code in this repo that **writes** to Jiku.

**Signature:**

```ts
interface PublishVerificationRequirementDeps {
  readonly client: Client;
  readonly projectId: number;
  readonly logger: Logger;
}

function publishVerificationRequirement(
  deps: PublishVerificationRequirementDeps,
): Promise<{ requirementId: number }>;
```

**Usage:**

```ts
const { requirementId } = await publishVerificationRequirement({
  client,
  projectId: config.verifyProjectId,
  logger,
});
```

**Notes:**

- Dependencies arrive **by parameter**, not by importing a singleton: that is what lets a test inject
  the capture logger and the test client without touching process state — the same criterion as
  `connectToBus()`.
- Calls `client.command(COMMAND, payload)` with **two arguments, not three**. The third (`options`) is
  where the timeout would get lowered by accident, and ADR-006 forbids that explicitly. The `options`
  argument is used **only from tests**.
- The payload is validated **before** publishing. An invalid payload is not published: it would spend
  a round-trip for `core` to answer `invalid_fields` about something the connector already knew was
  wrong, and it would muddy the diagnosis (a refusal by shape means "the plane is open", and here it
  would prove nothing).
- **The reply is validated**, because `command<T>()` returns `reply.data` without checking it against
  `T`. A `core` answering `{ status: 'success', data: {} }` would produce the line CA-1 requires with
  `requirementId: undefined` — formally present, materially useless, and without anything failing.
- **No retry anywhere**: no `for`, no `while`, no backoff. Without idempotency and without a
  compensating command, a retry creates two requirements where there should have been one — and
  neither can be deleted.
- The `catch` translates and **rethrows** after logging: the verification mode must exit non-zero.
  Logging and returning a partial success would make the operator conclude the write plane is open
  when it is not.
- The log lives in this function, not in the entry point, so the line exists no matter who calls —
  which is what FG-3 inherits when the caller becomes the tick instead of the script.

---

## diagnosePublishFailure()

**Location:** `src/domain/publicacion/publish-errors.ts`

**Description:** Classifies a publication failure into the diagnosis of **which of the three systems
refused**: the bus by subject, `core` by role, or `core` by shape.

**Signature:**

```ts
function diagnosePublishFailure(error: unknown): PublishDiagnosis;
```

**Notes:**

- Discriminates by **SDK class** (`instanceof`) and by **error code** (`isCode`), never by the text of
  the message (ADR-002).
- **The order of the branches matters and is not interchangeable.** `JikuFailure` is evaluated before
  any generic `isJikuError` branch, and the code branches live inside it. Written the other way round,
  a `caller_not_authorized` would fall into `'desconocido'` and the most valuable diagnosis of the set
  — the only one that fixes itself by reconnecting — would be lost.
- **There is no exhaustive `switch` on codes**, and there must never be one: the SDK's catalog is not
  closed. `core` owns it and grows it. The SDK's own docs say *"Use `isCode`, never a `switch` with a
  `default` that assumes it has seen everything"*. An unrecognised code is a **normal, expected**
  outcome that maps to `'core_rechazo_desconocido'`.
- Codes come from the SDK's `ErrorCode` constant, never from hand-written string literals: a typo in a
  literal produces a silently wrong diagnosis.
- Returning `'desconocido'` is a legitimate result and is never mapped to something else. A wrong
  diagnosis is worse than an absent one: it sends the operator to the wrong system.

---

## hintOf() / codeOf() / coreMessageOf()

**Location:** `src/domain/publicacion/publish-errors.ts`

**Description:** Safe accessors for what `core` sent with a failure.

**Signature:**

```ts
function hintOf(error: unknown): string | undefined;
function codeOf(error: unknown): string | undefined;
function coreMessageOf(error: unknown): string | undefined;
```

**Notes:**

- **`hintOf()` exists because of a verified SDK finding, and this is the entry most likely to be
  "simplified" into a bug.** `hint()` is declared **only on `JikuFailure`**. `JikuTimeout`,
  `JikuNoEndpoint`, `JikuPermissionDenied` and `JikuInvalidRequest` extend `JikuError`, which does not
  declare it — calling `error.hint()` on any of them is a **`TypeError`**, and it would happen at the
  worst possible moment: when the connector is already failing and the log is all that is left.
- It is a **function and not an inline access** so that there is exactly **one** place where the
  decision to call `hint()` is made. An `error instanceof JikuFailure ? error.hint() : undefined`
  repeated in two log points is how the third one gets written without the guard. A property test
  asserts there is exactly one `.hint()` call site in `src/`.
- `hint()` legitimately returns `undefined` for **`project_not_found`** and for **every unknown code**
  — the SDK's hint catalog does not cover them and its `default` returns `undefined`. Those are exactly
  the two cases CA-9 and CA-13 ask to log "with its `hint()`". The honest thing is to **omit** the
  field; what travels instead is `code` + `errorMessage`, and that is the real diagnostic data there.
  **Do not invent text to paper over the absence.**

---

## withMailSource()

**Location:** `src/infra/imap/client.ts`

**Description:** Opens ONE IMAP connection (TLS and `logger: false` unconditional), takes the
`INBOX` lock, builds a `MailSource` bound to that single client, invokes the caller's callback with
it, and closes the lock/connection in a `finally` — regardless of success or failure. The whole
cycle (`searchUnseen` → N × `fetch`/`markSeen`) shares one connection; it is not opened and closed
per operation.

**Signature:**

```ts
interface WithMailSourceOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  /** Test-only: defaults to the real `ImapFlow`. */
  readonly imapFlowCtor?: ImapFlowCtor;
}

function withMailSource<T>(
  options: WithMailSourceOptions,
  callback: (source: MailSource) => Promise<T>,
): Promise<T>;
```

**Usage example:**

```ts
const uids = await withMailSource({ config, logger }, async (source) => {
  const unseen = await source.searchUnseen();
  for (const uid of unseen) {
    const message = await source.fetch(uid);
    // ... normalize + publish ...
    await source.markSeen(message.uid);
  }
  return unseen;
});
```

**Notes:**

- `imapFlowCtor` is a **function**, not a `new`-able class — same pattern as
  `createLogger(config, destination, transportTarget)`: tests inject a plain factory function
  returning a double, never mocking the `imapflow` module globally.
- `secure: true` and `logger: false` are literal, unconditional — never derived from `config` or an
  env var (verified by a source-scan property test, not just by reading the code).
- `INBOX` is the module constant `'INBOX'`, never a configurable value.
- `search()` and `messageFlagsAdd()` are called with `{ uid: true }` explicitly: without it,
  `imapflow` interprets the range as sequence numbers, not UIDs, which would silently break
  `fetch`/`markSeen` on the UIDs `searchUnseen()` returned.
- A connect failure is translated to `ImapConnectError` (see types.md) — never the raw `imapflow`
  error, so the password/user never leak through message text.
- Does not apply `maxPerTick` and does not know about it: the cap belongs to the tick (S-010), not
  to this adapter.

---

## runTick()

**Location:** `src/domain/ingesta/tick.ts`

**Description:** The tick's inner loop: applies the cap (`config.poll.maxPerTick`), processes the
batch in strict UID-descending order and sequentially (`for...of`, never `Promise.all`), marks
`\Seen` one at a time immediately after each successful download (before normalizing), isolates
any per-message failure without aborting the batch, and always emits the five counters — even if
`searchUnseen()` itself throws — because `TickCounters` lives outside the `try` and the emission is
in the `finally`. Receives an already-open `MailSource` (S-009); does not construct one.

**Signature:**

```ts
interface TickCounters {
  ingestados: number;
  parseados: number;
  creados: number;
  descartados: number;
  fallidos: number;
}

function runTick(
  mailSource: MailSource,
  config: AppConfig,
  logger: Logger,
  normalize?: typeof normalizeMail, // test-only, defaults to the real normalize()
): Promise<void>;
```

**Usage example:**

```ts
await withMailSource({ config, logger }, (mailSource) => runTick(mailSource, config, logger));
```

**Notes:**

- `normalize` is inject­able **only** for tests: `mailparser` is tolerant of malformed bytes (it
  never throws, it just produces `messageId: undefined`, which is already the
  `MissingMessageIdError` path) — there is no real `.eml` fixture that forces a genuine parse
  failure distinct from "no Message-Id". Same pattern as `imapFlowCtor` in `infra/imap/client.ts`.
- `creados`/`descartados` are literal `0` until FG-3: this story does not distinguish
  `MissingMessageIdError` from any other `normalize()` failure — both count as `fallidos`.
- A mail that fails to download is skipped with `warn` and never marked `\Seen` (retried next
  tick). A mail that downloads but fails to normalize stays `\Seen` and is lost — no compensation.
- The normalized `IncomingMail` is discarded immediately after logging its result: never
  accumulated in an array, never published (this story's pipeline ends at normalization).

---

## runIngestaTick()

**Location:** `src/domain/ingesta/tick.ts`

**Description:** The `ingesta` module's entry point: composes `withMailSource()` (S-009) with
`runTick()` (above). If `withMailSource` throws **before** invoking the callback (e.g.
`connect()`/`getMailboxLock()` failed), `runTick` never ran and its `finally` never emitted
anything — so this function emits the metrics line itself, with all five counters at zero, and
logs the failure at `error` level without ever leaking the password or user. The distinction
between "the callback started" and "it never did" is a closure flag set right before invoking
`runTick`, not a check on the exception's type — an `instanceof ImapConnectError` check would miss
a `getMailboxLock()` failure, which does not raise that class. Never rethrows in a way that would
kill the process: the worker stays alive and retries on the next cron tick.

**Signature:**

```ts
function runIngestaTick(config: AppConfig, logger: Logger, imapFlowCtor?: ImapFlowCtor): Promise<void>;
```

**Usage example:**

```ts
await runIngestaTick(config, logger); // production; a scheduler (S-011) invokes this per cron tick
```

**Notes:**

- `imapFlowCtor` is test-only, forwarded straight to `withMailSource` — lets a test simulate a
  connect/lock failure without touching real IMAP.
- Never emits the metrics line twice: if `runTick`'s callback did start, its own `finally` already
  emitted the (possibly partial) counters, and this function's `catch` skips its own emission.

---
