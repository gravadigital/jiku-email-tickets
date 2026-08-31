# Constants - jiku-mail-connector

## SERVICE_NAME

**Location:** `src/shared/service-info.ts`

**Description:** The service name, matching the `service` field of the architecture manifest. Used
wherever the process has to identify itself.

**Signature:**

```ts
const SERVICE_NAME = 'jiku-mail-connector';
```

**Usage example:**

```ts
import { SERVICE_NAME } from '#shared/service-info.js';

process.stdout.write(`${SERVICE_NAME} bootstrap ok\n`);
```

**Notes:** Imported through the native Node subpath prefix `#shared/`, with the `.js` extension ESM
requires. The mapping is configured on both sides: `paths` in `tsconfig.json` (compilation, pointing
at `src/`) and `imports` in `package.json` (runtime, pointing at `dist/`).

---

## MIN_TIMEOUT_MS

**Location:** `src/config/schema.ts`

**Description:** Floor for the bus command timeout, in milliseconds. It is a floor and not a default:
a value below it is raised, not rejected. The server gives up at 10 s and PostgreSQL at 8 s, so a
timeout shorter than the server's turns an explained error into a mute one — the client gives up
before the system gets to say what failed (ADR-006, NFR-P03).

**Signature:**

```ts
const MIN_TIMEOUT_MS = 15_000;
```

**Usage example:**

```ts
JIKU_TIMEOUT: z.coerce.number().int().positive().default(MIN_TIMEOUT_MS)
  .transform((ms) => Math.max(ms, MIN_TIMEOUT_MS)),
```

**Notes:** The `.transform()` goes *after* the `.default()` so the floor applies to a provided value
and to the default alike. Lowering this constant looks like an optimisation and defeats exactly what
it protects.

---

## DEFAULT_ISSUER

**Location:** `src/config/schema.ts`

**Description:** The Zitadel issuer this connector authenticates against. The SDK deliberately ships
no default for it: a generic library that guessed would point either at somebody else's instance or
at a host that does not exist. This connector is not generic, so declaring the default here is
legitimate and does not duplicate an SDK default.

**Signature:**

```ts
const DEFAULT_ISSUER = 'https://id.grava.io';
```

---

## DEFAULT_SERVERS_URL

**Location:** `src/config/schema.ts`

**Description:** Default bus endpoint. The SDK has the same value but applies it in `resolveOptions()`
during `connect()`, not in `loadConfig()` — so a caller that needs the endpoint resolved before
connecting has to declare it.

**Signature:**

```ts
const DEFAULT_SERVERS_URL = 'nats://localhost:4222';
```

---

## DEFAULT_IMAP_PORT

**Location:** `src/config/schema.ts`

**Description:** Default IMAP port, 993 (IMAPS — IMAP over implicit TLS), which is what Gmail exposes.
Added by S-007. Exported as a named constant rather than left as a literal so S-009 can reference it
without copying the value.

**Signature:**

```ts
const DEFAULT_IMAP_PORT = 993;
```

---

## DEFAULT_POLL_CRON

**Location:** `src/config/schema.ts`

**Description:** Default poll expression, every five minutes. Added by S-007. The tick never fires at
startup: the first one arrives with the cron. The expression is validated at **startup** with
`validate()` from `node-cron` — the very library that later schedules it — so a malformed one stops
the process from starting instead of exploding later in `cron.schedule()`.

**Signature:**

```ts
const DEFAULT_POLL_CRON = '*/5 * * * *';
```

---

## DEFAULT_POLL_MAX_PER_TICK

**Location:** `src/config/schema.ts`

**Description:** Default cap of mails processed per tick, 50. Added by S-007. Bounds the work of a
single tick so a mailbox with a backlog is not processed all at once. Consumed by the tick (S-010).
The schema validates it with `.min(1)`, not `.positive()`: equivalent for integers, but `.min(1)` is
what the criterion says literally and makes the error message read the same.

**Signature:**

```ts
const DEFAULT_POLL_MAX_PER_TICK = 50;
```

---

