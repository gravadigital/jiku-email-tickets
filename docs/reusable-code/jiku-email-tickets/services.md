# Services - jiku-email-tickets

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

## publishRequirementFromMail()

**Location:** `src/domain/publicacion/publish-requirement.ts`

**Description:** Sibling of `publishVerificationRequirement()`: publishes the `requirements.new`
payload derived from an incoming mail (via `buildRequirementPayload()`), validates the reply, and
logs success or failure with the mail's `messageId` added to the log context. The alta path the tick
uses once a mail resolves to a project.

**Signature:**

```ts
interface PublishRequirementFromMailDeps {
  readonly client: Client;
  readonly logger: Logger;
}

function publishRequirementFromMail(
  mail: Pick<IncomingMail, 'messageId' | 'subject' | 'body'>,
  projectId: number,
  ruteoConfig: Pick<RuteoConfig, 'placeholderTitle' | 'placeholderBody'>,
  deps: PublishRequirementFromMailDeps,
  fileIds?: readonly number[], // default [] — S-021
  description?: string, // S-021 — already-composed description; falls back to mail.body if omitted
  archivosConAviso?: number, // default 0 — S-021 — summed into the success log line
): Promise<{ requirementId: number }>;
```

**Usage:**

```ts
const { requirementId } = await publishRequirementFromMail(
  mail,
  route.projectId,
  config.ruteo,
  { client, logger },
  adjuntos.fileIds,
  description, // already composed with componerDescripcion()
  adjuntos.avisosDeRechazo.length + adjuntos.avisosDeFallo.length,
);
```

**Notes:**

- Shares the same `client.command()` mechanics as `publishVerificationRequirement()` — same
  `COMMAND` constant, same two-argument call, same 15000 ms timeout — and reuses
  `diagnosePublishFailure()`/`PublishError`/`newRequirementReplySchema` without modification.
- The only observable difference from its sibling: the payload comes from
  `buildRequirementPayload()` instead of a fixed literal, and `messageId` is added to **both** the
  success and the error log objects — never inside `logContext()`, which stays shared with the
  verification path.
- Rethrows on failure and never retries; the caller (the tick) decides what to count and whether to
  continue the batch.
- **Since S-021:** `fileIds`, `description` and `archivosConAviso` are all optional, backward
  compatible with any caller that doesn't pass attachments (defaults produce the exact pre-S-021
  behavior). The success log line always includes `archivosVinculados` (= `fileIds.length`) and
  `archivosConAviso`, even when both are `0` — same single line, never a second one. The failure log
  is untouched: an orphaned upload (files already sent, `requirements.new` failing afterward) gets no
  extra log beyond the existing `PublishError` line — there is no compensating command and no list of
  abandoned `fileIds` anywhere in this service (ADR-003 consequence).

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
in the `finally`. Receives an already-open `MailSource` (S-009); does not construct one. Since
S-015, a mail that `routeMail()` resolves is also published via `publishRequirementFromMail()`
**within the same loop iteration** — never accumulated in an array first — and its outcome feeds
`creados`/`fallidos`.

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
  client: Client, // the connected bus client; publishes requirements.new for resolved mails
  space: KvSpace, // S-032: the KV Space (Ticket Map + Thread Map), opened once by openKvSpace()
  normalize?: typeof normalizeMail, // test-only, defaults to the real normalize()
): Promise<void>;
```

**Usage example:**

```ts
await withMailSource({ config, logger }, (mailSource) => runTick(mailSource, config, logger, client, space));
```

**Notes:**

- `normalize` is inject­able **only** for tests: `mailparser` is tolerant of malformed bytes (it
  never throws, it just produces `messageId: undefined`, which is already the
  `MissingMessageIdError` path) — there is no real `.eml` fixture that forces a genuine parse
  failure distinct from "no Message-Id". Same pattern as `imapFlowCtor` in `infra/imap/client.ts`.
- A mail that fails to download is skipped with `warn` and never marked `\Seen` (retried next
  tick). A mail that downloads but fails to normalize stays `\Seen` and is lost — no compensation.
- A mail that is discarded never reaches publication: `descartados` covers every discard reason
  (`sin_slug` from `routeMail()`, `slug_no_mapeado`/`slug_no_consultable` from `lookupTicket()`,
  `es_respuesta`/`hilo_desconocido` from `lookupThread()`, and `MissingMessageIdError`), completely
  separate from `creados`/`fallidos`, which only count a publication attempt's outcome.
- Since S-032 the `intencion: 'alta'` branch calls `lookupTicket()` **before**
  `procesarAdjuntosDelMail()`: one `get()` per new mail with a slug, no cache.
- A publication failure (`PublishError`, already logged inside `publishRequirementFromMail()`) is
  caught locally: it increments `fallidos` and lets the loop continue with the next UID — it is
  never rethrown, never retried, and never re-logged by the tick itself.

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
function runIngestaTick(
  config: AppConfig,
  logger: Logger,
  client: Client,
  space: KvSpace,
  imapFlowCtor?: ImapFlowCtor,
): Promise<void>;
```

**Usage example:**

```ts
await runIngestaTick(config, logger, client, space); // production; a scheduler (S-011) invokes this per cron tick
```

**Notes:**

- `imapFlowCtor` is test-only, forwarded straight to `withMailSource` — lets a test simulate a
  connect/lock failure without touching real IMAP.
- Never emits the metrics line twice: if `runTick`'s callback did start, its own `finally` already
  emitted the (possibly partial) counters, and this function's `catch` skips its own emission.

---

## triggerTick()

**Location:** `src/domain/ingesta/scheduler.ts`

