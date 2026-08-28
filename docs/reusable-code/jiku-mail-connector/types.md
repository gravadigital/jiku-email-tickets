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