## DEFAULT_SUBADDRESS_PREFIX

**Location:** `src/config/schema.ts`

**Description:** Default prefix of the subaddress the project slug is extracted from
(`<prefix>+<slug>@domain`, e.g. `tickets+alfa@grava.io`). Added by S-012, which only **declares** it;
the extraction that consumes it is S-013. Named and exported rather than inlined so a later story can
refer to it without copying the literal — the same precedent as `DEFAULT_IMAP_PORT` and
`DEFAULT_POLL_CRON`. Configurable through `SUBADDRESS_PREFIX`, which rejects a whitespace-only value.

**Signature:**

```ts
const DEFAULT_SUBADDRESS_PREFIX = 'tickets';
```

---

## DEFAULT_PLACEHOLDER_TITLE

**Location:** `src/config/schema.ts`

**Description:** Default title a requirement is created with when the mail arrives without a subject.
Added by S-012; consumed by S-015. Configurable through `PLACEHOLDER_TITLE`.

Note for whoever edits `EXPECTATIONS`: this literal contains the word *recibido*, and the expectations
table sustains the property of describing only what was **expected** and never what was received.
`EXPECTATIONS.PLACEHOLDER_TITLE` therefore points at this constant by name instead of quoting it —
deliberately, so the property has no exception anyone would later have to tell apart from a real leak.

**Signature:**

```ts
const DEFAULT_PLACEHOLDER_TITLE = 'Ticket recibido por mail';
```

---

## DEFAULT_PLACEHOLDER_BODY

**Location:** `src/config/schema.ts`

**Description:** Default body a requirement is created with when the mail arrives with no content.
Added by S-012; consumed by S-015. Configurable through `PLACEHOLDER_BODY`.

**Signature:**

```ts
const DEFAULT_PLACEHOLDER_BODY = '(mail sin contenido)';
```

---

## DEFAULT_ALLOWED_EXTENSIONS / DEFAULT_ALLOWED_MIME_TYPES

**Location:** `src/config/schema.ts`

**Description:** Default comma-separated allow-lists of the local attachment policy (S-017): a
broad office/image set of extensions, and the MIME types matching it. Extensions are normalized to
lowercase while parsing (`particionar()` compares case-insensitively); MIME types are not.

**Signature:**

```ts
const DEFAULT_ALLOWED_EXTENSIONS =
  '.png,.jpg,.jpeg,.gif,.pdf,.doc,.docx,.xls,.xlsx,.txt,.log,.zip';
const DEFAULT_ALLOWED_MIME_TYPES =
  'image/png,image/jpeg,image/gif,application/pdf,application/msword,...';
```

---

## DEFAULT_MAX_ATTACHMENT_SIZE_BYTES

**Location:** `src/config/schema.ts`

**Description:** Default max attachment size, 10 MB **in bytes** (not MB, to avoid unit ambiguity
in the schema itself). Evaluated against the real in-memory `Buffer` length, never the mail's
declared `size`.

**Signature:**

```ts
const DEFAULT_MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
```

---

## DEFAULT_PUT_TIMEOUT_MS

**Location:** `src/config/schema.ts`

**Description:** Default timeout for the attachment byte's `PUT`, 30000 ms. Not consumed by S-017 —
declared here because it is the same configuration extension; S-019 consumes it.

**Signature:**

```ts
const DEFAULT_PUT_TIMEOUT_MS = 30_000;
```

---

## MAX_ATTACHMENTS_PER_REQUIREMENT

**Location:** `src/config/schema.ts`

**Description:** The fixed cap of attachments per requirement, `10`. **Not an env var** — it is the
bus contract's `maxItems` (ADR-003), fixed in code on purpose. `aplicarTope()`
(`src/domain/adjuntos/tope.ts`) imports it; never read from configuration.

**Signature:**

```ts
const MAX_ATTACHMENTS_PER_REQUIREMENT = 10;
```

---

## TEST_USER_ID

**Location:** `test/bus/helpers.ts`

