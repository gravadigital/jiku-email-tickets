# Test Helpers - jiku-email-tickets

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

---

## startAuthenticatedNats()

**Location:** `test/bus/auth-helpers.ts`

**Description:** Starts a `nats:2.10-alpine` container with `--auth <token>`, so a wrong token produces
a **real** `Authorization Violation` that the SDK's `connectError()` translates.

**Signature:**

```ts
function startAuthenticatedNats(token?: string): Promise<AuthenticatedNats>;

interface AuthenticatedNats {
  readonly url: string;
  readonly token: string;
  restart(): Promise<void>;
  stop(): Promise<void>;
}
```

**Notes:**

- **WHAT IT PROVES AND WHAT IT DOES NOT.** It proves that a real credential rejection by the NATS
  *server* reaches the connector as the `JikuError` whose cause chain the classification reads. It does
  **not** prove anything about the **auth-callout**, the **`internal-app` role**, the token's roles
  claim, or the real inbox prefix — **none of that exists in a bare NATS**, which only compares a
  string. That verification only happens against a real deployment.
- **A container per file is the documented exception** to the shared-container rule, not a violation of
  it: the suite's shared NATS cannot have `--auth` without breaking S-001's tests, which connect to it
  without credentials. It is started in one file's `beforeAll` and stopped in its `afterAll`.
- **It fixes the host port**, asking the OS for a free one. `restart()` in testcontainers remaps the
  port, and the NATS client keeps retrying the endpoint it connected to — so with the default ephemeral
  port a reconnect **can never happen** and the reconnect test expires without proving anything.

---

## fakeTokenSource() / rotatingTokenSource() / failingTokenSource()

**Location:** `test/bus/auth-helpers.ts`

**Description:** `TokenSource` doubles for the connection tests: one that returns a fixed token, one
whose token rotates and counts how often it was read, and one that fails to mint a token.

**Signature:**

```ts
function fakeTokenSource(token: string, subject?: string): TokenSource;
function rotatingTokenSource(tokens: readonly string[], subject?: string):
  TokenSource & { currentTokenCalls: () => number; rotate: () => void };
function failingTokenSource(reason: string, subject?: string): TokenSource;
```

**Notes:**

- **A double at the edge, not a mock of our own code.** `TokenSource` is the interface the SDK defines
  and through which the connector hands over its identity. Doubling it is exactly what the convention
  allows; doubling `connectToBus()` is what it forbids.
- The real `ServiceUser` cannot be used for the connection tests: its `token()` really calls Zitadel.
  The identity tests do use the real one, because what they assert needs no network.

---

## generateServiceAccountKeyFile() / writeRawKeyFile() / cleanupKeyFiles()

**Location:** `test/bus/auth-helpers.ts`

**Description:** Writes a `ServiceAccountKey` JSON with a **real** RSA private key and returns its
path; `overrides` accepts `null` to delete a field, which is how the invalid variants are produced.

**Signature:**

```ts
function generateServiceAccountKeyFile(
  overrides?: Partial<Record<keyof ServiceAccountKey, string | null>>,
): Promise<string>;
function writeRawKeyFile(contents: string): Promise<string>;
function cleanupKeyFiles(): Promise<void>;
```

**Notes:**

- **The key has to be real.** `ServiceUser` validates in its constructor and calls `createPrivateKey`,
  so a fixture with `key: 'fake'` fails with `ERR_OSSL_UNSUPPORTED` — a *different* failure mode from
  the one the test means to exercise. The format is `pkcs1`/`pem`, the same
  `-----BEGIN RSA PRIVATE KEY-----` Zitadel hands out.

---

## respondTo

**Location:** `test/bus/responder.ts`

**Description:** The `core` double: subscribes to a command **on the real bus** and answers a
prefabricated envelope. It is what makes the eight error situations testable without `core` and
without mocking the bus.

**Signature:**

```ts
function respondTo(
  nc: NatsConnection,
  command: string,
  replies: ResponderReply | ResponderReply[] | typeof MUTE,
): Promise<CoreResponder>;
```

**Usage:**

```ts
const responder = await respondTo(bus.connection, 'requirements.new', {
  status: 'success',
  data: { id: 42 },
});

// ... publish ...

expect(responder.count()).toBe(1);   // no retry
await responder.stop();
```

**Notes:**

- **It subscribes with a WILDCARD (`*.*.jiku-commands.v1.{command}`), never by rebuilding the
  subject**, and this is the rule that makes or breaks the helper. The `testing` convention says so
  outright: a responder that rebuilt the subject and got it wrong **the same way** the production code
  did would pass green with both halves broken — the test would be asserting the test's own
  reconstruction instead of the SDK's. Verified: the subject the SDK publishes is
  `test.test-machine-user.jiku-commands.v1.requirements.new`, and the wildcard covers `instance` and
  `userId` while `jiku-commands`, `v1` and the method stay literal.
