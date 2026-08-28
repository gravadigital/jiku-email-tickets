# Validators - jiku-mail-connector

## envSchema

**Location:** `src/config/schema.ts`

**Description:** Zod shapes of the seventeen environment variables in scope, with their defaults and
the timeout floor. It is the source of truth for the `Env` type, which is inferred from it rather than
declared alongside it. Seven variables are required and ten carry a default.

**Interface:**

```ts
const envSchema = {
  // required
  JIKU_CREDS: z.string().min(1),               // path to the sentinel creds file
  JIKU_KEY_FILE: z.string().min(1),            // path to the machine user's JSON key
  JIKU_PROJECT_ID: z.string().min(1),          // Zitadel project (UUID)
  JIKU_VERIFY_PROJECT_ID: z.coerce.number().int().positive(),   // Jiku project (int)

  // defaulted
  JIKU_INSTANCE: z.string().min(1).default('dev'),
  JIKU_SERVERS: z.string().min(1).default(DEFAULT_SERVERS_URL),
  JIKU_ISSUER: z.string().url().default(DEFAULT_ISSUER),
  JIKU_TIMEOUT: z.coerce.number().int().positive().default(MIN_TIMEOUT_MS)
    .transform((ms) => Math.max(ms, MIN_TIMEOUT_MS)),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),

  // IMAP mailbox (S-007) - the three credentials are required
  IMAP_HOST: z.string().min(1),
  IMAP_PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_IMAP_PORT),
  IMAP_USER: z.string().min(1),
  IMAP_PASSWORD: z.string().min(1),

  // Poll (S-007)
  POLL_CRON: z.string().min(1).default(DEFAULT_POLL_CRON).refine(isValidCron),
  POLL_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  POLL_MAX_PER_TICK: z.coerce.number().int().min(1).default(DEFAULT_POLL_MAX_PER_TICK),
};

type Env = z.infer<z.ZodObject<typeof envSchema>>;
```

**Usage example:**

```ts
import { loadEnv } from '#config/env.js';

const env = loadEnv({ JIKU_CREDS: '/run/secrets/sentinel.creds', /* ... */ });
```

**Notes:**

- It is a plain object of shapes, not a `ZodObject`, because that is what `createEnv` expects. Wrap it
  with `z.object(envSchema)` to parse it directly.
- `JIKU_PROJECT_ID` and `JIKU_VERIFY_PROJECT_ID` are **different things**: the first is the Zitadel
  project (a UUID, it is what puts the roles in the token) and the second is a Jiku project row (an
  int). Swapping them produces two failures that do not say the variables were swapped.
- `JIKU_CREDS` and `JIKU_KEY_FILE` are validated as non-empty **paths**. That the file exists and
  parses is deliberately out of this layer's scope.
- **The four `IMAP_` and three `POLL_` variables were added by S-007**, and the three IMAP credentials
  are **required**: with ingestion in scope a deployment without a mailbox must not start. Only the
  **ticket-map** variables remain undeclared (they arrive with FG-3). Earlier revisions of this file
  said no IMAP variable was declared — that stopped being true in S-007.
- `IMAP_PASSWORD` is the **only** variable whose *value* is a secret (the two bus credentials are
  paths to mounted files). It is also why every one of the seven has an entry in `EXPECTATIONS`:
  without one it would fall through to `UNKNOWN_EXPECTATION`, which is safe but mute.
- **Three of the new shapes carry a decision that looks like it has a shorter form. Do not "simplify"
  any of them:**
  - `POLL_MAX_PER_TICK` uses `.min(1)`, not `.positive()`. Equivalent for integers, but `.min(1)` is
    what the acceptance criterion says literally, and it makes the `EXPECTATIONS` text read the same.
  - `POLL_CRON` is validated with `validate()` from **`node-cron`** inside a `.refine()`, never with a
    regex: a regex that accepts what `node-cron` rejects reintroduces the deferred failure at the
    worst possible moment — in `cron.schedule()`, with the logger built and the connection open.
  - `POLL_ENABLED` does **not** use `z.coerce.boolean()`. That applies `Boolean(value)`, and
    `Boolean('false')` is `true`, so `POLL_ENABLED=false` would silently *enable* the poll. The
    coercion is explicit over `z.enum(['true','false'])`, and any other value fails to start.
