# Validators - jiku-mail-connector

## envSchema

**Location:** `src/config/schema.ts`

**Description:** Zod shapes of the nine environment variables in scope, with their defaults and the
timeout floor. It is the source of truth for the `Env` type, which is inferred from it rather than
declared alongside it. Four variables are required and five carry a default.

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
