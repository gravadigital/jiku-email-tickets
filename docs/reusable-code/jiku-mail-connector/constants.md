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