- The IMAP credentials stay required **even with `POLL_ENABLED=false`**, implemented with **no
  conditional logic at all**: `pollEnabled` is an operational switch, not a separate deployment mode.
- **No IMAP folder variable exists.** `INBOX` is fixed and not configurable in v1; it lives as a
  constant of the ingestion module.
- **`NODE_ENV` was added by S-003, and its default is `production` on purpose** — counter to what most
  Node projects do. The logger reads it (via `AppConfig.nodeEnv`) to pick JSON vs `pino-pretty`, and
  the expensive mode must be requested explicitly: a deployment that forgot to declare it emits JSON,
  which is correct, whereas the inverse error — a production container trying to load a `pino-pretty`
  that `--omit=dev` left out of the image — is worse. Do not "fix" it to `development`.
- `NODE_ENV` is **not** required, and making it so would break existing deployments and tests without
  gaining anything. Because it has a default it never appears in the missing-variables report.

---

## newRequirementSchema

**Location:** `src/domain/publicacion/requirement.schema.ts`

**Description:** The contract of the `requirements.new` command payload: six fields, strict.

**Signature:**

```ts
const newRequirementSchema: z.ZodObject<{
  title: z.ZodString;            // min 1, max TITLE_MAX_LENGTH (255)
  description: z.ZodString;      // min 1, no cap (it is `text` in the database)
  projectId: z.ZodNumber;        // int, positive
  type: z.ZodEnum<['funcionalidad', 'mejora', 'incidencia', 'otro']>;
  priority: z.ZodEnum<['sin_prioridad', 'baja', 'media', 'alta', 'urgente']>;
  visibilityLevel: z.ZodEnum<['public', 'internal']>;
}>;
```

**Usage:**

```ts
const result = newRequirementSchema.safeParse(payload);
```

**Notes:**

- **This file is the only definition of the contract in the repo.** Verified: the SDK exports no type
  and no schema for this command's payload — `command<T>()` takes `payload?: unknown`. That is why the
  type is **inferred** from the schema with `z.infer` instead of hand-written: two separate
  declarations would diverge without anything failing, and what would go on the wire is what the
  schema says while the compiler asserts something else.
- **`.strict()`, not a plain `z.object`,** and the difference is the whole point: a plain `z.object`
  **silently drops** unknown keys, so a stray `actor` would be removed without warning. What is wanted
  is for it to **fail** — the schema is also the executable documentation of CA-3's four exclusions,
  and an exclusion applied silently documents nothing.
- **No `.default()` on the enums**, deliberately. The schema models **`core`'s contract** (where all
  three are required); the chosen values are **the connector's policy** and live in the payload
  builder. With defaults in the schema, `parseNewRequirement({})` would produce a "valid" payload out
  of nothing, which is exactly what a boundary validator must not do.
- `title`'s cap is `TITLE_MAX_LENGTH`, exported because **FG-3 needs it to truncate** (ADR-003). Here
  it only validates; there it truncates.

---

## newRequirementReplySchema

**Location:** `src/domain/publicacion/requirement.schema.ts`

**Description:** The success reply of `requirements.new`: `{ id }`, validated.

**Signature:**

```ts
const newRequirementReplySchema: z.ZodObject<{ id: z.ZodNumber }>; // int, positive, loose
```

**Notes:**

- It exists because of a verified finding: **`command<T>()` does not validate `data` against `T`.** It
  returns `reply.data` as-is; the generic is an assertion by the caller, not a guarantee. A `core`
  answering `{ status: 'success', data: {} }` would produce the success line with
  `requirementId: undefined` **without anything failing**. A success reply with no usable `id` is a
  **failure**, not a success with a hole.
- **Deliberately not `z.coerce`**: coercion would let `'42'` through and turn `'no-es-numero'` into
  `NaN`. The case to catch is `core` answering with the wrong type.
- **`.loose()`, unlike the payload's `.strict()`**, and the inversion is intentional: the connector
  *builds* the payload (strictness protects) and *receives* the reply (tolerance protects). A field
  `core` starts sending tomorrow must not break the connector.
- It lives next to the payload schema because both are the contract of the **same** command; splitting
  them would send the next person adding a reply field to the wrong file.
