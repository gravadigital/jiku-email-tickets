# Reusable Code - jiku-email-tickets

This document lists all reusable code available in this service. Each category has its own file with
detailed documentation.

Created by S-001 (bootstrap), extended by S-002 (typed configuration), S-003 (structured logging with
redaction), S-004 (identity and the single bus connection), S-005 (publishing `requirements.new` and
translating its errors), S-008 (pure mail normalization), S-009 (the `MailSource` port and its
`imapflow` adapter), S-010 (the tick: cap, order, marking and failure isolation), S-011 (the
no-overlap scheduler guard, `cron.schedule()` wiring, and the ordered shutdown on `SIGTERM`/`SIGINT`),
S-012 (the Ticket Map with its two exclusive sources, the subaddress prefix and the placeholders),
S-013 (the pure `routeMail()` decision tree and the single-source `MotivoDescarte`/`RouteResult`
types), S-015 (the mail-derived payload, `buildRequirementPayload()`), S-016 (closing the catalog
with the real names the implementation settled on — see the note under `buildRequirementPayload()` and
`MotivoDescarte`/`RouteResult` below), S-017 (the pure attachment pipeline — `particionar()`,
`deduplicar()`, `aplicarTope()`, `procesarAdjuntos()` — and the four-key local file policy extension
to the typed configuration) S-018 (the `files.request-upload` contract and its publisher,
`requestFileUpload()` — the second command ADR-003 allows, with the file-rejection branch that
splits `core`'s business `failure` from any other publication failure before it reaches
`diagnosePublishFailure()`), S-019 (`uploadFileContent()`, the direct `PUT` HTTPS client that
resolves ADR-003's byte plane with native `fetch` — the only `publicacion/` file with no bus
dependency at all) and S-020 (`componerDescripcion()`, the pure four-block deterministic
composition of `description` — body, rejection notices, upload-failure notices, placeholders,
always in that order) and S-029 (`lookupAttachmentByChecksum()`, the **first read** the connector
ever makes — `attachments.list` filtered by the four names that make a reuse safe — plus
`respondToQuery()`, the query-plane `core` double, and the optional fourth `ContextoHilo` argument
that makes "the new mail never queries" structural rather than a conditional) and S-032 (all state
moves to the SDK's **KV Space** — `openKvSpace()`, `lookupTicket()` with one `get` per mail, the
single keys module, the startup diagnosis by SDK class — and the raw `@nats-io/kv` buckets, the
`watch()` and the four `KV_*` variables go away) and S-033 (test helpers only: the operator's CLI
writes with the full key, a JetStream server with static permissions, a controlled KV outage and a
back-dated entry, and stream inspection by last sequence). The service is a
`worker` in Node.js with no HTTP surface and no database, so several categories do not apply and
stay empty until a story creates them.

## Components

N/A (Backend service)

## Utils/Helpers

**Total: 14**

