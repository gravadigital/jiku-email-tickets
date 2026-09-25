---
id: testing
display_name: Testing (Vitest + NATS de Testcontainers, sin base de datos)
language: node
description: Unit and integration testing with Vitest against a real NATS container; no database anywhere, IMAP and the presigned PUT are doubled at the boundary
applies_to: [worker]
required_by: []
package: vitest
---

# Testing (Node, Vitest — no database)

Unit and integration tests with [Vitest](https://vitest.dev). This is a **service-local
replacement** of the catalog `testing` convention: that one is built around one shared
Postgres container with migrations, a seeded read-only catalog, and `app.inject()` for HTTP
routes. This service has **no database and no HTTP server** ([ADR-001](../../../adrs/ADR-001-worker-unico-sin-persistencia.md)),
so none of that machinery applies. What stays is Vitest, the shared-container discipline, and
sequential execution. What replaces Postgres is **one NATS container** — the bus is the only
real infrastructure this service talks to.

## When to use

- This service only (`jiku-email-tickets`, `type: worker`).
- **Unit tests** for the pure core: mail normalization, subject cleaning, slug extraction,
  attachment partitioning, checksum dedup, description composition. This is where most of the
  value is — that code is pure and has many edge cases.
- **Integration tests** against a real NATS container for the publishing path, using the
  SDK's `Client.fromConnection()`.
- **Boundary doubles** for IMAP and for the presigned `PUT` — the two dependencies that
  cannot be containerized meaningfully (see below).

## Package

```
vitest                  # test runner
testcontainers          # generic container: NATS (dev only)
```

**Explicitly NOT used** (and the reason matters, so nobody re-adds them):

```
@testcontainers/postgresql   # NO: there is no database (ADR-001)
```

## Architecture: one shared NATS container, started once

Same structural rule as the catalog convention, minus the database. Vitest's default pool
runs each test file in its own worker; a container per file would mean N containers at once.

- **`globalSetup`** (runs ONCE, main process, before any worker) starts **one** NATS and
  exposes its URL via `provide()`.
- Test files read that URL with `inject()` and connect to the shared container — they do
  **not** start their own.
- **Sequential execution** (`fileParallelism: false`): the shared bus means files can see
  each other's subjects. Sequential removes cross-file races.

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'], // 1 NATS for the whole suite
    fileParallelism: false,                  // sequential: shared bus, no cross-file races
  },
});
```

```ts
// test/global-setup.ts  (runs ONCE, main process)
import type { GlobalSetupContext } from 'vitest/node';
import { GenericContainer, Wait } from 'testcontainers';

declare module 'vitest' {
  export interface ProvidedContext {
    natsUrl: string;
  }
}

let nats: Awaited<ReturnType<GenericContainer['start']>> | undefined;

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  nats = await new GenericContainer('nats:2.10-alpine')
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage('Server is ready'))
    .start();

  provide('natsUrl', `nats://${nats.getHost()}:${nats.getMappedPort(4222)}`);
}

export async function teardown(): Promise<void> {
  await nats?.stop();
}
```

## Doubling the boundaries

Three dependencies, three different treatments. The distinction is deliberate: **double at
the boundary, never in the middle.**

| Dependency | Treatment | Why |
|---|---|---|
| **NATS (the bus)** | **Real container** | It is the contract this service exists to satisfy. Mocking it would hide subject and envelope mistakes — exactly the class of bug that fails without signalling its cause ([ADR-002](../../../adrs/ADR-002-sdk-oficial-del-bus.md)) |
| **`core` (the command handler)** | **In-test responder** on the real bus | `core` is not this repo's code. A test subscribes to the command subject and replies with a canned `success` or `failure`, which is what lets us test every rejection class |
| **IMAP** | **Interface double** | A real IMAP server in a container would test `imapflow`, not this service. The value is in the normalization that follows, which is pure |
| **Presigned `PUT`** | **`fetch` stub** | The URL is signed by `core`; there is no S3 to reach in tests. Assert the request shape and simulate the failure modes |
| **Zitadel** | **Not exercised** | Token acquisition belongs to the SDK. Integration tests build the client with `Client.fromConnection()`, which skips the auth handshake |

### The bus: real container, in-test responder

The SDK exposes `Client.fromConnection(nc, ...)` for exactly this: point the client at a test
NATS instead of going through Zitadel and the auth-callout.

The NATS client is imported from the SDK's `/nats` subpath, **never from the `nats` package**.
`nats` is not a dependency of this service and must not become one
([ADR-002](../../../adrs/ADR-002-sdk-oficial-del-bus.md)): the SDK depends on
`@nats-io/nats-core` and `@nats-io/transport-node`, and re-exports that client precisely so
there is **one copy** of the library in the dependency tree. Two copies mean two sets of error
classes, and `error instanceof PermissionViolationError` then fails against the copy that threw.

```ts
// test/bus/helpers.ts
import { inject } from 'vitest';
import { connect as natsConnect } from '@gravadigital/jiku/nats';   // NOT from 'nats'
import { Client } from '@gravadigital/jiku';