**Description:** Fixed caller identity used by the test bus context. It is deliberately a fake value:
in production the user id comes from `auth.userId`, derived from the service key (ADR-002), never from
a constant.

**Signature:**

```ts
const TEST_USER_ID = 'test-machine-user';
```

---

## TEST_INSTANCE

**Location:** `test/bus/helpers.ts`

**Description:** Bus instance name used by the test bus context, overriding the SDK default of `dev`.

**Signature:**

```ts
const TEST_INSTANCE = 'test';
```

---

## REDACT_PATHS

**Location:** `src/shared/log-redaction.ts`

**Description:** The list of `redact` paths the logger censors. It lives in its own file, separate
from the logger, so the question "what is protected today?" has a one-file answer — readable at a
glance by whoever audits, and directly assertable by a test.

It covers two groups with different status: what exists and must be protected now (tokens, generic
credentials, machine-user key content, NATS creds content, paths to secret files), and what does not
exist yet but is already declared (mail body and attachment content), so FG-2 and FG-3 **inherit** the
rule instead of having to remember to add it.

**Interface:**

```ts
const REDACT_PATHS: readonly string[];
```

**Usage example:**

```ts
import { REDACT_CENSOR, REDACT_PATHS } from '#shared/log-redaction.js';

const options: pino.LoggerOptions = {
  redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
};
```

**Notes:**

- **`redact.paths` wildcard semantics, verified against `pino@10.3.1` — read before touching the
  list.** `*` matches **exactly one** level: `'*.token'` covers `{ auth: { token } }` but **not**
  `{ token }` at the root nor `{ a: { b: { token } } }` two levels deep. **There is no deep
  wildcard** — `'**.token'` redacts nothing: it does not fail, does not warn, it just leaves the
  secret in the clear. That is why every field appears **twice** (root form and wildcard form). The
  duplication is the price of the syntax, not an oversight. Do **not** "clean it up".
- Array index wildcards (`'attachments[*].content'`) **are** supported, in both forms.
- A path pointing at an object censors the **whole node**: `'key'` over
  `{ key: { keyId, key, userId } }` leaves `key: '[REDACTED]'` entirely.
- Contexts three or more levels deep are out of declared scope: the connector's log call sites are
  flat or one level, and a future story that nests deeper must add the explicit path.
- **`'key'` and `'*.key'` are deliberately broad — accepted risk, do not re-litigate.** `key` is a
  generic name and may collide with a legitimate field called `key`. The cost of a collision is an
  innocuous field showing as `[REDACTED]` — annoying, and recoverable by renaming the context field.
  The cost of **not** covering it is an RSA private key in the clear in the log, since the SDK's
  `ServiceAccountKey.key` **is** the private key. The asymmetry is total.
- **It deliberately does NOT include `messageId`, `projectId`, `slug`, `instance` or `id`.** ADR-006
  explicitly requires those to be logged — they are the trace that makes a lost ticket
  reconstructible. Redacting them makes the log useless, which is the opposite failure and no less
  serious.
- It does not copy the catalog's `req.headers.*` paths: the service exposes no HTTP (ADR-001), so they
  can never occur and only add noise to a list meant to be audited.

---

## REDACT_CENSOR

**Location:** `src/shared/log-redaction.ts`

**Description:** The replacement value for every redacted path: `'[REDACTED]'`.

**Interface:**

```ts
const REDACT_CENSOR = '[REDACTED]';
```

**Notes:**

- The literal is what CA-3 and CA-4 name, and the redaction tests assert on it. Changing it breaks
  seven tests by design — they assert on the serialized line, not on the input object.

---

## DEVELOPMENT_TRANSPORT_TARGET

**Location:** `src/shared/logger.ts`

**Description:** The transport target used only in development: `'pino-pretty'`.

**Interface:**

```ts
const DEVELOPMENT_TRANSPORT_TARGET = 'pino-pretty';
```

**Notes:**

- `pino-pretty` is a **devDependency** and the Dockerfile's production stage installs with
  `--omit=dev`, so the package **does not exist** in the final image. That is why it is only
  referenced when `nodeEnv === 'development'`, and why `createLogger` degrades if it fails to resolve
  anyway.