**Description:** The no-overlap guard (S-011) — the riskiest piece of the whole feature group. If
`tickInFlight` is `true`, logs `warn` with the literal message `'tick salteado: hay uno en curso'`
and returns without invoking the tick — the skipped trigger is **never** enqueued, it is lost; the
next cron trigger is the only next opportunity. If `false`, marks the flag `true`, invokes the
injected tick function, and releases the flag in a `finally` — **always**, whether the tick
resolves or throws. A flag that never releases stops ingestion forever, silently, in a worker with
no healthcheck (ADR-006): there is no symptom.

Deliberately does **not** use `node-cron`'s own `noOverlap` option: the module-level boolean has to
be explicit and visible in this module's code, not hidden behind a library option, and `noOverlap`
does not expose the same log point CA-5 requires verbatim.

**Signature:**

```ts
function triggerTick(
  config: AppConfig,
  logger: Logger,
  client: Client,
  space: KvSpace,
  runTick?: (config: AppConfig, logger: Logger, client: Client, space: KvSpace) => Promise<void>, // defaults to runIngestaTick
): Promise<void>;
```

**Usage example:**

```ts
// production, invoked once per cron.schedule() callback:
cron.schedule(config.poll.cron, () => triggerTick(config, logger, client, space));

// test, injecting a controllable double instead of the real tick:
await triggerTick(config, logger, client, space, fakeTick);
```

**Notes:**

- Never rethrows the tick function's exception in a way that would kill the process or the cron —
  logs it at `error` and moves on. In production this never triggers: `runIngestaTick` (S-010)
  already absorbs its own failures.
- The in-flight promise is tracked in a module-level variable so `waitForCurrentTick()` (below) can
  await it from the ordered shutdown path.
- No test of this function waits on `node-cron`'s real clock (CA-13): the guard is invoked directly
  with an injected tick double whose promise the test controls manually.

---

## waitForCurrentTick()

**Location:** `src/domain/ingesta/scheduler.ts`

**Description:** Returns a promise that resolves when the in-flight tick (if any) finishes, or
immediately if none is running. Does not distinguish "never ran one" from "the last one already
finished" — both resolve immediately. This is what makes the ordered shutdown possible without
depending on `cron.stop()` to wait for anything — verified against `node-cron`'s types: in
in-process mode, `stop()` only prevents future triggers, it never awaits an invocation of `func`
already in flight.

**Signature:**

```ts
function waitForCurrentTick(): Promise<void>;
```

**Usage example:**

```ts
scheduledTask?.stop();
await waitForCurrentTick(); // never cancels the tick, only waits for it
await closeBus();
```

---

## scheduleTick()

**Location:** `src/domain/ingesta/scheduler.ts`

**Description:** Decides between the two `POLL_ENABLED` branches (Step 8 of the startup flow).
`true`: calls `cron.schedule(config.poll.cron, () => triggerTick(config, logger, client, space, runTick))`
and returns the `ScheduledTask` — `config.poll.cron` arrives already validated by `cron.validate()`
in the schema (S-007), so this function never repeats that validation. `false`: logs
`'poll deshabilitado: no se schedula ningún tick'` and returns `undefined` without ever calling
`cron.schedule()`. Neither branch fires an immediate tick — the first one always waits for the
cron's own first trigger, a property of `node-cron` itself, not of this function.

**Signature:**

```ts
function scheduleTick(
  config: AppConfig,
  logger: Logger,
  client: Client,
  space: KvSpace, // S-032: only propagated to the tick; the scheduler never touches it
  runTick?: (config: AppConfig, logger: Logger, client: Client, space: KvSpace) => Promise<void>, // defaults to runIngestaTick
  cronScheduleFn?: typeof import('node-cron').schedule, // defaults to the real cron.schedule
): ScheduledTask | undefined;
```

**Usage example:**

```ts
const scheduledTask = scheduleTick(config, logger, client, space); // production
```

**Notes:**

- `cronScheduleFn` is injectable so tests never register a real cron job or mock `node-cron` at the
  module level — same pattern as `imapFlowCtor` in `infra/imap/client.ts`.
- The process stays alive in both branches, but only because of the bus connection's open handle
  (inherited from `connectToBus()`), never because of code added in this function (CA-4).

---

## createShutdownHandler()

**Location:** `src/shared/shutdown.ts`

**Description:** Builds the `SIGTERM`/`SIGINT` handler for the ordered shutdown (CA-8/CA-9). In
order: `scheduledTask?.stop()` (if the poll was enabled) → `await waitForCurrentTick()` (waits
**unconditionally**, never cancels an in-flight tick — canceling it mid `fetch`/`markSeen` is
exactly the silent data loss this design avoids) → `await closeBus()` → `exit(0)`, always after
`closeBus()` resolves, never before. All four dependencies are received by parameter (no
`node:process` or bus-connection import inside this module), so the handler is testable by calling
it directly — no real OS signal sent to the test process, no real timer.

**Signature:**

```ts
interface ShutdownDeps {
  scheduledTask: { stop(): void | Promise<void> } | undefined;
  waitForCurrentTick: () => Promise<void>;
  closeBus: () => Promise<void>;
  exit: (code: number) => void;
}

function createShutdownHandler(deps: ShutdownDeps): () => Promise<void>;
```

**Usage example:**

```ts
const shutdown = createShutdownHandler({ scheduledTask, waitForCurrentTick, closeBus, exit: process.exit });
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
```

**Notes:**

- Works identically when `scheduledTask` is `undefined` (the poll was disabled): there is no task
  to stop, but the bus still has to close.
- No timeout of its own around the tick wait: a tick in flight is never canceled, by design — a
  timeout that aborted it would reintroduce exactly the silent loss the design avoids. If the
  process is killed anyway (`SIGKILL`), that is an already-accepted scenario (S-010 CA-13), not
  something this handler needs to guard against.

---

## routeMail()

**Location:** `src/domain/ruteo/route-mail.ts`