- It exposes a **message counter**, which is what proves "no retry" (exactly 1 per publication) and
  "the local rejection never reached the wire" (exactly 0 for `JikuInvalidRequest`). Without the
  counter a silent retry would go unnoticed: the function's observable result would be identical.
  **Since S-029 the same counter is what proves the ABSENCE of a query** — `count() === 0` is the
  only way to assert that the new-mail branch never queried, that the cap's excedentes paid no
  query, and that a locally rejected attachment did not query.
- It accepts a **sequence** of replies, which is what makes the repeatability test direct (two runs
  answering `id: 1` and `id: 2`) without re-subscribing mid-test. Once exhausted it repeats the last
  one, so a test that publishes more gets a coherent answer instead of a timeout that would be
  diagnosed as something else.
- `MUTE` receives and does not answer, to provoke `JikuTimeout` **with a short timeout injected from
  the test** — never by lowering production's.
- It imports the NATS types from **`@gravadigital/jiku/nats`, never from `nats`**: `nats` is not a
  dependency of this project and must not become one (ADR-002). Two copies in the tree are two sets of
  error classes, and `instanceof` fails against the copy that threw. This holds in tests exactly as it
  does in production.
- It waits **deterministically** for the subscription to be live with `nc.flush()` — no wall-clock
  sleeps, which the convention forbids for waiting on a condition.
- Always `stop()` it: with `fileParallelism: false` and a shared bus, a live subscription from an
  earlier test is exactly the cross-contamination that sequential execution exists to avoid.

---

## respondToQuery

**Location:** `test/bus/responder.ts`

**Description:** The `core` double **for the read plane** (S-029). `respondTo()` hardcodes
`*.*.jiku-commands.v1.${command}` and **cannot answer a query at all** — without this helper not one
test of the reuse query is writable.

**Signature:**

```ts
function respondToQuery(
  nc: NatsConnection,
  method: string, // the FULL operation name, resource included: 'attachments.list'
  replies: ResponderReply | ResponderReply[] | typeof MUTE,
): Promise<CoreResponder>;
```

**Usage:**

```ts
const responderQuery = await respondToQuery(bus.connection, 'attachments.list', {
  status: 'success',
  data: { items: [{ id: 77, fileId: 1000, checksum }], page: { limit: 1, returned: 1 } },
});

// ... run the tick / call the lookup ...

// The payload observed on the bus carries `page: { limit: 1 }`, NOT a top-level `limit`.
expect(responderQuery.payloads()[0]).toMatchObject({ page: { limit: 1 } });
expect(responderQuery.count()).toBe(1);
await responderQuery.stop();
```

**Notes:**

- **Why a separate function and not a `plane: 'queries' | 'commands'` parameter on `respondTo()`.**
  The SDK declares the two planes as **separate subject tokens on purpose**
  (`SERVICE_QUERIES = "jiku-queries"`, `SERVICE_COMMANDS = "jiku-commands"`), with this reason
  verbatim in its `.d.ts`: *"They are separate subject tokens on purpose, not nested under one
  prefix: two queue groups over overlapping subjects would deliver each message to BOTH
  subscriptions, and a plain `request()` returns the first reply and discards the second silently."*
  A parameterised helper would invite a test to subscribe to both with a wider wildcard — exactly
  the overlap that separation avoids. **Two planes, two functions.**
- **What IS shared is the attention loop,** extracted into the private `attachResponder(nc,
  subjectPattern, replies)`, which both public helpers now delegate to. That loop is where the reply
  sequence and the message counter live, and duplicating it would let the two halves diverge — the
  one left behind being the one nobody looks at. `respondTo()`'s **signature did not change**: the
  whole existing suite calls it unmodified.
- **Same wildcard discipline:** `*.*.jiku-queries.v1.${method}` — wildcards on `instance` and
  `userId`, literal `jiku-queries` and `v1`. Never rebuild the full subject; that is the mistake
  that passes green with both halves broken.
- **Identical interface to `respondTo()`** — `subjects()`, `payloads()`, `count()`, `stop()` — so
  tests of the two planes read the same, and `ResponderReply`/`SuccessReply`/`FailureReply`/`MUTE`
  are **reused**, not redeclared: a `list` answers the *same* envelope as a command, with the
  collection (`{ items, page }`) in `data`.
- **The `method` is the full operation name with the resource included** (`attachments.list`),
  because that is how the SDK assembles it: `client.list('attachments', ...)` derives
  `attachments.list` and puts it as the subject's last token.
- Same `await nc.flush()` before returning and same `drain()` in `stop()`. Same reason to always
  `stop()` it.

---

## runImage() / inImage()

**Location:** `test/docker-image.test.ts`

**Description:** Runs the built `production` image as a real container. `runImage()` passes an
**explicit** environment (one `-e` per variable) and optional extra `docker run` arguments such as
read-only mounts; `inImage()` runs a shell command inside the image for filesystem inspections.

**Signature:**

```ts
function runImage(env: Record<string, string>, extraArgs?: readonly string[]): RunResult;
function inImage(shellCommand: string): RunResult;

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}
```