export async function setupTestBus(): Promise<TestBusContext> {
  const nc = await natsConnect({ servers: inject('natsUrl') });
  const client = Client.fromConnection(nc, { instance: 'test', userId: 'test-machine-user' });
  return { nc, client, cleanup: async () => { await nc.drain(); } };
}

/** Stand in for `core`: reply to one command subject with a canned response. */
export function respondTo(
  nc: NatsConnection,
  command: string,
  reply: { ok: true; data: unknown } | { ok: false; errorCode: string },
) { /* subscribe to *.*.jiku-commands.v1.{command} and publish the envelope */ }
```

```ts
// src/publicacion/publish-requirement.test.ts
describe('publishRequirement', () => {
  let bus: TestBusContext;
  beforeAll(async () => { bus = await setupTestBus(); });
  afterAll(async () => { await bus.cleanup(); });

  it('publishes requirements.new and returns the created id', async () => {
    respondTo(bus.nc, 'requirements.new', { ok: true, data: { id: 42 } });

    const result = await publishRequirement(bus.client, normalizedMail, 7);

    expect(result.id).toBe(42);
  });

  it('surfaces caller_not_authorized as a core-rejected-by-role failure', async () => {
    respondTo(bus.nc, 'requirements.new', { ok: false, errorCode: 'caller_not_authorized' });

    await expect(publishRequirement(bus.client, normalizedMail, 7))
      .rejects.toMatchObject({ name: 'JikuFailure', code: 'caller_not_authorized' });
  });
});
```

**Every error class of [ADR-006](../../../adrs/ADR-006-observabilidad-por-logs.md) must have a test.** The whole point of distinguishing which
system rejected is lost if the mapping is untested:

```ts
it.each([
  ['caller_not_authorized', 'core rejected by role'],
  ['invalid_fields',        'core rejected the shape'],
  ['project_not_found',     'the ticket map points at a missing project'],
])('logs %s as: %s', async (errorCode, expectedDiagnosis) => { /* ... */ });
```

### IMAP: interface double, not a container

The mail source is an interface; tests provide a fake that yields fixture messages.

```ts
// src/domain/ingesta/ports.ts  (production interface)
export interface RawMessage {
  readonly uid: number;
  readonly source: Buffer;
}