**Description:** Decides what a mail is: a reply, a new mail with a slug (an **intent** to create),
or a discard. Pure, synchronous, never throws and never logs — the caller (the tick) decides what to
log and what to query from the `RouteResult` it gets back. Evaluates cheapest-first:
`referenceIds.length > 0` short-circuits to `{ ok: false, intencion: 'comentario' }` before touching
the slug at all; then isolates the address from `recipient` with `extractAddress()`, applies the
case-insensitive `^<prefix>\+([^@]+)@` pattern (prefix built dynamically from config and escaped),
and returns `{ ok: false, intencion: 'alta', slug }` with the captured slug **lowercased**
(invariant 4). **Since S-032 (REQ-008) it no longer resolves the project**: the Ticket Map lives in
the KV Space and the tick resolves the intent with `lookupTicket()` — the same shape REQ-005 used to
take the thread lookup out of here. `slug_no_mapeado` is therefore no longer produced here. A known,
accepted false positive: a forwarded mail with a populated `References` and a legitimate new request
still goes down the reply branch — a deliberate degrade-to-discard decision (PRD decision 9, G-04),
not a bug.

**Signature:**

```ts
function routeMail(
  mail: Pick<IncomingMail, 'referenceIds' | 'recipient'>,
  config: Pick<RuteoConfig, 'subaddressPrefix'>,
): RouteResult;
```

**Usage example:**

```ts
import { routeMail } from '#domain/ruteo/route-mail.js';

routeMail({ referenceIds: [], recipient: 'tickets+Alfa@grava.io' }, { subaddressPrefix: 'tickets' });
// { ok: false, intencion: 'alta', slug: 'alfa' }  — the tick then calls lookupTicket()

routeMail({ referenceIds: ['<r1@x>'], recipient: 'tickets+alfa@grava.io' }, { subaddressPrefix: 'tickets' });
// { ok: false, intencion: 'comentario' }          — the tick then calls lookupThread()

routeMail({ referenceIds: [], recipient: 'soporte@grava.io' }, { subaddressPrefix: 'tickets' });
// { ok: false, motivo: 'sin_slug' }
```

**Notes:**

- Does not import anything from `#domain/ingesta/*` besides `extractAddress` (value) and
  `IncomingMail` (type-only), nothing from `#domain/publicacion/*` and nothing from `#infra/*` — the
  module is a pure leaf the tick composes, never the other way around. It receives no KV handle.
- A slug that is not loaded is **still** an `intencion: 'alta'`: whether it is mapped is a question
  only the KV can answer, and `routeMail()` does no I/O.

---

## particionar()

**Location:** `src/domain/adjuntos/particionar.ts`

**Description:** First stage of the attachment pipeline (S-017). Resolves a generated filename
(position-based, e.g. `adjunto-1.png`) when `filename` is missing, defaults `mimeType` to
`application/octet-stream` when missing (no content-sniffing inference), then evaluates the local
policy in a fixed order — 0-byte size (unconditional) → extension → MIME → max size — over
`content.length` (the real in-memory `Buffer`), never the mail's declared `size`. Pure, never
throws: an unexpected error on one attachment is captured and rejected with `regla:
'error_interno'`, without aborting the rest.

**Signature:**

```ts
function particionar(
  attachments: readonly MailAttachment[],
  config: Pick<AdjuntosConfig, 'allowedExtensions' | 'allowedMimeTypes' | 'maxSizeBytes'>,
): ParticionResult<AdjuntoParticionado>;
```

**Notes:**

- A filename with no dot (`path.extname()` returns `''`) is treated as passing the extension rule
  and falls through to the MIME rule — there is nothing to compare an absent extension against,
  and the MIME whitelist is the real gate for that case.
- `content.length`, never `size`: the declared value is deliberately never read for this rule.

---

## deduplicar()

**Location:** `src/domain/adjuntos/dedup.ts`

**Description:** Second stage: deduplicates already-partitioned attachments by sha256 checksum
(`node:crypto`) of `content`, keeping the first in mail order and silently discarding the rest — no
rejection entry, no log, no warning for a collapsed duplicate. The declared `mimeType` never
participates in the comparison. The `Set<string>` of seen checksums is scoped to a single
invocation — no module-level state survives between mails. `O(n)`.

**Signature:**

```ts
function deduplicar(
  particionados: readonly AdjuntoParticionado[],
): ParticionResult<AdjuntoAceptado>;
```

**Notes:** An unexpected error computing one attachment's checksum is captured and rejected with
`regla: 'error_interno'`, without aborting the rest.

---

## aplicarTope()

**Location:** `src/domain/adjuntos/tope.ts`

**Description:** Third stage: keeps the first `MAX_ATTACHMENTS_PER_REQUIREMENT` (10) deduplicated
attachments in order, moving the rest to rejections with `regla: 'tope_excedido'`. The cap is
imported from `#config/schema.js`, never a bare literal and never read from configuration — it is
the bus contract's `maxItems`.

**Signature:**

```ts
function aplicarTope(aceptados: readonly AdjuntoAceptado[]): ParticionResult<AdjuntoAceptado>;
```

---

## procesarAdjuntos()

**Location:** `src/domain/adjuntos/procesar.ts`

**Description:** Composes the three stages in the one order that produces correct results:
**particionar → deduplicar → aplicarTope**. Partition first so two identical rejected files (e.g.
two identical `.exe`s) produce two independent rejection entries rather than a spurious
duplicate-notice; dedup before the cap so N identical acceptable copies collapse to one before the
cap ever evaluates anything. Accumulates the three stages' rejections into one final array, in
production order. No barrel file for this module — same precedent as `ruteo` and `publicacion`,
which use direct per-file imports.

**Signature:**

