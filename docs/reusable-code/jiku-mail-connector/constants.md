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