export interface MailSource {
  searchUnseen(): Promise<number[]>;
  fetch(uid: number): Promise<RawMessage>;
  markSeen(uid: number): Promise<void>;
}
```

**Three operations, not the two this convention documented before S-009.** An earlier draft of
this contract read `fetchUnseen(max: number): Promise<RawMessage[]>` plus `markSeen`, and that
shape turned out not to be implementable against the tick's real requirements — it cannot satisfy
all three at once:

- The `warn` for deferred messages needs the **total** count of `\Unseen` messages
  (`found − cap`). A method that already truncates to `max` loses the total, and the deferred
  counter becomes unobservable.
- Marking `\Seen` has to happen **one UID at a time, immediately after each download** — never in
  a batch at the end of the tick. A `Promise<RawMessage[]>` resolves the whole batch before the
  caller can mark anything, so the first `markSeen` would land after the *last* download: exactly
  the batch marking the design rejects.
- A message whose download fails must be **skipped without being marked**, so the next tick
  retries it. With the batch already resolved, one failed download rejects the entire promise and
  aborts the tick for every other message in it.

Splitting `fetchUnseen` into `searchUnseen()` (returns the untruncated total) plus `fetch(uid)` and
`markSeen(uid)` (both per-UID) is what lets the tick apply the cap itself, count what it deferred,
and mark one UID right after downloading it — none of which the two-method shape could express.

```ts
// test/fixtures/mail-source.ts
export function fakeMailSource(messages: RawMessage[]): MailSource & { seen: number[] } {
  const seen: number[] = [];
  const byUid = new Map(messages.map((message) => [message.uid, message]));
  return {
    seen,
    searchUnseen: async () => messages.map((message) => message.uid),
    fetch: async (uid) => {
      const message = byUid.get(uid);
      if (message === undefined) throw new Error(`no fixture message for uid ${uid}`);
      return message;
    },
    markSeen: async (uid) => { seen.push(uid); },
  };
}
```

This is what makes the tick rules testable, and they are the rules most likely to regress:

```ts
it('processes the newest messages first and defers the rest', async () => { /* cap of 50 */ });
it('does not mark \\Seen when the download failed', async () => { /* retried next tick */ });
it('keeps processing the batch when one mail fails to parse', async () => { /* 9 of 10 */ });
it('skips a tick while another is in flight', async () => { /* no overlap */ });
```

### Raw mail fixtures

Normalization is the largest body of pure logic in the service. Fixtures are **real RFC 822
bytes**, not hand-built objects, so `mailparser` is exercised for real.

```
test/fixtures/mails/
├── plain-text.eml
├── html-only.eml                # exercises html-to-text: no href, no img
├── quoted-reply.eml             # quoted-text trimming
├── re-re-fwd-subject.eml        # iterative prefix stripping
├── no-message-id.eml            # must be discarded
├── no-body.eml                  # placeholder path
├── with-attachments.eml
├── duplicate-attachments.eml    # same checksum twice -> collapses to one
├── inline-image.eml             # treated as a normal attachment in v1
└── in-reply-to.eml              # a thread reply -> actively discarded (also exercises es_respuesta)
```

**The routing scenarios (S-013, `test/ruteo/route-mail.test.ts`) are the one deliberate exception to
"fixtures are real `.eml` bytes".** `routeMail()` takes `Pick<IncomingMail, 'referenceIds' |
'recipient'>` — a plain object, not a raw mail — so its test suite builds that object inline instead
of parsing a file. There is no `mailparser` step to exercise for real here, unlike the fixtures above.
The scenarios CA-18 of S-016 asks for are already covered this way, not by new `.eml` files:

- **Mixed-case subaddress** (`TICKETS+Alfa@grava.io`, `tickets+ALFA@grava.io`) — resolves the same
  slug regardless of casing.
- **No `+` in the recipient** (`soporte@grava.io`) — falls through to `sin_slug`.
- **Empty slug** (`tickets+@grava.io`) — also `sin_slug`, not `slug_no_mapeado`.
- **A thread reply** (`In-Reply-To` populated) — `es_respuesta`, evaluated before the slug is even
  touched. Covered both inline in `route-mail.test.ts` and by the real `.eml` fixture
  `in-reply-to.eml` above, exercised at the `tick.ts` integration level.

If a future story needs `routeMail()` exercised against real RFC 822 bytes end-to-end (recipient
parsed by `mailparser`, not handed in already-isolated), reuse `in-reply-to.eml` for the reply case and
`with-attachments.eml`/`plain-text.eml` with a rewritten `To:` header for the resolved case (see
`withResolvableRecipient()` in `test/publicacion/source-properties.test.ts` for the pattern) — do not
duplicate `route-mail.test.ts`'s inline scenarios as new `.eml` files.

## Unit tests

The pure core. No containers, no I/O — this is where most tests live:

```ts
import { describe, it, expect } from 'vitest';
import { cleanSubject } from './normalize';