```ts
function procesarAdjuntos(
  attachments: readonly MailAttachment[],
  config: Pick<AdjuntosConfig, 'allowedExtensions' | 'allowedMimeTypes' | 'maxSizeBytes'>,
): ParticionResult<AdjuntoAceptado>;
```

**Notes:** Pure end to end — no `files.request-upload`, no `PUT`, no description composition, no
logging. Those are S-018, S-019, S-020 and S-021 respectively. Not yet wired into the tick
(`src/domain/ingesta/tick.ts`) — that integration is S-021.

---

## requestFileUpload()

**Location:** `src/domain/publicacion/upload-file.ts`

**Description:** The second write point of the connector (alongside `publishVerificationRequirement()`/
`publishRequirementFromMail()`). Builds and validates the `files.request-upload` payload from ONE
`AdjuntoAceptado`, publishes it with `client.command()` (the same already-connected client, no second
`connect()`), and translates the reply into a typed `UploadResultado`. It is the ONLY file that adds
the branch distinguishing core's business `failure` (`file_type_not_allowed`/`file_too_large`) from any
other publication failure, checked with `isCode()` **before** `diagnosePublishFailure()` runs — that
function is reused unmodified.

**Signature:**

```ts
function requestFileUpload(
  adjunto: Pick<AdjuntoAceptado, 'filename' | 'mimeType' | 'content' | 'checksum'>,
  deps: { client: Client; logger: Logger },
): Promise<UploadResultado>;
```

**Usage:**

```ts
const result = await requestFileUpload(adjunto, { client, logger });

if (result.tipo === 'concedido') {
  // result.fileId, result.uploadUrl — hand off to S-019's PUT
} else if (result.tipo === 'rechazado') {
  // result.codigo — core's business rejection, already logged at warn
} else {
  // result.tipo === 'fallido' — result.diagnosis, already logged at error
}
```

**Notes:**

- **Deliberate divergence from `publish-requirement.ts`: this function NEVER throws** for a rejection or
  a failure — it always resolves with a typed `UploadResultado`. Whoever orchestrates the attachment
  loop (S-021) needs a value to inspect per file, not an exception that would interrupt the `for` unless
  wrapped in a per-iteration `try`/`catch`.
- Invoked **once per attachment, in series** — the signature accepts no list and no order parameter
  (CA-9). It does not orchestrate the tick and does not decide processing order; that is S-021.
- `fileSize` comes from `adjunto.content.length`, **never** a declared `size` (that field does not exist
  on `AdjuntoAceptado` — S-017 already dropped it). `checksum` arrives already computed by S-017; this
  function never calls `node:crypto`, only transports it.
- **Never logs `uploadUrl`**, in any branch or result — it is a short-lived write credential (RF-23,
  RF-39 of REQ-004). The success branch logs nothing at all: `fileId` is only informative until S-021
  links it to a requirement.
- `files.request-upload` has **no `projectId`** — the upload permission is requested before knowing
  which requirement it will link to, unlike `requirements.new`. The error-branch log context is
  therefore built by hand from `PublishError`'s public fields instead of reusing `logContext(projectId)`
  with an invented `projectId` that does not apply here.
- `DOS ARGUMENTOS`, never three, in `client.command(COMMAND, payload)` — same ADR-002 rule as
  `publish-requirement.ts`: the third (`options`) is where the timeout would accidentally get lowered.

---

## uploadFileContent()

**Location:** `src/domain/publicacion/upload-byte.ts`

**Description:** The other half of ADR-003's contract: `requestFileUpload()` resolves the permission
plane (`fileId` + `uploadUrl`), this function resolves the byte plane — a direct `PUT` HTTPS to the
prefigured `uploadUrl`, with native `fetch` and `AbortSignal.timeout()`, no new npm dependency. It is
the only file in `publicacion/` that never touches the bus — no `Client`, no `client.command()`, no
NATS connection at all — so it is the only piece of this module unit-tested with a `fetch` stub instead
of the shared NATS test container.

**Signature:**

```ts
function uploadFileContent(
  adjunto: Pick<AdjuntoAceptado, 'filename' | 'mimeType' | 'content'>,
  deps: { uploadUrl: string; timeoutMs: number; logger: Logger },
): Promise<PutResultado>;
```

**Usage:**

```ts
const result = await uploadFileContent(adjunto, {
  uploadUrl: granted.uploadUrl, // from requestFileUpload()'s 'concedido' result
  timeoutMs: config.adjuntos.putTimeoutMs,
  logger,
});

if (result.tipo === 'subido') {
  // accumulate fileId + placeholder for the requirement payload (S-021's job)
} else {
  // result.tipo === 'fallido' — already logged at warn, move on to the next attachment
}
```

**Notes:**

- **Never logs `uploadUrl`**, in success (which logs nothing) or failure — it is the write credential
  this function exists to protect (RF-23 of REQ-004). Verified both at runtime
  (`test/publicacion/upload-byte.test.ts`) and statically (`test/publicacion/source-properties.test.ts`).
- The `try`/`catch` wraps the ENTIRE `RequestInit` construction and the `fetch` call, not just the
  `await` — so an unexpected connector bug while building the request (CA-7) and a network/timeout
  failure (CA-4) share the exact same `catch` block, the exact same result, and the exact same log line.
  No branching by cause.
- Any 2xx is `{ tipo: 'subido' }` **without reading the response body** — no `.json()`, no `.text()`,
  not even to discard it (CA-3). Any non-2xx (including an expired URL, typically 403) is
  `{ tipo: 'fallido' }`, same as a network error or a timeout.
- `timeoutMs` is ALWAYS the parameter received (`config.adjuntos.putTimeoutMs` in production), never a
  literal `30000`/`30_000` in this file — enforced by a static scan test. Independent of the bus's
  `MIN_TIMEOUT_MS` (15000 ms): two distinct constants for two distinct kinds of operation.