- **sha256hex()** (`src/infra/kv/keys.ts`) - The sha256 of a string, hex-encoded (64 chars of
  `[0-9a-f]`), over the value **exactly as given** — no `trim()`, no `toLowerCase()`, no
  normalization of any kind. It is how the Thread Map's key is built from a raw `Message-Id`: the KV
  key rules (the SDK's `assertValidKVKey()`) reject `<`, `>` and `@`, all three present in a real
  `Message-Id`. Normalizing instead of hashing would let two distinct `Message-Id`s collapse onto the
  same key and route a comment to the wrong requirement. Moved here from `threads.ts` in S-032.
- **ticketKey()** (`src/infra/kv/keys.ts`) - `'alfa'` → `'tickets.alfa'`: the Ticket Map key, only
  the right-hand part (the SDK adds `{instance}.{userId}.`).
- **threadKey()** (`src/infra/kv/keys.ts`) - `'hilos.' + sha256hex(messageId)` over the **raw**
  `Message-Id` (invariant 23): the Thread Map key.
- **isStorableSlug()** (`src/infra/kv/keys.ts`) - Whether a slug can be a KV key, delegating to the
  SDK's `assertValidKVKey()` instead of copying NATS's rules. Never throws. A non-storable slug is
  answered as `slug_no_mapeado` with no round-trip.
- **parsePositiveId()** (`src/infra/kv/parse.ts`) - Parses a **safe, strictly positive integer** from
  the raw text of a KV entry, returning `undefined` for anything else. Rejects `'0'`, negatives,
  `'4.5'`, `'42abc'` and `'0x2a'` — the last three because the parsed value must **re-serialize
  identically**. Shared by both maps of the KV Space (the Ticket Map's `projectId` and the Thread
  Map's `requirementId`): two copies of the rule would diverge on the first change.
- **cleanSubject()** (`src/domain/ingesta/subject.ts`) - Strips `Re:`/`Fwd:`/`RV:` prefixes
  iteratively and case-insensitively. An all-prefix subject is left as `''`, a valid state.
- **mergeReferenceIds()** (`src/domain/ingesta/headers.ts`) - Deduplicated union of `In-Reply-To`
  and `References`, in order of appearance, tolerating `references` as `string`, `string[]` or
  `undefined`.
- **pickRecipient()** (`src/domain/ingesta/headers.ts`) - First `Delivered-To`, `To` as fallback,
  `''` if neither. Deliberately does **not** join multiple `Delivered-To` values with `', '`.
- **extractAddress()** (`src/domain/ingesta/headers.ts`) - Isolates the address from any
  `Nombre <mail>` display-name header. Renamed from `extractSenderEmail` in S-013 to reuse it on
  `recipient`, not just `From`.
- **toPlainText()** (`src/domain/ingesta/body.ts`) - Plain text part when present, or the HTML part
  converted with `html-to-text` when that is the only one. Requires `skipHtmlToText: true` at parse
  time or its branch selection breaks silently.
- **trimQuotedText()** (`src/domain/ingesta/body.ts`) - Best-effort trim of quoted thread text by
  five markers. Ported unchanged from the service in production; never reinvented.
- **buildRequirementPayload()** (`src/domain/publicacion/mail-payload.ts`) - Builds the
  `requirements.new` payload from a routed mail: trim → truncate → placeholder, in that exact order,
  for `title` and `description`. Pure; validates nothing and publishes nothing. Since S-021, accepts
  an optional `fileIds: readonly number[]` and includes the key only when it has at least one
  element (never `fileIds: []`).
- **resolveCuerpoBase()** (`src/domain/publicacion/mail-payload.ts`) - Extracted in S-021: trim →
  placeholder-if-empty for the mail body, shared by `buildRequirementPayload()` and by
  `tick.ts` when composing the final `description` with `componerDescripcion()` — one calculation,
  not duplicated in two places.
- **componerDescripcion()** (`src/domain/publicacion/description.ts`) - Deterministically composes
  `description` from four already-resolved blocks (body, rejection notices, upload-failure notices,
  placeholders), always in that order, never truncating. Pure; does not know the origin of any input.

See full details in [utils.md](./utils.md)

## Middlewares

N/A (no HTTP surface - ADR-001)

## Services/Repositories

**Total: 33**

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
- **runStartup()** (`src/startup.ts`) - The startup sequence shared by both entry points: configuration
  → logger → identity → connection, with the two log lines. Extracted in S-005 so `start` and `verify`
  cannot diverge.
- **reportStartupFailure()** (`src/startup.ts`) - Reports a startup failure through the channel that
  matches its moment: stderr for a configuration failure (the logger does not exist yet), the logger
  for everything after it.
- **publishVerificationRequirement()** (`src/domain/publicacion/publish-requirement.ts`) - Publishes
  `requirements.new` with `client.command()`, validates the reply, logs `{ projectId, requirementId }`
  on one line, and translates any failure into a `PublishError`. Never retries.
- **publishRequirementFromMail()** (`src/domain/publicacion/publish-requirement.ts`) - Sibling of
  `publishVerificationRequirement()`: publishes the mail-derived `requirements.new` payload, adds the
  mail's `messageId` to both the success and the error log context, and rethrows on failure without
  retrying. Since S-021, accepts optional `fileIds`, an already-composed `description`, and an
  `archivosConAviso` count — the success log line sums `archivosVinculados`/`archivosConAviso` to the
  same line, never a second one; the failure log is untouched (orphaned files get no extra log).
- **diagnosePublishFailure()** (`src/domain/publicacion/publish-errors.ts`) - Classifies a publication
  failure by **SDK class and error code**, never by message text, into the diagnosis of *which system
  refused*. An unknown code is a normal outcome and is never mapped to a known case.
- **hintOf() / codeOf() / coreMessageOf()** (`src/domain/publicacion/publish-errors.ts`) - Safe
  accessors for what `core` sent. **`hintOf()` exists because `hint()` is declared only on
  `JikuFailure`**: calling it on any of the other four SDK error classes is a `TypeError`, so the guard
  lives in exactly one place. See services.md before "simplifying" it to an inline `error.hint()`.
- **withMailSource()** (`src/infra/imap/client.ts`) - Opens one IMAP connection (`secure: true`,
  `logger: false` unconditional), takes the `INBOX` lock, builds a `MailSource` bound to that
  client, runs the caller's callback, and closes lock/connection in a `finally` — one cycle shared
  across `searchUnseen`/`fetch`/`markSeen`, not one connection per operation.
- **runTick()** (`src/domain/ingesta/tick.ts`) - The tick's inner loop: cap, UID-descending
  sequential order, mark `\Seen` right after each successful download, isolate per-message
  failures, and always emit the five `TickCounters` — even when `searchUnseen()` itself throws.
- **runIngestaTick()** (`src/domain/ingesta/tick.ts`) - The `ingesta` module's entry point:
  composes `withMailSource()` with `runTick()`, and guarantees the metrics line is emitted even if
  the connection never opened — a closure flag (not the exception's type) tells whether the
  callback started.
- **triggerTick()** (`src/domain/ingesta/scheduler.ts`) - The no-overlap guard (S-011): skips a
  trigger with a `warn` when a tick is already in flight (never enqueues it), otherwise runs the
  injected tick function and releases the module-level `tickInFlight` flag in a `finally` — even if
  the tick throws. The riskiest piece of the whole feature group: a flag that never releases stops
  ingestion forever, silently.
- **waitForCurrentTick()** (`src/domain/ingesta/scheduler.ts`) - Resolves immediately if no tick is
  in flight, or when the current one finishes. What makes the ordered shutdown possible without
  relying on `cron.stop()` to wait for anything — it does not.
- **scheduleTick()** (`src/domain/ingesta/scheduler.ts`) - The two `POLL_ENABLED` branches: calls
  `cron.schedule()` with `config.poll.cron` and returns the `ScheduledTask`, or logs the disabled
  message and returns `undefined` without scheduling anything. Never fires an immediate tick — the
  first one always waits for the cron's first real trigger.
- **createShutdownHandler()** (`src/shared/shutdown.ts`) - Builds the `SIGTERM`/`SIGINT` handler:
  stops the scheduled task (if any), awaits any in-flight tick without ever canceling it, closes the
  bus, and exits with code `0`. All four dependencies are injected, so the ordering is testable by
  calling the handler directly — no real OS signal, no real timer.
- **routeMail()** (`src/domain/ruteo/route-mail.ts`) - Pure decision tree that returns the mail's
  **intent** or its discard reason: a reply first (`intencion: 'comentario'`, before touching the
  slug), then `sin_slug`, then `intencion: 'alta'` with the slug lowercased. Since S-032 it does not
  resolve the project — the tick does, with `lookupTicket()`. Never throws, never logs, no I/O.
- **particionar()** (`src/domain/adjuntos/particionar.ts`) - First stage of the attachment pipeline:
  resolves a generated filename/default MIME when missing, then evaluates the local policy in fixed
  order (0-byte → extension → MIME → max size) over the real `content.length`, never the declared
  `size`. Never throws.
- **deduplicar()** (`src/domain/adjuntos/dedup.ts`) - Second stage: deduplicates by sha256 checksum
  of `content`, keeping the first in mail order, with invocation-only scope (no state across mails).
- **aplicarTope()** (`src/domain/adjuntos/tope.ts`) - Third stage: keeps the first
  `MAX_ATTACHMENTS_PER_REQUIREMENT` (10, imported, never a literal) deduplicated attachments,
  rejecting the rest with `tope_excedido`.
- **procesarAdjuntos()** (`src/domain/adjuntos/procesar.ts`) - Composes the three stages in the one
  correct order (particionar → deduplicar → aplicarTope) and accumulates their rejections.
- **requestFileUpload()** (`src/domain/publicacion/upload-file.ts`) - Publishes
  `files.request-upload` for one accepted attachment and returns a typed `UploadResultado` —
  `concedido` (`fileId`/`uploadUrl`), `rechazado` (core's business `failure`, logged `warn`), or
  `fallido` (any other publication failure via `diagnosePublishFailure()`, logged `error`). Never
  throws for a rejection or a failure, never logs `uploadUrl`, never retries.
- **uploadFileContent()** (`src/domain/publicacion/upload-byte.ts`) - Direct `PUT` HTTPS of one
  attachment's byte to a prefigured `uploadUrl`, native `fetch` + `AbortSignal.timeout()`, no bus
  involved at all. Returns a typed `PutResultado` (`subido`/`fallido`), never throws, never logs
  `uploadUrl`, never retries.
- **procesarAdjuntosDelMail()** (`src/domain/publicacion/procesar-adjuntos-mail.ts`) - S-021's central
  orchestrator: composes `procesarAdjuntos()` + per-accepted-attachment `requestFileUpload()` →
  immediate `uploadFileContent()`, strictly serial (never `Promise.all`), never replenishing a
  `tope_excedido` excedente when a `PUT` fails. Wraps each attachment's full processing in its own
  `try/catch` to isolate an unexpected programming error without aborting the mail's remaining
  attachments. Never throws for a business outcome — always returns `{ fileIds, avisosDeRechazo,
  avisosDeFallo, placeholders }`. `requestFileUpload`/`uploadFileContent`/`lookupAttachmentByChecksum` are
  injectable via `deps` (default: the real implementations), same pattern as `Normalize` in
  `tick.ts`, so a test double can force the unexpected-exception path. **Since S-029 it takes an
  optional fourth argument**, `hilo?: ContextoHilo` (`{ requirementId }`): when present, each
  accepted attachment asks `lookupAttachmentByChecksum()` **before** requesting the upload permit,
  and a match short-circuits the whole upload cycle. **Its absence is the mechanism** by which the
  new-mail branch never queries (CA-5) — an object is passed whole or not at all, so
  `{ requirementId: undefined }` is not representable, and there is no `if (esRespuesta)` and no
  flag to get wrong.
- **lookupAttachmentByChecksum()** (`src/domain/publicacion/lookup-attachment.ts`) - S-029's reuse
  query, and the **first and only read** the connector performs — `attachments.list` over
  `jiku-queries`, which **partially derogates** an ADR-003 Implementation Rule (see
  `overview.md`; the ADR text rewrite belongs to S-030). Asks whether one accepted attachment's
  `checksum` is **already linked to the thread's Requirement by the connector itself**, and returns
  the existing `fileId` so the upload cycle can be skipped entirely. Returns a two-variant
  discriminated union — `{ tipo: 'reusado', fileId }` / `{ tipo: 'sin_match' }` — with **no error
  variant at all** and **never throws**: it lives inside an attachment loop that cannot be
  interrupted, so every failure degrades to `sin_match` and the attachment simply uploads as it did
  before. Reuses `diagnosePublishFailure()`/`codeOf()` **without adding a single branch**.

- **openKvSpace()** (`src/infra/kv/space.ts`) - Opens the connector's **KV Space** (its
  per-identity space inside the shared `JIKU_KV` bucket) with `client.kv()` **once**, over the
  process's single connection — the only place in `src/` that calls it. Logs `info` `'espacio KV
  abierto'` with `bucket` and `kvPrefix` (never a field named `key`). On failure throws
  `KvSpaceUnavailableError`, diagnosed by the SDK's class. Never creates the bucket.

- **lookupTicket()** (`src/infra/kv/tickets.ts`) - Resolves a slug to its `projectId` with **one**
  `get('tickets.<slug>')`, **one attempt, no cache**, before the attachments are processed. Returns a
  three-state union: found, not-there (`slug_no_mapeado`: never loaded, deleted, malformed value, or a
  slug that cannot be a key — this last one with no round-trip) and could-not-query
  (`slug_no_consultable`, with a `warn` carrying `slug` and `errorClass`). **Never throws.**

- **recordThreadEntry()** (`src/infra/kv/threads.ts`) - Writes the Thread Map entry
  `hilos.<sha256(raw Message-Id)> → requirementId` on the KV Space, after a create and after a
  successful comment. **Never throws**: a rejected `put()` (including `JikuBucketFull`) is absorbed
  with a single `warn` carrying `{ messageId, messageIdHash, requirementId, errorClass }` — the
  requirement already exists and there is no compensating command, so `creados` is never reverted.
  The value is the integer as **text**; the `put()` takes no options (no TTL: entries never expire).
- **lookupThread()** (`src/infra/kv/threads.ts`) - Walks `referenceIds` **in the order received**,
  sequentially, doing `space.get(threadKey(refId))` on each, and **stops at the first valid hit**.
  Returns a discriminated union with **three** states — found, not-found-but-queryable, and
  **could-not-query** — the distinction between `hilo_desconocido` and `es_respuesta`. **Never
  throws.** `undefined` from `get()` is "not there" and the walk continues; a malformed value is
  skipped with a `warn`; a rejected `get()` **stops**. An empty `referenceIds` costs **zero**
  round-trips. **Never `Promise.all`.**

- **publishCommentFromMail()** (`src/domain/publicacion/publish-comment.ts`) - The connector's
  **third** and last write command (`requirements.{id}.comment`, S-027): publishes a client's mail
  reply as a **public** comment on the requirement its thread resolved to. Sets `visibilityLevel`
  **explicitly** even though the contract makes it optional — the contract's default is `internal`,
  which is the opposite of what is needed, and core would answer `success` either way, so omitting it
  would silently produce a comment **the client cannot see**. The `{id}` travels in the `method`, not
  in a hand-built subject; the SDK derives the subject. **Reuses `diagnosePublishFailure()` unchanged**
  rather than adding branches for `requirement_not_found` / `file_not_owned`: those fall into
  `core_rechazo_desconocido` on purpose, because a second copy of core's growing code catalogue would
  be the one that goes stale.

See full details in [services.md](./services.md)

## Test Helpers

**Total: 16**

- **setupTestBus** (`test/bus/helpers.ts`) - Opens a NATS connection against the suite's shared
  container and builds a bus `Client` with `Client.fromConnection()`, returning a context with
  `cleanup()`.
- **createLogCapture** (`test/shared/log-capture.ts`) - In-memory `DestinationStream` for the logger,
  exposing the emitted lines both parsed (`lines()`) and raw (`raw()`) so a test can assert on the
  **serialized** line. Needed by S-004 and S-005 for their own diagnostic lines.
- **startAuthenticatedNats** (`test/bus/auth-helpers.ts`) - Starts a NATS container with `--auth`, so a
  wrong token yields a **real** `Authorization Violation`. Read its notes: it does **not** exercise the
  auth-callout, the `internal-app` role, or the real inbox prefix.
- **startJetStreamNats** (`test/infra/kv/helpers.ts`) - Starts a NATS container **with `-js`** (on a
  **different image tag** than the shared one, so `shared-container.test.ts`'s `ancestor=` count
  never sees it — read its comment: that is not a version decision) and creates `JIKU_KV` with the
  stream configuration of the SDK's own integration test (`allow_direct: true`, no TTL). Exposes
  `client`, `createBucket(overrides?)`, `deleteBucket()`, `bucketExists()`, `bucketConfig()`,
  `lastSequences(filter?)` and `spaceFor(userId)` — a **fresh space of another identity** per test,
  which replaces the old bucket-per-test (the SDK's `KV` lists no keys). The module-level
  `createBucket(connection, overrides?)` is the **only** place in the repo that creates a bucket
  (`STREAM.CREATE`) — production code never does. Rewritten in S-032 without `Kvm`; S-033 added
  `bucketConfig()` (assert the connector did not fix a bad bucket) and `lastSequences()` (every key
  written, by last sequence, read from the stream since the SDK cannot list).
- **startPermissionedJetStreamNats** (`test/infra/kv/permission-helpers.ts`) - A JetStream NATS with
  **static user permissions** (`deploy`, `sin-grants`, `solo-info`) and `JIKU_KV` created by `deploy`
  through `createBucket()` (S-033). The first test of a real server denying the KV Space's grants.
  Does **not** exercise the auth-callout or the real `internal-app` template.
- **operatorTicketKey / operatorPut / operatorDel / readmeTicketTemplate** (`test/infra/kv/operator.ts`)
  - What U-02 does with the NATS CLI: the full key built from the **README's template** and the
  startup line's `kvPrefix`, written as `nats kv put`/`nats kv del` over the raw connection. The only
  place a `$KV.JIKU_KV.…` subject is built by hand, on purpose (S-033).
- **fakeKvSpace** (`test/ingesta/fake-kv-space.ts`) - An in-memory double of the KV Space for the tick
  suites that are **not** about the KV (replaces `fakeThreadsKv`, S-032). Seeded with right-hand keys
  (`{ 'tickets.alfa': '42' }`, `threadKey(id)`), `get()` resolves `undefined` or a `KVEntry` with a
  `Uint8Array` value, like the SDK's `KV`, and `puts`/`gets` make the **absence** of a round-trip
  assertable.
- **spyOnSpace / withFailingGet / withFailingPut** (`test/infra/kv/space-doubles.ts`) - Wrappers of a
  `KvSpace` (real or fake): a spy that records the keys read and written, and the same space with a
  `get()` or `put()` that rejects (by default with the SDK's timeout, a `JikuError`). Plain objects
  that delegate — never a `Proxy`, which breaks on the SDK `KV`'s private fields.
- **switchableSpace / withEntryCreated** (`test/infra/kv/space-doubles.ts`) - A controlled KV outage
  on **the same object** (`down()`/`up()`: `get()` and `put()` reject, then delegate again), and a
  space that returns every entry with `created` back-dated, recording each read so a test can prove
  the double was used (S-033).
- **fakeTokenSource / rotatingTokenSource / failingTokenSource** (`test/bus/auth-helpers.ts`) -
  `TokenSource` doubles at the edge for the connection tests, since the real `ServiceUser` would call
  Zitadel.
- **generateServiceAccountKeyFile / writeRawKeyFile** (`test/bus/auth-helpers.ts`) - Writes a
  `ServiceAccountKey` JSON with a **real** RSA private key, plus its invalid variants.
- **runImage / inImage** (`test/docker-image.test.ts`) - Runs the built production image as a real
  container with an **explicit** environment (one `-e` per variable, nothing inherited from the host),
  and runs a shell command inside it for filesystem inspections. `spawnSync`, not `execFileAsync`:
  most of these runs exit non-zero and `execFileAsync` would reject, hiding the very streams the
  assertion needs.
- **parseDockerfile / directiveLines / stageBlock / stageInstructions** (`test/dockerfile.test.ts`) -
  Line classifier for the `Dockerfile` (comment / directive / continuation) plus per-stage slicing.
  What makes it necessary: absence assertions must ignore comment lines, because the comments the
  packaging story *requires* mention `EXPOSE`, `HEALTHCHECK` and `npm install` to explain why they are
  not there. Per-stage slicing matters for the same reason: `npm ci` without `--omit=dev` is correct
  in `test` and `builder` and a defect in `production`.
- **respondTo** (`test/bus/responder.ts`) - The `core` double: subscribes to a command **on the real
  bus** with a **wildcard** subject and answers a prefabricated envelope. Exposes the observed subjects
  and payloads, a **message counter** (which is what proves "no retry", and since S-029 also proves
  the **absence** of a query), a mute mode for provoking `JikuTimeout`, and `stop()`. Never rebuild
  the subject by hand — see its notes.
- **respondToQuery** (`test/bus/responder.ts`) - The `core` double **for the read plane** (S-029):
  same interface as `respondTo()`, same shared attention loop (`attachResponder()`), but subscribed
  to `*.*.jiku-queries.v1.${method}`. **A separate function and not a `plane` parameter**, because
  the SDK keeps the two planes as separate subject tokens on purpose — two queue groups over
  overlapping subjects would deliver each message to *both* subscriptions and a plain `request()`
  would silently discard the second reply. Without it no test of the reuse query is writable at
  all.
- **testLoggerWithCapture** (`test/ingesta/test-logger.ts`) - A minimal valid `AppConfig` plus a real
  `createLogger()` wired to `createLogCapture()`, for tests that call `normalize(raw, logger)` and
  assert on what was logged.

See full details in [test-helpers.md](./test-helpers.md)

## Types

**Total: 40**

- **AppError** (`src/shared/errors/base.ts`) - Abstract base of the service's error hierarchy, with a
  public `code`, an `httpStatus` and optional non-sensitive `details`.
- **ConfigValidationError** (`src/config/errors.ts`) - Raised when the environment fails validation.
  Carries the complete list of offending variable names in `variables`.
- **AppConfig** (`src/config/index.ts`) - The process-wide configuration contract consumed by S-003,
  S-004, S-005, S-009 and S-011. Fourteen fields since S-017 added the `adjuntos` block alongside
  `imap`, `poll` and `ruteo`; the bus paths, the topology, and each of those whole blocks must never
  reach a log line.
- **ImapConfig** (`src/config/index.ts`) - The IMAP adapter's whole configuration (`host`, `port`,
  `user`, `password`), nested so S-009 receives it complete instead of four loose parameters.
- **PollConfig** (`src/config/index.ts`) - The tick's whole configuration (`cron`, `enabled`,
  `maxPerTick`), nested on the same criterion for S-010 and S-011.
- **RuteoConfig** (`src/config/index.ts`) - The routing's whole configuration (`subaddressPrefix`,
  `placeholderTitle`, `placeholderBody`), nested on the same criterion for S-013 and S-015. Since
  S-032 it has no `ticketMap`: the Ticket Map lives in the KV Space and is queried once per mail.
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
- **KvSpaceUnavailableError** (`src/infra/kv/errors.ts`) - The KV Space is not usable at startup
  (`KV_SPACE_UNAVAILABLE_ERROR`, renamed from `KvBucketMissingError` in S-032). Exposes `diagnosis`,
  `bucket` (always `JIKU_KV`), `subject` (only when the bus refused one), `errorClass` and `causes`
  (the **full** messages, so the missing grants travel) as fields. Has its **own** branch in
  `reportStartupFailure()`: the bus connection worked.
- **KvDiagnosis** (`src/infra/kv/errors.ts`) - What to fix, as a literal union: `'bucket_no_usable'`
  (no bucket, no `allow_direct`, or JetStream off — never suggests grants), `'kv_sin_permisos'`,
  `'desconocido'` (legitimate, never mapped to another cause).
- **diagnoseKvFailure()** (`src/infra/kv/errors.ts`) - Classifies a `client.kv()` failure by
  `instanceof` against the SDK's `JikuNoBucket` and `JikuKVPermissionDenied` (main entry) — **never**
  by the message text, the `name` or a `code`.
- **KvSpace** (`src/infra/kv/space.ts`) - `Pick<KV, 'get' | 'put'>`: the KV Space handle that travels
  by parameter. Structural (the SDK's `KV` is nominal: private ES fields), so test doubles satisfy
  it, and without `delete()`, which the connector never calls.
- **TicketLookupResult** (`src/infra/kv/tickets.ts`) - `lookupTicket()`'s outcome, three states on the
  model of `ThreadLookupResult`: `{ found: true, projectId }`, `{ found: false, consultable: true }`
  (→ `slug_no_mapeado`) and `{ found: false, consultable: false }` (→ `slug_no_consultable`).
- **ThreadLookupResult** (`src/infra/kv/threads.ts`) - The outcome of a Thread Map lookup, as a
  discriminated union of **three** states: `{ found: true, requirementId }`,
  `{ found: false, consultable: true }` (queried, no match) and
  `{ found: false, consultable: false }` (could not query). All three are typed return values —
  none is an exception. The third state is what lets the caller tell `hilo_desconocido` ("this reply
  points at a thread I don't know") from `es_respuesta` ("I couldn't find out which thread it points
  at").
- **NewRequirementPayload** (`src/domain/publicacion/requirement.types.ts`) - The `requirements.new`
  payload, **inferred** from the schema with `z.infer`. The SDK exports no type for this command, so
  the schema is the only definition of the contract in the repo.
- **NewRequirementReply** (`src/domain/publicacion/requirement.types.ts`) - The validated success
  reply. Exists because `command<T>()` does not validate `data` against `T`.
- **PublishDiagnosis** (`src/domain/publicacion/publish-errors.ts`) - Which system refused the
  publication, as a literal union of nine values. `'desconocido'` is legitimate and is never mapped.
- **PublishError** (`src/domain/publicacion/publish-errors.ts`) - A failed publication. Exposes
  `diagnosis`, `sdkErrorClass`, `errorCode`, `hint`, `coreMessage` and `planoDeEscrituraAbierto` as
  fields, plus `logContext(projectId)` which builds the flat log context and omits absent fields.
- **RequirementValidationError** (`src/domain/publicacion/verification-payload.ts`) - The payload
  failed the command contract. Carries the invalid field **paths**, never their values.
- **CoreResponder** (`test/bus/responder.ts`) - What `respondTo()` returns: observed subjects and
  payloads, the message counter, and `stop()`.
- **IncomingMail** (`src/domain/ingesta/types.ts`) - The stable working form a raw mail is normalized
  to: `messageId`, `referenceIds`, `recipient`, `senderEmail`, `subject`, `body`, `attachments`. Only
  `messageId` is mandatory.
- **MailAttachment** (`src/domain/ingesta/types.ts`) - One attachment mapped without filtering by
  `Content-Disposition`. No `checksum` field (FG-4 territory).
- **MissingMessageIdError** (`src/domain/ingesta/errors.ts`) - Thrown by `normalize()` for a mail
  without `Message-Id`. `code: 'SIN_MESSAGE_ID'` mirrors the closed-catalog discard reason
  `sin_message_id` from ADR-006.
- **MailSource / RawMessage** (`src/domain/ingesta/ports.ts`) - The domain port isolating the tick
  from the concrete IMAP client: `searchUnseen()` (untruncated total), `fetch(uid)` (throws on
  failure), `markSeen(uid)` (single UID, no batch variant). `domain/` depends only on this; the
  adapter lives under `infra/imap/`.
- **ImapConnectError / ImapConnectDiagnosis** (`src/infra/imap/errors.ts`) - A failed IMAP
  connect/open, diagnosed by structure (constructor name, `errno` codes) never by message text —
  `message`/`details` never carry the password or user.
- **diagnoseImapConnectFailure()** (`src/infra/imap/errors.ts`) - Classifies an `imapflow` connect
  failure into `'credenciales_invalidas' | 'host_inalcanzable' | 'desconocido'`.
- **TickCounters** (`src/domain/ingesta/tick.ts`) - The five counters (`ingestados`, `parseados`,
  `creados`, `descartados`, `fallidos`) a tick emits in one line, always. Must live outside the
  `try` so a `finally` can emit it even when the tick fails.
- **ShutdownDeps** (`src/shared/shutdown.ts`) - The four injected dependencies of the ordered
  shutdown handler (`scheduledTask`, `waitForCurrentTick`, `closeBus`, `exit`), all received by
  parameter so `createShutdownHandler()` never imports `node:process` or the bus connection module
  directly.
- **MotivoDescarte** (`src/shared/motivo-descarte.ts`) - The closed catalog of the **seven** discard
  reasons, as a string-literal union (never a `enum`), in the single place both `ingesta` and `ruteo`
  can import from without either depending on the other. S-032 added `slug_no_consultable` ("fix the
  KV"), distinct from `slug_no_mapeado` ("load the slug").
- **RouteResult** (`src/shared/motivo-descarte.ts`) - `routeMail()`'s return type: an intent
  (`{ ok: false, intencion: 'alta', slug }` or `{ ok: false, intencion: 'comentario' }`) or a discard
  `motivo` with an optional `slug` key. Since S-032 there is no resolved variant: the tick resolves the
  `alta` intent with `lookupTicket()`.
- **AdjuntosConfig** (`src/config/index.ts`) - The local attachment policy's whole configuration
  (`allowedExtensions`, `allowedMimeTypes`, `maxSizeBytes`, `putTimeoutMs`), nested on the same
  criterion as `ImapConfig`/`PollConfig`/`RuteoConfig`.
- **AdjuntoParticionado / AdjuntoAceptado / AdjuntoRechazado / ReglaRechazo / ParticionResult**
  (`src/domain/adjuntos/types.ts`) - The attachment pipeline's domain types: an attachment before
  and after its checksum is computed, the closed catalog of rejection rules (string-literal union),
  the exact three-field rejection entry, and the parameterized `{ aceptados, rechazados }` shape
  shared by all four pipeline functions.
- **FileUploadRequestPayload / FileUploadReply** (`src/domain/publicacion/files.types.ts`) - The
  `files.request-upload` payload and validated success reply, both **inferred** from
  `files.schema.ts` with `z.infer` — same criterion as `NewRequirementPayload`/`NewRequirementReply`.
- **FileUploadValidationError** (`src/domain/publicacion/files.types.ts`) - The
  `files.request-upload` payload failed the command contract. Carries the invalid field **paths**,
  never their values — same criterion as `RequirementValidationError`.
- **UploadResultado** (`src/domain/publicacion/files.types.ts`) - `requestFileUpload()`'s return
  type: a discriminated union on `tipo` — `concedido` (`fileId`, `uploadUrl`), `rechazado` (core's
  business `failure`, `codigo` only, no wrapped SDK error), `fallido` (any other publication
  failure, reusing `PublishDiagnosis` imported, never redeclared). `nombre`/`mime` match
  `AdjuntoRechazado`'s field names on purpose, so S-021 can treat both notice catalogs with the
  same shape.
- **PutResultado** (`src/domain/publicacion/upload-byte.ts`) - `uploadFileContent()`'s return type:
  a two-variant discriminated union on `tipo` (`subido`/`fallido`), named deliberately differently
  from `UploadResultado` — a distinct axis ("did the byte arrive"), not the bus-rejection axis.

See full details in [types.md](./types.md)

## Constants

**Total: 31**

- **SERVICE_NAME** (`src/shared/service-info.ts`) - The service name, used wherever the process has to
  identify itself.
- **MIN_TIMEOUT_MS** (`src/config/schema.ts`) - Floor for the command timeout, 15000 ms. A shorter
  timeout turns an explained error into a mute one.
- **DEFAULT_ISSUER** (`src/config/schema.ts`) - Default Zitadel issuer of this deployment. The SDK
  deliberately has no default for it.
- **DEFAULT_SERVERS_URL** (`src/config/schema.ts`) - Default bus endpoint. The SDK applies this one
  only at `connect()`, not at `loadConfig()`.
- **DEFAULT_IMAP_PORT** (`src/config/schema.ts`) - Default IMAP port, 993 (IMAPS).
- **DEFAULT_POLL_CRON** (`src/config/schema.ts`) - Default poll expression, `*/5 * * * *`, validated at
  startup with `node-cron`'s own `validate()`.
- **DEFAULT_POLL_MAX_PER_TICK** (`src/config/schema.ts`) - Default cap of mails per tick, 50.
- **DEFAULT_SUBADDRESS_PREFIX** (`src/config/schema.ts`) - Default subaddress prefix the project slug
  is extracted from, `tickets`. Declared by S-012, consumed by S-013.
- **DEFAULT_PLACEHOLDER_TITLE** (`src/config/schema.ts`) - Default title for a mail with no subject,
  `Ticket recibido por mail`. Its literal is deliberately not quoted in `EXPECTATIONS` — see the note
  in `constants.md`.
- **DEFAULT_PLACEHOLDER_BODY** (`src/config/schema.ts`) - Default body for a mail with no content,
  `(mail sin contenido)`.
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
- **TITLE_MAX_LENGTH** (`src/domain/publicacion/requirement.schema.ts`) - 255, the `varchar` limit of
  Jiku's column. The contract declares no `maxLength`. Exported because **FG-3 needs it to truncate**;
  here it only validates.
- **VERIFY_TITLE / VERIFY_DESCRIPTION** (`src/domain/publicacion/verification-payload.ts`) - The code
  literals of the verification requirement. Their text says they are a deployment check, because the
  requirement **stays forever**: there is no compensating command.
- **VERIFY_TYPE / VERIFY_PRIORITY / VERIFY_VISIBILITY_LEVEL**
  (`src/domain/publicacion/verification-payload.ts`) - The connector's defaults: `incidencia`,
  `sin_prioridad`, `public`. They are policy of the connector, not of the contract, which is why they
  live here and not as schema defaults.
- **REQUIREMENT_TYPES / REQUIREMENT_PRIORITIES / REQUIREMENT_VISIBILITY_LEVELS**
  (`src/domain/publicacion/requirement.schema.ts`) - The contract enums, verbatim.
- **REMEDIES** (`src/domain/publicacion/publish-errors.ts`) - What to check for each diagnosis. Each
  text names **the system** and **the fix**; the bus one says it implies nothing about `core`, the
  shape ones say they prove the write plane is open, and the role one says reconnecting fixes it.
- **MUTE** (`test/bus/responder.ts`) - Responder mode that receives and does not answer, to provoke
  `JikuTimeout` without waiting 15 s.
- **DEFAULT_ALLOWED_EXTENSIONS / DEFAULT_ALLOWED_MIME_TYPES** (`src/config/schema.ts`) - Default
  comma-separated allow-lists of the local attachment policy: a broad office/image set.
- **DEFAULT_MAX_ATTACHMENT_SIZE_BYTES** (`src/config/schema.ts`) - Default max attachment size, 10
  MB in bytes. Evaluated against the real `Buffer` length, never the declared `size`.
- **DEFAULT_PUT_TIMEOUT_MS** (`src/config/schema.ts`) - Default timeout for the attachment byte's
  `PUT`, 30000 ms. Not consumed by S-017; declared here for S-019.
- **MAX_ATTACHMENTS_PER_REQUIREMENT** (`src/config/schema.ts`) - The fixed cap of attachments per
  requirement, 10. Not an env var — the bus contract's `maxItems` (ADR-003), fixed in code.
- **TICKETS_KEY_PREFIX / THREADS_KEY_PREFIX** (`src/infra/kv/keys.ts`) - `'tickets.'` and `'hilos.'`,
  the right-hand prefixes of the two maps in the KV Space. Code constants, never configuration:
  changing them would orphan every loaded entry.

See full details in [constants.md](./constants.md)

## Validators

**Total: 5**

- **envSchema** (`src/config/schema.ts`) - Zod shapes of the twenty-four environment variables in
  scope (S-032 removed the four `KV_*`), with their defaults and the timeout floor. The source of truth for the `Env` type. S-017
  added the four attachment-policy variables (`ATTACHMENT_ALLOWED_EXTENSIONS`,
  `ATTACHMENT_ALLOWED_MIME_TYPES`, `ATTACHMENT_MAX_SIZE_BYTES`, `PUT_TIMEOUT_MS`), all with defaults
  and none cross-field.
- **newRequirementSchema** (`src/domain/publicacion/requirement.schema.ts`) - The `requirements.new`
  payload contract: six fields, **`.strict()`** so a stray `actor` **fails** instead of being silently
  dropped, and no `.default()` on the enums (the schema models `core`'s contract, not the connector's
  policy).
- **newRequirementReplySchema** (`src/domain/publicacion/requirement.schema.ts`) - The success reply,
  `{ id }`. Deliberately **not** `z.coerce`, and `.loose()` so a field `core` starts sending tomorrow
  does not break the connector.
- **fileUploadRequestSchema** (`src/domain/publicacion/files.schema.ts`) - The `files.request-upload`
  payload contract: exactly four fields (`fileName`, `mimeType`, `fileSize`, `checksum`),
  **`.strict()`** so a stray `uploader`/`actor` **fails** instead of being silently dropped.
- **fileUploadReplySchema** (`src/domain/publicacion/files.schema.ts`) - The success reply,
  `{ fileId, uploadUrl }`. `uploadUrl` is `z.string().min(1)`, deliberately **not**
  `z.string().url()` (a signed S3 URL's query params can trip URL validators), and `.loose()` so a
  field `core` starts sending tomorrow does not break the connector.

See full details in [validators.md](./validators.md)