describe('cleanSubject', () => {
  it('strips stacked prefixes iteratively and case-insensitively', () => {
    expect(cleanSubject('Re: Re: Fwd: Falla en el login')).toBe('Falla en el login');
  });
});
```

Every invariant of the PRD that can be expressed as a pure function has a unit test. The
non-obvious ones that must be covered, because getting them wrong is silent:

- `title` truncated to **255** before publishing.
- Slug lowercased **on both sides** of the map lookup.
- Attachments with the same checksum collapse to one, and a collapsed one leaves **no notice
  and no placeholder** (distinct from a rejected one, which leaves a notice).
- Description composed in exactly this order: body → rejection notices → upload-failure
  notices → **placeholders last**.

## Gotchas

- **Do not add a database container.** If a test seems to need one, the production code is
  probably persisting something it must not ([ADR-001](../../../adrs/ADR-001-worker-unico-sin-persistencia.md)).
- **Do not assert on wall-clock timing of the cron.** Test the tick function directly;
  scheduling is `node-cron`'s job, not this service's.
- **`Client.fromConnection()` skips the auth handshake**, so integration tests prove nothing
  about Zitadel, the role, or the inbox prefix. Those only fail against a real deployment —
  that is precisely why FG-1 exists as a walking skeleton.
- **The in-test responder must use the same subject grammar as the SDK.** Subscribe with a
  wildcard (`*.*.jiku-commands.v1.requirements.new`) rather than reconstructing the subject
  by hand, or the test asserts your reconstruction instead of the SDK's.
- **No wall-clock sleeps to wait for a condition.** Use `Wait.*` strategies for readiness and
  await the observable condition.
- **Keep test log output quiet** (`LOG_LEVEL=silent`), but never silence errors globally — a
  swallowed error in a service whose only output is logs is the worst possible test artifact.

## Rules

- **One shared NATS container per suite, started in `globalSetup`.** Never start a container
  in `beforeAll` per file, and never inside an `it`.
- **Never add a database container, a migration step, or a seed dataset.** This service has no
  database.
- **Do not mock the bus.** Integration tests use the real NATS container via
  `Client.fromConnection()`.
- **Import the NATS client from `@gravadigital/jiku/nats`, never from `nats`.** Declaring
  `nats` directly is forbidden by
  [ADR-002](../../../adrs/ADR-002-sdk-oficial-del-bus.md): the subpath guarantees a single copy
  of the library in the tree, and with two copies `instanceof` fails against the copy that
  threw. This holds in test code exactly as it holds in production code.
- **Double only at the boundary:** IMAP through the `MailSource` interface, the presigned
  `PUT` through a `fetch` stub. Never mock this service's own domain functions.
- **Every SDK error class handled in production code has a test** that asserts the diagnosis
  it produces — the value of [ADR-006](../../../adrs/ADR-006-observabilidad-por-logs.md) is the mapping, and an untested mapping is not a mapping.
- **Mail fixtures are real `.eml` bytes**, never hand-constructed parsed objects.
- **Unit tests are for pure functions only.** If it touches the bus, it is an integration
  test.
- Tests must not depend on host env vars or external services. Everything is started or
  doubled by the test setup.
- Test files co-located with the code or under `test/`, suffixed `.test.ts`.
- `describe` names the unit under test; `it` names the scenario. Both in plain English.
- Reset mocks between tests with `vi.clearAllMocks()` / `vi.unstubAllGlobals()`.

## Integration with other conventions

- **logging**: assert the *shape* of diagnostic logs for discards and failures — in this
  service the log is the only trace a lost ticket leaves, so it is behaviour, not decoration.
  Silence log output in tests, but assert what would have been logged.
- **env-config**: the fail-fast startup validation gets its own test per required variable —
  a missing variable must abort with the **complete** list, not one at a time.
- **error-handling**: the SDK's error classes are mapped to this service's diagnostics; that
  mapping is tested, not asserted by reading the code.
- **dockerfile**: the `test` stage runs this suite, so it needs Docker-in-Docker or a mounted
  socket for the NATS container. Unit tests alone need neither.