- `filename` is required in the input Pick **only** for the failure log's `nombre` field — it plays no
  part in the `PUT` itself (no URL, no header, no body).
- Never retries internally: `fetch` is invoked exactly once per call (NFR-R03 — requesting a new upload
  permission for a failed `PUT` would itself be a retry, and is forbidden).

---

## procesarAdjuntosDelMail()

**Location:** `src/domain/publicacion/procesar-adjuntos-mail.ts`

**Description:** S-021's central orchestrator: the piece that connects `procesarAdjuntos()` (S-017,
partition → dedup → cap), `requestFileUpload()` (S-018) and `uploadFileContent()` (S-019) into a
single processing cycle for ONE mail's attachments. None of the three composed functions knows about
the others or about the full cycle — this function is what wires them.

**Signature:**

```ts
interface ProcesamientoAdjuntosResultado {
  readonly fileIds: number[]; // in upload order
  readonly avisosDeRechazo: string[]; // local policy + core's business rejections, same block
  readonly avisosDeFallo: string[]; // upload-permission or PUT failures, distinct block
  readonly placeholders: string[]; // one per uploaded attachment, same order as fileIds
}

interface ProcesarAdjuntosDelMailDeps {
  readonly client: Client;
  readonly logger: Logger;
  readonly requestFileUpload?: typeof requestFileUploadReal; // test-only override
  readonly uploadFileContent?: typeof uploadFileContentReal; // test-only override
  readonly lookupAttachmentByChecksum?: typeof lookupAttachmentByChecksumReal; // test-only (S-029)
}

/** S-029. No optional field: it is passed WHOLE or not passed at all. */
interface ContextoHilo {
  readonly requirementId: number;
}

function procesarAdjuntosDelMail(
  attachments: readonly MailAttachment[],
  config: Pick<AdjuntosConfig, 'allowedExtensions' | 'allowedMimeTypes' | 'maxSizeBytes' | 'putTimeoutMs'>,
  deps: ProcesarAdjuntosDelMailDeps,
  hilo?: ContextoHilo, // S-029: present ONLY on a reply with a Thread Map match
): Promise<ProcesamientoAdjuntosResultado>;
```

**Usage:**

```ts
const adjuntos = await procesarAdjuntosDelMail(mail.attachments, config.adjuntos, { client, logger });

const description = componerDescripcion({
  cuerpoBase: resolveCuerpoBase(mail.body, config.ruteo),
  avisosDeRechazo: adjuntos.avisosDeRechazo,
  avisosDeFallo: adjuntos.avisosDeFallo,
  placeholders: adjuntos.placeholders,
});

await publishRequirementFromMail(
  mail,
  route.projectId,
  config.ruteo,
  { client, logger },
  adjuntos.fileIds,
  description,
  adjuntos.avisosDeRechazo.length + adjuntos.avisosDeFallo.length,
);
```

**Notes:**

- **Serial, pair-by-file (CA-2):** for each accepted attachment, in `procesarAdjuntos()`'s output
  order, `requestFileUpload()` is followed **immediately** by `uploadFileContent()` before moving to
  the next attachment — never `Promise.all`/`allSettled`, never requesting all permissions first.
- **Never replenishes an excedente (CA-5):** the cap (`aplicarTope()`, inside `procesarAdjuntos()`)
  already decided which attachments are in scope; this function iterates only over `aceptados` and
  never reaches back into the `tope_excedido` rejections to fill in for a failed upload.
- **Per-attachment fault isolation (CA-6, RF-34):** the `try/catch` wraps the ENTIRE processing of
  one attachment (`procesarUnoAceptado()` — both the permission request and the `PUT`), not just the
  bus call, so an unexpected **programming** error (not a typed business outcome) is caught, logged
  at `error` without exposing the attachment's content, turned into a failure notice, and the `for`
  continues with the next attachment. Never escapes to the caller.
- **Never throws for a business outcome** — always resolves. `requestFileUpload()`/
  `uploadFileContent()` never throw either by design (S-018/S-019), so under real conditions this
  function's own `try/catch` only fires for a genuine programming bug.
- **Local rejections are logged here for the first time**, at `info` (`particionar()`/`deduplicar()`/
  `aplicarTope()` are pure and log nothing) — distinct from a `core` business rejection, which
  `requestFileUpload()` already logs at `warn` with a `code` (CA-12). Both land in the **same**
  `avisosDeRechazo` block of the description; only the log level/shape distinguishes them.
- **Placeholder choice** is `adjunto.mimeType.startsWith('image/')` → `![attach:{id}]`, else
  `[attach:{id}]` — the declared MIME, the same field `particionar()`/`deduplicar()` already decided
  on, never re-derived from the response.
- **No array in this function retains a `Buffer`/`content` beyond the `PUT` of that one attachment**
  (CA-11): the returned result only carries ids, strings and placeholders.
- **`requestFileUpload`/`uploadFileContent` are injectable** via `deps`, defaulting to the real
  implementations — same pattern as `Normalize` in `tick.ts` (S-016). Exists solely so a test can
  inject a double that throws an arbitrary exception to exercise the programming-error `try/catch`
  (TS-10), something the real implementations never do.
- Does **not** import `componerDescripcion()` — returns the raw pieces (`avisosDeRechazo`,
  `avisosDeFallo`, `placeholders`, `fileIds`); the caller composes the final description with the
  `cuerpoBase` it already has, keeping this function focused on one attachment's life cycle only.
