# Test Helpers - jiku-mail-connector

## setupTestBus

**Location:** `test/bus/helpers.ts`

**Description:** Opens a NATS connection against the suite's shared container and builds a bus
`Client` with `Client.fromConnection()`. Returns a context carrying the connection, the client, and a
`cleanup()` that drains the connection.

`Client.fromConnection()` deliberately skips the auth handshake, so this helper proves nothing about
Zitadel, the service role, or the real inbox prefix — only that the SDK loads and builds a usable
client against a real server.

The NATS client is imported from `@gravadigital/jiku/nats`, never from `nats`: that package is not a
dependency of this project (ADR-002), and the subpath guarantees a single copy of the library in the
tree, without which `error instanceof PermissionViolationError` fails against the copy that threw.

**Signature:**

```ts
function setupTestBus(natsUrl: string): Promise<TestBusContext>
```

**Usage example:**

```ts
import { afterAll, beforeAll, inject, it } from 'vitest';

import { setupTestBus, type TestBusContext } from './helpers.js';

let bus: TestBusContext;

beforeAll(async () => {
  bus = await setupTestBus(inject('natsUrl'));
});

afterAll(async () => {
  await bus.cleanup();
});

it('talks to the bus', () => {
  expect(bus.client.closed).toBe(false);
});
```

**Notes:**

- `cleanup()` calls `connection.drain()` rather than `close()`: with a plain `close()` an in-flight
  reply is lost. Irrelevant in S-001 (no requests yet), but S-005 inherits this helper and there it
  matters.
- Do not use `await using` with the client: `Client` implements `Symbol.asyncDispose`, but that syntax
  needs Node 24 and is a syntax error on Node 22, which is this service's runtime.

---

## createLogCapture

**Location:** `test/shared/log-capture.ts`

**Description:** An in-memory `DestinationStream` for the logger. Returns the emitted lines both
parsed and raw, so a test can assert on **the serialized line** instead of on the input object.

It exists as a shared helper rather than embedded in one test file because S-004 and S-005 need it:
their diagnostic lines — the connection failure, the SDK's seven error classes — are assertable
behaviour, not decoration, and this is the infrastructure that makes them assertable without writing
to CI output.

**Signature:**

```ts
interface LogCapture {
  readonly stream: pino.DestinationStream;
  lines(): Record<string, unknown>[];
  raw(): string[];
  clear(): void;
}

function createLogCapture(): LogCapture;
```

**Usage example:**

```ts
import { createLogger } from '#shared/logger.js';

import { createLogCapture } from './log-capture.js';

const capture = createLogCapture();
const logger = createLogger(config, capture.stream);

logger.info({ creds: '-----BEGIN NATS USER JWT-----' }, 'bus creds');

// Both assertions matter, and the second is the one that catches a leak by another path.
expect(capture.lines()[0]?.['creds']).toBe('[REDACTED]');
expect(capture.raw().join('\n')).not.toContain('BEGIN NATS USER JWT');
```

**Notes:**

- **`raw()` is not an extra.** The assertion that actually detects a leak is "the serialized line does
  not contain the secret's substring", and that is asserted on the string. On the parsed object you
  cannot detect a secret that leaked through an unexpected field.
- The sink is **synchronous**: the line is available as soon as `logger.info()` returns. That is what
  avoids this suite's worst failure mode — reading `lines()` before a flush, finding it empty, and
  passing green.
- Pass `capture.stream` as `createLogger`'s second argument. Note that an explicit destination takes
  the development transport out of play (see `createLogger`'s notes), which is intentional.
