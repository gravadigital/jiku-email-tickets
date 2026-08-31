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
bus settings the SDK resolves. Consumed by S-003 (logger), S-004 (bus adapter), S-005 (publishing),
and — through the two nested blocks S-007 added — S-009 (IMAP adapter) and S-011 (scheduler).

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
  imap: ImapConfig;   // added by S-007
  poll: PollConfig;   // added by S-007
  ruteo: RuteoConfig; // added by S-012
}

interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

interface PollConfig {
  cron: string;
  enabled: boolean;
  maxPerTick: number;
}

interface RuteoConfig {
  ticketMap: ReadonlyMap<string, number>;
  subaddressPrefix: string;
  placeholderTitle: string;
  placeholderBody: string;
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

**Thirteen fields since S-012:** the ten flat ones plus the three nested blocks. `ImapConfig`,
`PollConfig` and `RuteoConfig` are nested rather than eleven loose fields because each consumer
receives its whole configuration: with loose fields every new signature would enumerate four
parameters and every consumer would have to recompose its own subset.

`RuteoConfig.ticketMap` arrives **already normalized and validated** — `loadAppConfig()` transforms
nothing, it only composes; all the loading lives in the schema. Its type is `ReadonlyMap` and not
`Map`, and that is the whole guarantee: the Map the schema builds is mutable, and `Object.freeze`
would not freeze it anyway. What stops a consumer from calling `.set()` is the type of the contract,
not the runtime — so loosening it to `Map` is a real regression, and `tsc` is where it gets caught.

**Fields that must never reach a log line:** `credsFile` and `keyFile` (paths to secrets — where a
secret lives is information about the secret), `zitadelProjectId` and `servers` (deployment topology),
the whole `imap` block, `imap.password` above all, and the whole `ruteo` block — `ticketMap` is the
deployment's **commercial topology**, the `projectId` of every enabled client, and has no business in
stdout. The startup line in `src/startup.ts`
deliberately carries only `instance`, `logLevel` and `timeoutMs`.

**The nesting carries a hazard, and it is closed by a rule rather than by a redaction path.**
`imap.password` sits **three** levels deep if anyone logs the whole `AppConfig` inside a context, and
Pino's `redact.paths` has **no deep wildcard** — at that depth the secret would come out **in the
clear, without failing and without warning**. The defence is not to extend `REDACT_PATHS` (it would be
endless and always one level behind) but the structural rule: **no log point emits the whole
`AppConfig`**, asserted by a property test in `test/config/source-properties.test.ts` that scans every
log call in `src/`. `test/shared/log-redaction.test.ts` documents the real boundary: root and one
level are censored, three levels are not.

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

---

## NewRequirementPayload

**Location:** `src/domain/publicacion/requirement.types.ts`

**Description:** The `requirements.new` payload type, **inferred** from the schema.

**Signature:**

```ts
type NewRequirementPayload = z.infer<typeof newRequirementSchema>;
```

**Notes:**

- Inferred and never hand-written: the `validation` convention requires it, and the reason is concrete
  — the SDK exports no type for this command, so the schema is the only definition of the contract in
  the repo. A parallel hand-written type could diverge from the schema without anything failing, and
  then the compiler would assert one shape while another travelled to the bus.

---

## NewRequirementReply

**Location:** `src/domain/publicacion/requirement.types.ts`

**Description:** The validated success reply of the command.

**Signature:**

```ts
type NewRequirementReply = z.infer<typeof newRequirementReplySchema>;
```

---

## PublishDiagnosis

**Location:** `src/domain/publicacion/publish-errors.ts`

**Description:** Which system refused the publication, and therefore where the fix is.

**Signature:**

```ts
type PublishDiagnosis =
  | 'rechazo_del_bus_por_subject'   // THE BUS, by subject, before core saw anything. Zitadel.
  | 'bus_sin_endpoint'              // THE BUS: nothing is subscribed. Said immediately.
  | 'error_de_armado_del_conector'  // THE CONNECTOR: rejected locally, nothing reached the wire.
  | 'core_rechazo_por_rol'          // core, by ROLE. Typically the missing `users` row.
  | 'core_rechazo_por_forma'        // core, by SHAPE. The payload or the project.
  | 'core_rechazo_desconocido'      // core refused with a code this connector does not know.
  | 'nada_respondio'                // Nobody answered within the timeout.
  | 'respuesta_ilegible'            // core said success and the reply has no usable id.
  | 'desconocido';                  // Not an SDK error. Logged as such, never mapped.
```

**Notes:**

- A literal union rather than loose strings, so the `REMEDIES` record is exhaustive for the
  typechecker when a tenth case is added.
- `'core_rechazo_por_forma'` covers **two** codes (`invalid_fields` and `project_not_found`) on
  purpose: same axis of diagnosis (`core` accepted the caller and refused the shape) and same
  operational message (the write plane is open). What distinguishes them — the `projectId` — travels
  in the `code` and in the log context, not in the diagnosis.
- `'desconocido'` is a legitimate result and is **never** mapped to another value.

---

## PublishError

**Location:** `src/domain/publicacion/publish-errors.ts`

**Description:** A failed publication of `requirements.new`.

**Signature:**

```ts
class PublishError extends AppError {
  readonly code = 'PUBLISH_ERROR';
  readonly httpStatus = 500;
  readonly diagnosis: PublishDiagnosis;
  readonly sdkErrorClass: string;
  readonly errorCode: string | undefined;
  readonly hint: string | undefined;
  readonly coreMessage: string | undefined;
  readonly planoDeEscrituraAbierto: boolean;
  logContext(projectId: number): Record<string, unknown>;
}
```

**Notes:**

- Exposes the diagnosis as a **field**, not only inside the message — imitating `BusConnectError` from
  S-004. That is what lets the log point and the tests assert on **structure** instead of captured
  text, and therefore what lets the message be rewritten without breaking any test.
- `planoDeEscrituraAbierto` is **positive information**: if `core` answered at all, the bus let the
  command through and this identity has permission on the subject. It travels as a boolean field
  rather than buried in prose.
- `logContext()` builds a **flat, one-level** context, because S-003's redaction has no deep wildcard:
  a nested context would leave a secret in the clear without failing or warning.
- It **omits** `code`, `hint` and `errorMessage` when they are `undefined`, with a conditional spread.
  It never logs `hint: null`: that is noise in a line read for diagnosis, and it suggests the SDK
  answered something when it answered nothing. The absence of `code` is itself information — it means
  `core` never answered.
- The log key is **`code`** while the class field is **`errorCode`**, and the asymmetry is deliberate:
  in the log, `code` is the code `core` sent — the field that cross-references `core`'s own log, which
  calls it that — whereas `PublishError.code` is the constant `PUBLISH_ERROR` and adds nothing to a
  line that already carries `diagnosis`.
- **Neither the message nor any field carries the payload, the title or the description.** Verified
  reason: `REDACT_PATHS` covers `text`, `content` and `body` but **not** `title` or `description`. In
  this story they are code literals so there would be no leak; in FG-3 the payload derives from the
  mail and there would be. The rule is established here, while it is free.

---

## RequirementValidationError

**Location:** `src/domain/publicacion/verification-payload.ts`

**Description:** The payload did not satisfy the command contract.

**Signature:**

```ts
class RequirementValidationError extends AppError {
  readonly code = 'REQUIREMENT_VALIDATION_ERROR';
  readonly httpStatus = 500;
  readonly invalidFields: string[];
}
```

**Notes:**

- Carries the **paths** of the invalid fields, never their values. The distinction is security, not
  tidiness: in FG-3 those values are mail content, and `title`/`description` are not redacted.
- This is why `parseNewRequirement()` uses `safeParse` and not `parse`: with `parse` the raw `ZodError`
  escapes, and its `message` carries the rejected values.

---

## CoreResponder

**Location:** `test/bus/responder.ts`

**Description:** What `respondTo()` returns: the observed subjects and payloads, the message counter,
and `stop()`.

**Signature:**

```ts
interface CoreResponder {
  subjects(): string[];
  payloads(): unknown[];
  count(): number;
  stop(): Promise<void>;
}
```

---

## IncomingMail

**Location:** `src/domain/ingesta/types.ts`

**Description:** The stable working form a raw RFC 822 mail is normalized to. Only `messageId` is
mandatory; every other field has a valid empty state (`''` or `[]`) and normalizing never fails
because one of them is empty. No Zod schema by design: the real boundary is `mailparser`, which
already returns a typed structure, and this is an internal output shape nobody deserializes.

**Interface:**

```ts
interface IncomingMail {
  readonly messageId: string;
  readonly referenceIds: string[];
  readonly recipient: string;
  readonly senderEmail: string;
  readonly subject: string;
  readonly body: string;
  readonly attachments: MailAttachment[];
}
```

**Notes:** `senderEmail` is read by no consumer in v1 and must never reach a log line.
`subject`/`recipient`/`senderEmail` are deliberately **not** in `REDACT_PATHS` — ADR-006 requires
`messageId`/`projectId`/`slug` to be loggable, and the slug comes from `recipient`; protection for
these three is by omission at each log call site, not by redaction.

---

## MailAttachment

**Location:** `src/domain/ingesta/types.ts`

**Description:** One mail attachment, mapped from `mailparser`'s output without filtering by
`Content-Disposition` — an inline image is treated the same as a regular attachment in v1.

**Interface:**

```ts
interface MailAttachment {
  readonly filename: string;
  readonly mimeType: string; // declared by the mail, never verified against content
  readonly size: number;
  readonly content: Buffer;
  readonly contentDisposition: string;
  readonly contentId?: string;
}
```

**Notes:** No `checksum` field — `mailparser` exposes one (MD5) but it is deliberately not
propagated; adding one is out of scope (FG-4). `content` is redacted by `REDACT_PATHS`
(`attachments[*].content`); `filename`, `mimeType` and `size` are safe to log in clear.

---

## MissingMessageIdError

**Location:** `src/domain/ingesta/errors.ts`

**Description:** Thrown by `normalize()` when the mail has no `Message-Id` header. This is a
**discard** with a known reason, distinct from a parse failure — the caller (the tick, S-010) counts
`descartados` vs. `fallidos` differently, and distinguishing them by error **class** is what lets it
do so without parsing text.

**Signature:**

```ts
class MissingMessageIdError extends AppError {
  readonly code = 'SIN_MESSAGE_ID';
  readonly httpStatus = 500;
}
```

**Notes:** `code` mirrors the literal `sin_message_id`, one of the five closed-catalog discard
reasons ADR-006 enumerates. Do not invent a variant spelling.

---

## MailSource / RawMessage

**Location:** `src/domain/ingesta/ports.ts`

**Description:** The domain port that isolates the tick from the concrete IMAP client. Three
operations, not two — a two-operation `fetchUnseen(max): Promise<RawMessage[]>` shape cannot
satisfy the deferred-count `warn` (needs the untruncated total), one-at-a-time marking right after
each download, and skip-without-marking on a failed download, all at once. `domain/` depends only
on this port; the concrete adapter lives under `infra/imap/` (CA-11).

**Interface:**

```ts
interface RawMessage {
  readonly uid: number;
  readonly source: Buffer; // raw, unparsed RFC 822 bytes
}

interface MailSource {
  searchUnseen(): Promise<number[]>; // untruncated total, UID descending
  fetch(uid: number): Promise<RawMessage>; // throws on failure, never marks
  markSeen(uid: number): Promise<void>; // one UID at a time, no batch variant
}
```

**Notes:** No Zod schema — the real boundary is the IMAP client, whose shape this port itself
defines; there is no external deserialization to validate (same deviation criterion as
`IncomingMail` in S-008). The production implementation is `withMailSource()`'s assembled object in
`src/infra/imap/client.ts` (see services.md); tests inject a hand-written double, never a mock of
the `imapflow` module.

---

## ImapConnectError / ImapConnectDiagnosis / diagnoseImapConnectFailure()

**Location:** `src/infra/imap/errors.ts`

**Description:** A failed IMAP connect/open translated into a diagnosis-carrying `AppError`,
mirroring `BusConnectError`/`diagnoseConnectFailure()` in `infra/bus/errors.ts`. Classification is
by **structure** (the `imapflow` error's constructor name, `errno` codes), never by interpolating
the client's raw message text — so `message`/`details` never carry the password or user, in any
form.

**Signature:**

```ts
type ImapConnectDiagnosis = 'credenciales_invalidas' | 'host_inalcanzable' | 'desconocido';

function diagnoseImapConnectFailure(error: unknown): ImapConnectDiagnosis;

class ImapConnectError extends AppError {
  readonly code = 'IMAP_CONNECT_ERROR';
  readonly httpStatus = 500;
  readonly diagnosis: ImapConnectDiagnosis;
  readonly sdkErrorClass: string;
}
```

**Notes:** `'desconocido'` is a legitimate, un-mapped result (ADR-006) — never guessed into one of
the other two. `AuthenticationFailure` (by constructor name, not `instanceof`, for the same
cross-copy reason as the bus's diagnosis) maps to `credenciales_invalidas`; the standard Node
network `errno` codes (`ECONNREFUSED`, `ENOTFOUND`, etc.) map to `host_inalcanzable`.

---

## TickCounters

**Location:** `src/domain/ingesta/tick.ts`

**Description:** The five counters a tick emits in a single log line, always — with success or
failure. All in-memory, no persistence (ADR-001). `descartados` covers the five discard reasons
(the three `routeMail()` decides plus `MissingMessageIdError`, via S-014); `creados`/`fallidos`
(S-015) count the outcome of publishing `requirements.new` for a mail that resolved to a project —
a publication failure counts as `fallidos`, separate from a discard.

**Signature:**

```ts
interface TickCounters {
  ingestados: number;
  parseados: number;
  creados: number;
  descartados: number;
  fallidos: number;
}
```

**Notes:** Must be declared **outside** the `try` block of the function that uses it — that is what
lets a `finally` emit the line even if the code inside the `try` throws (the story's single
riskiest structural requirement: written the "natural" way, with counters inside the `try` and
emission at the end of the happy path, this silently fails to fire on error).

---

## ShutdownDeps

**Location:** `src/shared/shutdown.ts`

**Description:** The four dependencies `createShutdownHandler()` (S-011) takes by parameter, so the
ordered-shutdown module never imports `node:process` or the bus connection module directly and
stays trivially testable — every dependency is a double in a test, the real thing in production.

**Signature:**

```ts
interface ShutdownDeps {
  scheduledTask: { stop(): void | Promise<void> } | undefined;
  waitForCurrentTick: () => Promise<void>;
  closeBus: () => Promise<void>;
  exit: (code: number) => void;
}
```

**Notes:** `scheduledTask` is `undefined` when `POLL_ENABLED` was `false` — there was no
`cron.schedule()` call to produce a `ScheduledTask` to stop. The shutdown handler still runs its
full sequence in that case: no task to stop, but the bus still needs to close.

---

## MotivoDescarte

**Location:** `src/shared/motivo-descarte.ts`

**Description:** The closed catalog of the five discard reasons ADR-006 defines, as a string-literal
union — never a TypeScript `enum` — so the runtime values are exactly the lowercase strings the log
line must carry, with no indirection. Lives in `shared`, not in `domain/ruteo`: `ingesta/normalize.ts`
already produces two of the five (`no_parseable`, `sin_message_id`) and cannot import from `ruteo`
without inverting the dependency direction CA-1 protects, so both modules import this one instead of
either importing the other.

**Interface:**

```ts
type MotivoDescarte =
  | 'no_parseable'
  | 'sin_message_id'
  | 'es_respuesta'
  | 'sin_slug'
  | 'slug_no_mapeado';
```

**Notes:** Only the type is created here; `ingesta/normalize.ts`'s existing `'sin_message_id'`
literal is left as-is (it is already a compatible string). Wiring every producer to this type
explicitly is S-014's job, once the tick composes `ingesta` and `ruteo` together.

---

## AdjuntosConfig

**Location:** `src/config/index.ts`

**Description:** The local attachment policy's whole configuration (`allowedExtensions`,
`allowedMimeTypes`, `maxSizeBytes`, `putTimeoutMs`), nested on the same criterion as `ImapConfig` /
`PollConfig` / `RuteoConfig`: `particionar()` (S-017) receives it complete, or the `Pick` subset it
needs, instead of four loose parameters.

**Interface:**

```ts
interface AdjuntosConfig {
  allowedExtensions: readonly string[];
  allowedMimeTypes: readonly string[];
  maxSizeBytes: number;
  putTimeoutMs: number;
}
```

**Notes:** `putTimeoutMs` is not consumed by S-017 — it is declared here because it is the same
configuration extension, and S-019 (the `PUT` of the attachment byte) consumes it.

---

## AdjuntoParticionado / AdjuntoAceptado / AdjuntoRechazado / ReglaRechazo / ParticionResult

**Location:** `src/domain/adjuntos/types.ts`

**Description:** The pure pipeline's domain types (S-017). `AdjuntoParticionado` is an attachment
that passed the local policy but has no checksum yet (filename/mimeType already resolved with the
generated-name and default-MIME rules). `AdjuntoAceptado` extends it with `checksum` once
`deduplicar()` computes it. `ReglaRechazo` is the closed catalog of rejection rules
(`'extension' | 'mime' | 'tamano' | 'tamano_cero' | 'tope_excedido' | 'error_interno'`), a
string-literal union — never an `enum` — following the same precedent as `MotivoDescarte`.
`AdjuntoRechazado` is exactly `{ nombre, mime, regla }`, no extra fields. `ParticionResult<TAceptado>`
is the common `{ aceptados, rechazados }` shape shared by `particionar()`, `deduplicar()`,
`aplicarTope()` and `procesarAdjuntos()`, parameterized because `particionar()`'s accepted items
have no checksum yet while the later stages' do.

**Interface:**

```ts
interface AdjuntoParticionado {
  readonly filename: string;
  readonly mimeType: string;
  readonly content: Buffer;
}

interface AdjuntoAceptado extends AdjuntoParticionado {
  readonly checksum: string;
}

type ReglaRechazo =
  | 'extension' | 'mime' | 'tamano' | 'tamano_cero' | 'tope_excedido' | 'error_interno';

interface AdjuntoRechazado {
  readonly nombre: string;
  readonly mime: string;
  readonly regla: ReglaRechazo;
}

interface ParticionResult<TAceptado = AdjuntoAceptado> {
  readonly aceptados: TAceptado[];
  readonly rechazados: AdjuntoRechazado[];
}
```

**Notes:** No field is named `key` — `REDACT_PATHS` includes `'key'` and `'*.key'`, and a `key`
field would be redacted silently. `AdjuntoRechazado` is intentionally its own type, not an
extension of `MotivoDescarte`/`RouteResult`: those describe why a whole *mail* is discarded, this
describes why one *attachment* inside a mail that IS processed is rejected.

---

## RouteResult

**Location:** `src/shared/motivo-descarte.ts`

**Description:** The return type of `routeMail()`: either the resolved project, or the discard
reason. The discard branch's `slug` is **optional** (`slug?`), not `string | undefined` — that
distinction is what lets a test assert `'slug' in result === false` instead of trusting that nobody
logs an `undefined` value. Present only when `motivo === 'slug_no_mapeado'` (the one case that needs
the slug to load it into the map). No field is ever named `key`: `REDACT_PATHS` includes `'key'` and
`'*.key'`, and a field called `key` would silently redact to `[REDACTED]` in the log.

**Interface:**

```ts
type RouteResult =
  | { readonly ok: true; readonly projectId: number; readonly slug: string }
  | { readonly ok: false; readonly motivo: MotivoDescarte; readonly slug?: string };
```

---