- **The optional fourth argument, `hilo?: ContextoHilo` (S-029), and why its ABSENCE is the
  mechanism.** When present, each accepted attachment asks `lookupAttachmentByChecksum()` **before**
  `requestFileUpload()`, and a `reusado` short-circuits the cycle: no permit, no `PUT`, and the
  result carries **the same shape as an upload** so the reused `fileId` and its placeholder enter
  `fileIds`/`placeholders` through the same channel, with no new branch in the accumulator. When
  absent — which is how the **new-mail branch** of `tick.ts` invokes it, with three arguments — the
  query block does not exist for that call at all: **there is no `if (esRespuesta)` and no
  configuration flag** to get wrong. It is an object rather than a bare `requirementId?: number`
  precisely so that `{ requirementId: undefined }` is not representable; if it were, it would
  compile, type-check, and produce a query with `entityId: undefined` that `core` would reject with
  `invalid_fields` on **every** attachment of **every** reply.
- **The query lives INSIDE `procesarUnoAceptado()`, therefore inside the existing `for`,** and that
  position is what makes four S-029 criteria true **without a line of new code**: `deduplicar()`
  already collapsed the repeats (one query per **surviving** checksum), `aplicarTope()` already
  trimmed to ten (the excedentes pay **no** query), the `for` only ever iterates `aceptados` (a
  locally rejected attachment never queries), and the `for` is already serial (the query inherits
  the series, with no `Promise.all`). **No checksum cache, no module variable, no state between
  invocations** (ADR-001).

---

## lookupAttachmentByChecksum()

**Location:** `src/domain/publicacion/lookup-attachment.ts`

**Description:** S-029's reuse query, and the **first and only read the connector performs**. Asks
`attachments.list` whether one accepted attachment's `checksum` is **already linked to the thread's
Requirement by the connector itself**, and returns the existing `fileId` so `procesarUnoAceptado()`
can skip the upload cycle entirely — no `files.request-upload`, no `PUT`, no new row in `files` and
no new object in storage.

It is the fourth contract file of `publicacion` — next to `upload-file.ts`
(`files.request-upload`), `publish-requirement.ts` (`requirements.new`) and `publish-comment.ts`
(`requirements.{id}.comment`) — but the **first of the read plane**, and therefore the piece that
**partially derogates** an ADR-003 Implementation Rule. See `overview.md` for the exact scope; the
rewrite of the ADR's own text belongs to **S-030**.

**Signature:**

```ts
/** TWO variants and NO error variant. That is the contract, not an omission. */
type LookupAttachmentResultado =
  | { readonly tipo: 'reusado'; readonly fileId: number }
  | { readonly tipo: 'sin_match' };

function lookupAttachmentByChecksum(
  options: {
    /** NOTE: no `content`. The byte never reaches this function. */
    readonly adjunto: Pick<AdjuntoAceptado, 'filename' | 'mimeType' | 'checksum'>;
    readonly requirementId: number;
  },
  deps: { client: Client; logger: Logger },
): Promise<LookupAttachmentResultado>;
```

**Usage:**

```ts
const reuso = await lookupAttachmentByChecksum(
  { adjunto, requirementId: hilo.requirementId },
  { client, logger },
);

if (reuso.tipo === 'reusado') {
  // reuso.fileId — the existing link. Skip the permit and the PUT entirely.
  return { resultado: 'subido', fileId: reuso.fileId, placeholder: placeholderPara(adjunto, reuso.fileId) };
}

// reuso.tipo === 'sin_match' — fall through to the full upload cycle, exactly as before.
```

**Notes:**

- **NEVER THROWS, for any input and any bus failure.** It lives inside an attachment loop that
  cannot be interrupted, so it exhausts its failures internally. Re-throwing would make the
  orchestrator's programming `try/catch` count as **fallido** an attachment that uploaded fine — a
  lying notice to the client.
- **The return type has no error variant, and the degradation has no variant of its own.** A failed
  query returns `sin_match`, the **same** shape as "I asked and there is nothing". The caller cannot
  tell them apart, and that is deliberate: it has nothing different to do with each.
- **The four filters are all mandatory, each for a different reason, and none may be "simplified":**
  - `entityType: 'requirement'` + `entityId` narrow the query **to the thread's Requirement**. These
    are what prevent cross-project reuse — **not** `uploadedBy`: the connector uploads *everything*
    under the same identity, so without `entityId` the match would be **global** and one client's
    file could be reused in another client's Requirement.
  - `checksum` is the question itself: "is this byte already linked here?".
  - `uploadedBy: client.userId` guarantees the reused `fileId` is **always linkable**, with no risk
    of `file_not_owned` — which would discard the **entire** comment write.
- `include: ['checksum']` is sent **even though `checksum` also travels in the `filter`**, and it is
  not redundant: `include` decides **what comes back**, `filter` decides **which rows**. It makes the
  returned row **self-verifying** in a test rather than trusting that the filter was applied.
- **`limit: 1`, no pagination, no `count`, no `cursor`, no `sort`.** Any match will do: every
  candidate is byte-identical and every one belongs to the caller. **Note for tests:** the SDK's
  `listPayload()` folds `limit`/`cursor` into `page`, so the payload observed on the bus carries
  `page: { limit: 1 }` — asserting a top-level `limit` would fail against a correct implementation.
- **TWO arguments to `client.list()`, never three.** The third (`RequestOptions`) is where the
  timeout would accidentally get lowered, and ADR-006 forbids it: the effective timeout stays the
  client's, the same one the three commands use.
- **The subject is built by the SDK.** The module passes `'attachments'` as the resource; the SDK
  derives `attachments.list` and the full
  `{instance}.{userId}.jiku-queries.v1.attachments.list`. The string `jiku-queries` **does not
  appear in `src/`**, and a property test enforces it.
- **`items: []` is a `success`, not an error** — a `list` never answers a `*_not_found`. Four
  situations produce it and all arrive indistinguishably on purpose: the file was never in this
  Requirement; another actor uploaded it (`uploadedBy`); it is in a different Requirement
  (`entityId`); or its link was deleted / its file is not retained — the resource's **two permanent
  exclusions**, which **cannot be overridden from the payload**. The connector cannot reuse a
  deleted link **even by mistake**.