---

## RIGHT_TOKEN / WRONG_TOKEN / TEST_SUBJECT

**Location:** `test/bus/auth-helpers.ts`

**Value:** `'the-right-token'` / `'the-wrong-token'` / `'machine-user-abc'`

**Description:** The token the authenticated test container accepts, one it rejects, and the `sub` the
identity doubles declare.

**Notes:**

- Literals rather than random values on purpose: they make the tests readable, and there is nothing to
  protect in an ephemeral container that lives as long as one test file.

---

## TITLE_MAX_LENGTH

**Location:** `src/domain/publicacion/requirement.schema.ts`

**Description:** The maximum length of a requirement `title`: **255**.

**Signature:**

```ts
const TITLE_MAX_LENGTH = 255;
```

**Notes:**

- The command contract does **not** declare a `maxLength`, but Jiku's column is `varchar(255)`: a
  longer title is either refused by `core` with `invalid_fields` or truncated by the database.
- Exported rather than inlined because **FG-3 needs it to truncate** (ADR-003: "`title` MUST truncarse
  a 255 caracteres antes de publicar"). Here it only validates; there it truncates. Exporting it now
  keeps FG-3 from writing a literal `255` in another file, where the two could drift.

---

## VERIFY_TITLE / VERIFY_DESCRIPTION

**Location:** `src/domain/publicacion/verification-payload.ts`

**Description:** The code literals of the verification requirement's title and description.

**Notes:**

- Their text says outright that the requirement is a **deployment check**, and that matters because
  **the requirement stays forever**: there is no compensating command and a created requirement is
  never modified or deleted (invariant 9). Whoever finds it in the Jiku project has to recognise it as
  not-real-work without asking anyone.
- The description also says the connector cannot delete it and that every run leaves a new one.

---

## VERIFY_TYPE / VERIFY_PRIORITY / VERIFY_VISIBILITY_LEVEL

**Location:** `src/domain/publicacion/verification-payload.ts`

**Description:** The connector's defaults: `'incidencia'`, `'sin_prioridad'`, `'public'`.

**Notes:**

- They are **policy of the connector**, not of the contract — in the contract all three fields are
  required. That is precisely why they live in the payload builder and **not** as `.default()` in the
  schema: mixing the two would make an empty object parse into a "valid" payload.

---

## REQUIREMENT_TYPES / REQUIREMENT_PRIORITIES / REQUIREMENT_VISIBILITY_LEVELS

**Location:** `src/domain/publicacion/requirement.schema.ts`

**Description:** The contract enums of `requirements.new`, verbatim from the API context.

---

## REMEDIES

**Location:** `src/domain/publicacion/publish-errors.ts`

**Description:** What to check for each `PublishDiagnosis`. The operator-facing half of the story's
central deliverable.

**Signature:**

```ts
const REMEDIES: Record<PublishDiagnosis, string>;
```

**Notes:**

- Each text names **the system** and **the fix**, because the three systems have three different
  fixes and the worst real case is checking the payload when the problem is in Zitadel.
- Three texts carry specific claims the story requires: the bus one says it **implies nothing about
  `core`**; the two shape ones say they are **proof that the write plane is open**; the role one says
  it is typically the missing `users` row and that **reconnecting fixes it by itself**.
- The timeout figure in `nada_respondio` is interpolated from `MIN_TIMEOUT_MS`, **not written as a
  literal**, even though it is prose: two copies would drift and the remedy would claim one number
  while the process waits for another — exactly the misleading diagnosis this module exists to
  prevent. A property test forbids the literal outside `src/config/`.

---

## MUTE

**Location:** `test/bus/responder.ts`

**Description:** Responder mode that receives a message and does **not** answer.

**Notes:**

- It is how `JikuTimeout` is provoked without turning anything off: the message arrives — so the
  counter records it, which is what proves the publication **did** reach the wire — and nobody
  answers. Different from having **no** responder, which yields `JikuNoEndpoint` immediately
  (measured: 11 ms).
