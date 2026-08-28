# Reusable Code - jiku-mail-connector

This document lists all reusable code available in this service. Each category has its own file with
detailed documentation.

Created by S-001 (bootstrap), extended by S-002 (typed configuration), S-003 (structured logging with
redaction), S-004 (identity and the single bus connection), S-005 (publishing `requirements.new` and
translating its errors), S-008 (pure mail normalization), S-009 (the `MailSource` port and its
`imapflow` adapter) and S-010 (the tick: cap, order, marking and failure isolation). The service is a
`worker` in Node.js with no HTTP surface and no database, so several categories do not apply and stay
empty until a story creates them.

## Components

N/A (Backend service)

## Utils/Helpers

**Total: 6**

- **cleanSubject()** (`src/domain/ingesta/subject.ts`) - Strips `Re:`/`Fwd:`/`RV:` prefixes
  iteratively and case-insensitively. An all-prefix subject is left as `''`, a valid state.
- **mergeReferenceIds()** (`src/domain/ingesta/headers.ts`) - Deduplicated union of `In-Reply-To`
  and `References`, in order of appearance, tolerating `references` as `string`, `string[]` or
  `undefined`.
- **pickRecipient()** (`src/domain/ingesta/headers.ts`) - First `Delivered-To`, `To` as fallback,
  `''` if neither. Deliberately does **not** join multiple `Delivered-To` values with `', '`.
- **extractSenderEmail()** (`src/domain/ingesta/headers.ts`) - Isolates the address from a
  `Nombre <mail>` display-name `From` header.
- **toPlainText()** (`src/domain/ingesta/body.ts`) - Plain text part when present, or the HTML part
  converted with `html-to-text` when that is the only one. Requires `skipHtmlToText: true` at parse
  time or its branch selection breaks silently.
- **trimQuotedText()** (`src/domain/ingesta/body.ts`) - Best-effort trim of quoted thread text by
  five markers. Ported unchanged from the service in production; never reinvented.

See full details in [utils.md](./utils.md)

## Middlewares

N/A (no HTTP surface - ADR-001)

## Services/Repositories

**Total: 15**

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

See full details in [services.md](./services.md)

## Test Helpers

**Total: 9**

- **setupTestBus** (`test/bus/helpers.ts`) - Opens a NATS connection against the suite's shared
  container and builds a bus `Client` with `Client.fromConnection()`, returning a context with
  `cleanup()`.
- **createLogCapture** (`test/shared/log-capture.ts`) - In-memory `DestinationStream` for the logger,
  exposing the emitted lines both parsed (`lines()`) and raw (`raw()`) so a test can assert on the
  **serialized** line. Needed by S-004 and S-005 for their own diagnostic lines.
- **startAuthenticatedNats** (`test/bus/auth-helpers.ts`) - Starts a NATS container with `--auth`, so a
  wrong token yields a **real** `Authorization Violation`. Read its notes: it does **not** exercise the
  auth-callout, the `internal-app` role, or the real inbox prefix.
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
  and payloads, a **message counter** (which is what proves "no retry"), a mute mode for provoking
  `JikuTimeout`, and `stop()`. Never rebuild the subject by hand — see its notes.
- **testLoggerWithCapture** (`test/ingesta/test-logger.ts`) - A minimal valid `AppConfig` plus a real
  `createLogger()` wired to `createLogCapture()`, for tests that call `normalize(raw, logger)` and
  assert on what was logged.

See full details in [test-helpers.md](./test-helpers.md)

## Types

**Total: 22**

- **AppError** (`src/shared/errors/base.ts`) - Abstract base of the service's error hierarchy, with a
  public `code`, an `httpStatus` and optional non-sensitive `details`.
- **ConfigValidationError** (`src/config/errors.ts`) - Raised when the environment fails validation.
  Carries the complete list of offending variable names in `variables`.
- **AppConfig** (`src/config/index.ts`) - The process-wide configuration contract consumed by S-003,
  S-004, S-005, S-009 and S-011. Twelve fields since S-007 added the `imap` and `poll` blocks; the
  bus paths, the topology and the whole `imap` block must never reach a log line.
- **ImapConfig** (`src/config/index.ts`) - The IMAP adapter's whole configuration (`host`, `port`,
  `user`, `password`), nested so S-009 receives it complete instead of four loose parameters.
- **PollConfig** (`src/config/index.ts`) - The tick's whole configuration (`cron`, `enabled`,
  `maxPerTick`), nested on the same criterion for S-010 and S-011.
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

See full details in [types.md](./types.md)

## Constants

**Total: 22**

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

See full details in [constants.md](./constants.md)

## Validators

**Total: 3**

- **envSchema** (`src/config/schema.ts`) - Zod shapes of the seventeen environment variables in scope,
  with their defaults and the timeout floor. The source of truth for the `Env` type. S-007 added the
  four `IMAP_` and three `POLL_` variables and made the three IMAP credentials **required**; only the
  ticket-map ones remain undeclared.
- **newRequirementSchema** (`src/domain/publicacion/requirement.schema.ts`) - The `requirements.new`
  payload contract: six fields, **`.strict()`** so a stray `actor` **fails** instead of being silently
  dropped, and no `.default()` on the enums (the schema models `core`'s contract, not the connector's
  policy).
- **newRequirementReplySchema** (`src/domain/publicacion/requirement.schema.ts`) - The success reply,
  `{ id }`. Deliberately **not** `z.coerce`, and `.loose()` so a field `core` starts sending tomorrow
  does not break the connector.

See full details in [validators.md](./validators.md)