- **Reuses `diagnosePublishFailure()` and `codeOf()` without adding a single branch.** The
  contract's six error codes plus the generic `JikuError` that `client.list()` throws when the reply
  is not a collection all degrade to `sin_match`. `query_timeout` is a code new to this connector
  and lands, correctly, in `core_rechazo_desconocido`: the code catalogue belongs to `core` and
  grows, so an unknown code is a **normal** outcome, not a residual case.
- **Logs `warn` on a failure, never `error`** — the mail's outcome is still correct (the attachment
  arrives, the comment is published); only an optimisation stopped working. Context is **flat, one
  level deep**, because the log redaction has no deep wildcard and a nested context would leave a
  secret in the clear without failing or warning. `code` is spread **conditionally**, omitted when
  `codeOf()` returns `undefined` (no reply from `core`).
- **The `checksum` IS logged** — it is a hash, not the byte, and it is the datum that joins this log
  to `core`'s. What is never logged: the attachment's byte, the mail body, the comment text. And **no
  field is ever named `key`**: `REDACT_PATHS` would redact it silently.
- **Never recomputes the hash (and could not):** it receives
  `Pick<AdjuntoAceptado, 'filename' | 'mimeType' | 'checksum'>` and **not** `content`, so it does not
  even hold the byte. `deduplicar()` is the single place where anything is hashed; a second source of
  truth for the hash is exactly what this signature prevents.

---

---

## openKvSpace()

**Location:** `src/infra/kv/space.ts`

**Description:** Opens the connector's **KV Space** —its per-identity space inside the shared
`JIKU_KV` bucket, keys prefixed `{instance}.{userId}.` by the SDK— with `await client.kv()`, **once**,
over the process's single connection. Startup step 5.5: after `connectToBus()` (the space travels
over `client.connection`) and before `scheduleTick()` (an unusable space must stop the startup, not
be discovered on the first mail). It is the **only** place in `src/` that calls `client.kv()`; the
returned handle travels by parameter down to the tick.

**Signature:**

```ts
/** The handle that travels by parameter. No delete(): the connector never deletes. */
type KvSpace = Pick<KV, 'get' | 'put'>;

interface OpenKvSpaceOptions {
  readonly client: Client;
  readonly logger: Logger;
}

function openKvSpace(options: OpenKvSpaceOptions): Promise<KvSpace>;
```

**Usage example:**

```ts
import { openKvSpace } from '#infra/kv/space.js';

const client = await connectToBus({ config, auth, logger });
const space = await openKvSpace({ client, logger });
// info 'espacio KV abierto' { bucket: 'JIKU_KV', kvPrefix: 'prod.387842544790142978.' }
scheduleTick(config, logger, client, space);
```

**Notes:**

- **It never creates the bucket.** The SDK does the `$JS.API.STREAM.INFO.KV_JIKU_KV` and rejects a
  bucket without `allow_direct`; the deploy of Jiku creates `JIKU_KV`. A failure is rethrown as
  `KvSpaceUnavailableError`, diagnosed by the SDK's **class** (`diagnoseKvFailure()`), and
  `reportStartupFailure()` logs it through its own `fatal` branch.
- **`KvSpace = Pick<KV, 'get' | 'put'>`, not `KV`.** The SDK's `KV` is a class with private ES fields
  and a private constructor, so TypeScript treats it nominally and an object literal (a test double)
  is not assignable to it. The `Pick` is satisfied structurally — and leaves `delete()` uncallable on
  the handle at compile time.
- **The log field is `kvPrefix`, never `key`** (`REDACT_PATHS` would censor it silently). Its value is
  `kvKey(client.instance, client.userId, '')`, built with the SDK's own function so it cannot diverge
  from the real prefix — it is the value U-02 copies to load a slug.
- **No `timeoutMs` and no `signal`**: the client's timeout (15 s, ADR-002) applies.

---

## lookupTicket()

**Location:** `src/infra/kv/tickets.ts`

**Description:** Resolves a slug (already lowercased by `routeMail()`) to its Jiku `projectId` with
**one** `get('tickets.<slug>')` on the KV Space, **one attempt, no cache**. Called by the tick in the
`intencion: 'alta'` branch, **before** `procesarAdjuntosDelMail()` — uploading attachments for a mail
that is then discarded would orphan them. **Never throws.**

**Signature:**

```ts
type TicketLookupResult =
  | { readonly found: true; readonly projectId: number }
  | { readonly found: false; readonly consultable: true }    // not there → slug_no_mapeado
  | { readonly found: false; readonly consultable: false };  // could not ask → slug_no_consultable

interface LookupTicketOptions {
  readonly space: KvSpace;
  readonly slug: string;   // already lowercase
  readonly logger: Logger;
}

function lookupTicket(options: LookupTicketOptions): Promise<TicketLookupResult>;
```

**Usage example:**

```ts
import { lookupTicket } from '#infra/kv/tickets.js';

const destino = await lookupTicket({ space, slug: route.slug, logger });
if (destino.found) {
  // procesarAdjuntosDelMail → publishRequirementFromMail(mail, destino.projectId, …)
} else {
  const motivo = destino.consultable ? 'slug_no_mapeado' : 'slug_no_consultable';
  logger.warn({ messageId: mail.messageId, motivo, slug: route.slug }, 'mail descartado');
}
```

**Notes:**

- **Four situations, three results.** A positive integer → `found`. `get()` returning `undefined`
  (never loaded, or deleted) → `consultable: true`, no log. A malformed value → `consultable: true`
  with a `warn` that names the **slug, never the raw value**. A slug that cannot be a KV key
  (`isStorableSlug()` false) → `consultable: true` **without a round-trip** — it can never have been
  loaded, so it is "not mapped", not a failure. A rejected (or synchronously throwing) `get()` →
  `consultable: false` with a `warn` `{ slug, errorClass }`.
