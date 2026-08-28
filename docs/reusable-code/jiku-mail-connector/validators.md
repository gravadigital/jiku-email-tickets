# Validators - jiku-mail-connector

## envSchema

**Location:** `src/config/schema.ts`

**Description:** Zod shapes of the ten environment variables in scope, with their defaults and the
timeout floor. It is the source of truth for the `Env` type, which is inferred from it rather than
declared alongside it. Four variables are required and six carry a default.

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
- No IMAP or ticket-map variable is declared yet: those arrive with FG-2 and FG-3.
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
