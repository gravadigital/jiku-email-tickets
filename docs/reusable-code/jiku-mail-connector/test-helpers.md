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