- **No cache, by design.** A `put` or a delete by U-02 takes effect from the **next mail**, with no
  redeploy. A source scan asserts no module-level `Map`/`Set`/`let`/`Record` in `tickets.ts` and a
  single `lookupTicket(` call in `tick.ts`.
- **No retry** (ADR-001) and **no timeout of its own**: under a KV outage each query waits for the
  client's timeout, and every new mail of the tick is discarded as `slug_no_consultable` — the
  accepted safe failure; the log names the slug so the mails can be rebuilt from the mailbox.
- The `projectId` is parsed with the shared `parsePositiveId()` over
  `new TextDecoder().decode(entry.value)`; it is **not** validated against Jiku.

---

## recordThreadEntry()

**Location:** `src/infra/kv/threads.ts`

**Description:** Writes the Thread Map entry `hilos.<sha256(raw Message-Id)> → requirementId` on the
KV Space `openKvSpace()` opened. Called from the tick's `for` in two places: after a requirement is
created (inside the publication's `try`, **after** `counters.creados += 1`) and after a comment
succeeds (with the **reply's** own `Message-Id`).

**Signature:**

```ts
interface RecordThreadEntryOptions {
  readonly space: KvSpace;      // the handle openKvSpace() opened; no new connection
  readonly messageId: string;   // RAW, with its brackets, as normalize() delivers it
  readonly requirementId: number;
  readonly logger: Logger;
}

function recordThreadEntry(options: RecordThreadEntryOptions): Promise<void>
```

**Usage example:**

```ts
import { recordThreadEntry } from '#infra/kv/threads.js';

const { requirementId } = await publishRequirementFromMail(/* … */);
counters.creados += 1;

// No try/catch: this never throws. Wrapping it would suggest otherwise.
await recordThreadEntry({ space, messageId: mail.messageId, requirementId, logger });
```

**Notes:**

- **It never throws, and that is the contract.** A rejected `put()` —including `JikuBucketFull`, since
  `JIKU_KV` is shared by every identity and has no per-identity quota— is absorbed with a **single**
  `warn` carrying the flat context `{ messageId, messageIdHash, requirementId, errorClass }`, and the
  function resolves normally. The requirement already exists in Jiku and there is no compensating
  command (invariant 9), so `counters.creados` is **not** reverted. **Do not wrap the call in a
  `try/catch`.**
- **The accepted consequence of a failed write** is that the thread will not route later: a reply to
  that mail will be discarded as `hilo_desconocido`, which is the safe failure.
- **The key is `threadKey(messageId)`** (`hilos.` + `sha256hex()` of the raw `Message-Id`); the value
  is the integer as **text** (`String(requirementId)`), read back with `parsePositiveId()`.
- **The `put()` takes no options**: no TTL (entries never expire, invariant 32) and no timeout of its
  own.
- **The log field `messageIdHash` is the bare hash** (64 hex, without the `hilos.` prefix), and
  **never** a field named `key` — `REDACT_PATHS` covers `'key'` and `'*.key'`.

---

## lookupThread()

**Location:** `src/infra/kv/threads.ts`

**Description:** Resolves which requirement a reply's thread belongs to, by walking the mail's
`referenceIds` **in the order received** and querying `space.get(threadKey(refId))` on each until
the first valid hit. Called from the tick's reply branch (`intencion: 'comentario'`), which never
evaluates the slug (invariant 26).

**Signature:**

```ts
type ThreadLookupResult =
  | { readonly found: true; readonly requirementId: number }
  | { readonly found: false; readonly consultable: true }    // queried, no match
  | { readonly found: false; readonly consultable: false };  // could not query

interface LookupThreadOptions {
  readonly space: KvSpace;
  readonly referenceIds: readonly string[];  // already ordered and deduped by normalize()
  readonly logger: Logger;
}

function lookupThread(options: LookupThreadOptions): Promise<ThreadLookupResult>
```

**Usage example:**

```ts
import { lookupThread } from '#infra/kv/threads.js';

const hilo = await lookupThread({ space, referenceIds: mail.referenceIds, logger });
if (hilo.found) {
  // comment on hilo.requirementId, then recordThreadEntry() with the REPLY's Message-Id
} else {
  const motivo = hilo.consultable ? 'hilo_desconocido' : 'es_respuesta';
  logger.warn({ messageId: mail.messageId, motivo }, 'mail descartado');
}
```

**Notes:**

- **Three states, not two.** `number | undefined` would collapse "it isn't there" with "I couldn't
  ask": *"this reply points at a thread I don't know"* (`hilo_desconocido`) versus *"I couldn't find
  out which thread it points at"* (`es_respuesta`). One is fixed by loading the thread, the other by
  fixing the KV.
- **It never throws.** All three outcomes are typed return values.
- **`undefined` from `get()` means "not there"** (never written, or deleted) and the walk continues
  with the next reference. Nothing reads `entry.created`: an entry of any age matches.
- **It stops at the first valid hit** and **NEVER uses `Promise.all`** over the references — that
  would erase the cutoff and the ordering that makes the `In-Reply-To` reference win (ADR-001).
- **A malformed value is not a hit, and iteration continues**, with a `warn` naming the
  `messageIdHash`. A rejected `get()`, by contrast, **stops**: an unreachable KV does not become
  reachable on the next reference.
- **An empty `referenceIds` costs zero round-trips.**
- **`get()` puntual, no `watch()`, no in-memory copy** — since S-032 the same is true of the Ticket
  Map (`lookupTicket()`). A source scan asserts the absence of `watch(` and of any module-level
  `Map`.