**Notes:**

- **`spawnSync`, never `execFileAsync`.** Most of these runs exit non-zero — the bus is unreachable
  from the test — and `execFileAsync` *rejects* in that case, hiding the streams that are exactly what
  has to be asserted. Same reasoning as `runDist()` in `build-runtime.test.ts`, one level up.
- **The environment is explicit and inherits nothing.** A test that inherits the host environment
  passes or fails according to what the developer has exported, which is the intermittent failure the
  `testing` convention forbids. A container only sees what it is given, so the isolation is even
  stronger than with a child process.
- **Never a `docker run` without a guarantee of termination.** The image's `CMD` leaves the worker
  *alive* if the connection succeeds; point `JIKU_SERVERS` at a closed port
  (`nats://127.0.0.1:1`) so the process dies on its own instead of hanging the suite.
- Every run carries `--rm` (no orphan containers) and an explicit timeout.

---

## parseDockerfile() / directiveLines() / stageBlock() / stageInstructions()

**Location:** `test/dockerfile.test.ts`

**Description:** Classifies each `Dockerfile` line as comment / directive / continuation, and slices
the file into per-stage blocks so assertions can target one stage.

**Signature:**

```ts
function parseDockerfile(contents: string): DockerfileLine[];
function directiveLines(lines: readonly DockerfileLine[], directive: string): DockerfileLine[];
function stageBlock(lines: readonly DockerfileLine[], stage: string): DockerfileLine[];
function stageInstructions(lines: readonly DockerfileLine[], stage: string): string;

interface DockerfileLine {
  readonly raw: string;
  readonly text: string;
  readonly isComment: boolean;
  readonly directive: string | null;
}
```

**Notes:**

- **This is not over-engineering a `grep`.** Every *absence* assertion has to ignore comment lines,
  because the comments the packaging story **requires** (CA-3: an unexplained absence is
  indistinguishable from an oversight) name `EXPOSE`, `HEALTHCHECK`, `npm install`, `python3` and
  `.env.defaults` in order to explain why they are not there. A naive whole-file search fails *because
  the documentation is correct* — the worst possible incentive.
- **`stageBlock()` exists because several properties are per-stage, not global.** `npm ci` without
  `--omit=dev` is correct in `test` and `builder` and a defect in `production`; asserting over the
  whole file conflates them.
- Do not grow this into a real `Dockerfile` parser. It reads a ~90-line file written by this same
  team, and a line scanner with `startsWith` is enough and stays readable.

---

## testLoggerWithCapture

**Location:** `test/ingesta/test-logger.ts`

**Description:** Builds a minimal valid `AppConfig` and a real `createLogger()` instance wired to an
in-memory `createLogCapture()`, for tests that call `normalize(raw, logger)` and need to assert on
what would have been logged. Local to `test/ingesta/`, following the same criterion as the existing
per-suite `configWith()` helpers in `test/bus/` and `test/publicacion/` — not promoted to
`test/shared/` because each suite already keeps its own.

**Signature:**

```ts
function testLoggerWithCapture(): { logger: Logger; capture: LogCapture }
```

**Usage example:**

```ts
import { normalize } from '#domain/ingesta/normalize.js';

import { testLoggerWithCapture } from './test-logger.js';

const { logger, capture } = testLoggerWithCapture();
await normalize(rawMail, logger);
const warnLine = capture.lines().find((line) => line['level'] === 'warn');
```

---

## fakeThreadsKv

**Location:** `test/ingesta/fake-threads-kv.ts`

**Description:** An in-memory double of the threads KV bucket, for the tick suites that are **not**
about the Thread Map.

**Signature:**

```ts
interface FakeThreadsKv {
  readonly kv: KV;
  readonly puts: { key: string; value: string }[];  // keys written, in order
  readonly gets: string[];                          // keys queried, in order
  seed(key: string, value: string): void;
}

function fakeThreadsKv(): FakeThreadsKv
```

**Usage example:**

```ts
import { fakeThreadsKv } from './fake-threads-kv.js';

const THREADS_KV = fakeThreadsKv().kv;

await runTick(source, BASE_CONFIG, logger, bus.client, THREADS_KV);
```

**Notes:**

- **It does not violate "the bus is never mocked".** The threads bucket is a dependency those suites
  neither exercise nor assert on; all they need is that the write the tick performs after each create
  does not fail, without forcing them to start a second container with JetStream.
- **The suites that ARE about the Thread Map run against a real KV** — `test/infra/kv/threads.test.ts`
  and `test/ingesta/tick-hilos.test.ts` both start their own `-js` container via
  `startJetStreamNats()`. That is where the behaviour matters and where it is verified.
- **It reproduces the one behaviour the code under test depends on:** `get()` returns `null` for a
  missing key rather than throwing. Getting that wrong would make `lookupThread()` look broken.
- **`puts` and `gets` make absence assertable** — e.g. "a mail with no `Message-Id` writes nothing"
  is `expect(spy.puts).toEqual([])`, which a store-only double could not express.
