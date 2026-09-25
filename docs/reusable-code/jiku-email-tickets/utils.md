# Utils/Helpers - jiku-email-tickets

## sha256hex

**Location:** `src/infra/kv/threads.ts`

**Description:** The sha256 of a string, hex-encoded — 64 chars of `[0-9a-f]` — over the value
**exactly as given**. No `trim()`, no `toLowerCase()`, no normalization of any kind. Pure, never
throws.

It is how the Thread Map's key is built from a raw `Message-Id` (with its brackets, as `mailparser`
delivers it), and the reason is not convenience:

- **Why hash at all.** `validKeyRe` in `@nats-io/kv` (`lib/kv.js:86`) is `/^[-/=.\w]+$/` and
  therefore **rejects `<`, `>` and `@`** — all three present in a real `Message-Id`. An invalid key
  makes the library throw a **plain** `Error`, with no distinctive `name` or `code`, so there is no
  structural diagnosis to recover from it: the defence is never to produce one.
- **Why no normalization instead.** Escaping or normalizing the `Message-Id` so it fits the regex
  would let **two distinct `Message-Id`s collapse onto the same key** and route a comment to the
  **wrong requirement**. The accepted trade-off is that keys are not readable with `nats kv ls`.

**Signature:**

```ts
function sha256hex(value: string): string
```

**Usage example:**

```ts
import { sha256hex } from '#infra/kv/threads.js';

sha256hex('<abc@cliente.com>'); // '7482ad61…' (64 hex chars)

// Case and whitespace are NOT normalized away — they produce different keys, on purpose.
sha256hex('<ABC@cliente.com>') !== sha256hex('<abc@cliente.com>'); // true
```

---

## parsePositiveId

**Location:** `src/infra/kv/parse.ts`

**Description:** Parses a **safe, strictly positive integer** from the raw text of a KV entry,
returning `undefined` for anything that is not one. The caller logs and skips.

`Number.parseInt` rather than `Number()`: `Number('4.5')` is `4.5` and `Number('')` is `0`, so the
validation would have to catch both anyway, but `parseInt` makes the attempt explicit.
`Number.isSafeInteger` rather than `Number.isInteger`: an id that does not survive the round trip
through `double` is not an id, it is a corrupt value. And the comparison
`String(parsed) === raw.trim()` is what rejects `'4.5'`, `'42abc'` and `'0x2a'` — a value that does
not **re-serialize identically** was not an integer, it was something else that started with one.

Shared by both KV buckets — the Ticket Map's `projectId` (`ticket-map.ts`) and the Thread Map's
`requirementId` (`threads.ts`). It lives extracted precisely so there is one copy: two would diverge
on the first change, and the one that would diverge silently is the bucket read less often.

**Signature:**

```ts
function parsePositiveId(raw: string): number | undefined
```

**Usage example:**

```ts
import { parsePositiveId } from '#infra/kv/parse.js';

parsePositiveId('42');      // 42
parsePositiveId('  42  ');  // 42
parsePositiveId('0');       // undefined
parsePositiveId('-3');      // undefined
parsePositiveId('4.5');     // undefined
parsePositiveId('42abc');   // undefined
parsePositiveId('0x2a');    // undefined
```

---

## cleanSubject

**Location:** `src/domain/ingesta/subject.ts`

**Description:** Strips `Re:`, `Fwd:` and `RV:` prefixes from a mail subject, iteratively and
case-insensitively, along with the space that follows each prefix. A subject that was only prefixes
is left as `''`, which is a valid state, not an error. Pure, never throws.

**Signature:**

```ts
function cleanSubject(subject: string): string
```

**Usage example:**

```ts
import { cleanSubject } from '#domain/ingesta/subject.js';

cleanSubject('Re: Re: Fwd: Falla en el login'); // 'Falla en el login'
cleanSubject('Re: Fwd:'); // ''
```

---

## mergeReferenceIds

**Location:** `src/domain/ingesta/headers.ts`

**Description:** Builds the deduplicated union of a mail's `In-Reply-To` and `References` headers,
preserving order of appearance with `In-Reply-To` first. Tolerates `references` as `string`,
`string[]`, or `undefined` — `mailparser` returns a bare string when there is a single reference and
an array when there are several. Uses `Set` to preserve insertion order; never sorts by anything
else.

**Signature:**

```ts
function mergeReferenceIds(
  inReplyTo: string | undefined,
  references: string | string[] | undefined,
): string[]
```

**Usage example:**

```ts
import { mergeReferenceIds } from '#domain/ingesta/headers.js';

mergeReferenceIds('<a@x>', ['<a@x>', '<b@x>']); // ['<a@x>', '<b@x>']
```

---

## pickRecipient

**Location:** `src/domain/ingesta/headers.ts`

**Description:** Picks the raw recipient: the first `Delivered-To` header, with `To` as fallback,
`''` if neither is present. **Deliberately takes only the first** `Delivered-To` when there are
several — it is the most recent hop's recipient, the one that preserves the subaddress. Does **not**
join multiple values with `', '` (a defect verified in the legacy service this was ported from,
whose hand-built test fixtures never exercised the real multi-header shape).

**Signature:**

```ts
function pickRecipient(parsed: Pick<ParsedMail, 'headers' | 'to'>): string
```

**Usage example:**

```ts
import { pickRecipient } from '#domain/ingesta/headers.js';

pickRecipient(parsedMail); // 'tickets+alfa@grava.io' (raw, no slug extracted)
```

**Notes:** Never extracts a slug from the recipient — that is out of scope for this story (FG-3).

---

## extractAddress

**Location:** `src/domain/ingesta/headers.ts`

**Description:** Isolates the email address from any `Nombre <mail@dominio>`-style header,
preserving the original casing. Returns the trimmed address as-is when `from` is already a bare
address, and `''` when `from` is `undefined`. Pure, never throws. Renamed from `extractSenderEmail`
in S-013 when `ruteo` started reusing it on `recipient` (not just `From`) — the old name would have
misdescribed its input there.

**Signature:**

```ts
function extractAddress(from: string | undefined): string
```

**Usage example:**

```ts
import { extractAddress } from '#domain/ingesta/headers.js';

extractAddress('Juan Pérez <juan@cliente.com>'); // 'juan@cliente.com'
extractAddress('Soporte Tickets <TICKETS+Alfa@grava.io>'); // 'TICKETS+Alfa@grava.io'
```

---

## toPlainText

**Location:** `src/domain/ingesta/body.ts`

**Description:** Resolves the mail body's plain text: the `text/plain` part when it has content, or
the `text/html` part converted with `html-to-text` (no `href`, `img` skipped, line breaks preserved)
when that is the only part available. Empty string when neither is present — a valid state, not an
error. Requires the mail to have been parsed with `simpleParser(raw, { skipHtmlToText: true })`,
otherwise `mailparser` synthesizes `text` from the HTML and this function's branch selection breaks
silently.

**Signature:**

```ts
function toPlainText(parsed: { text?: string; html: string | false }): string
```

**Usage example:**

```ts
import { toPlainText } from '#domain/ingesta/body.js';

toPlainText({ text: '', html: '<p>Hola</p><img src="x.png">' }); // 'Hola'
```

---

## trimQuotedText

**Location:** `src/domain/ingesta/body.ts`

**Description:** Trims the quoted thread text from a reply body, as a **best-effort heuristic, not a
guarantee**. Cuts at the first line matching one of five markers (a `>` quote prefix, English "On
... wrote:", Spanish "El ... escribió:", "-----Original Message-----", or a line of 5+ underscores).
If no marker matches, **prefers to keep** and returns the whole body — a false positive that trims
legitimate client content is the expensive failure. Ported unchanged from the existing service in
production (Arq-9); this heuristic is deliberately never reinvented. Pure, never throws, including on
`''`.

**Signature:**

```ts
function trimQuotedText(body: string): string
```

**Usage example:**

```ts
import { trimQuotedText } from '#domain/ingesta/body.js';

trimQuotedText('Se soluciona reiniciando\n> No arranca'); // 'Se soluciona reiniciando'
```

---

## buildRequirementPayload

**Location:** `src/domain/publicacion/mail-payload.ts`

**Description:** Builds the `requirements.new` payload derived from an already-normalized and routed
mail. Pure: only assembles the object, never validates (that is `parseNewRequirement()`, invoked from
`publish-requirement.ts`) and never publishes. `title` and `description` follow a strict **trim →
truncate → placeholder** order that is not interchangeable: `title` is trimmed, sliced to
`TITLE_MAX_LENGTH` (255, imported from `requirement.schema.ts`, never redeclared as a literal), and
replaced with `ruteoConfig.placeholderTitle` only if the result is `''`; `description` is trimmed and
replaced with `ruteoConfig.placeholderBody` under the same empty-string condition, with no length cap.
Reversing the order — placeholder before truncate — would let a 400-space subject produce an empty
`title` that the schema's `min(1)` rejects, losing the mail to a connector assembly error instead of
creating the requirement with the placeholder. `type`, `priority` and `visibilityLevel` are fixed
connector policy, not contract defaults. `creator` carries `userId` even though `core` ignores it and
resolves the actor from the subject's `sub` (ADR-005) — sent because the request asks for it
explicitly, not because the connector decides identity. Renamed in the S-016 catalog cleanup: the
original story (REQ-003) anticipated a `buildMailPayload()`/`truncateTitle()` pair that does not exist
in the implemented code — the truncation lives inline inside this single function instead.

**Since S-021:** accepts an optional `fileIds: readonly number[]` (default `[]`), the accumulated ids
of successfully-uploaded attachments. The returned object includes the `fileIds` key **only** when the
array has at least one element — never `fileIds: undefined`, never `fileIds: []` — via a conditional
spread, copying the array rather than keeping the caller's mutable reference. The `description` param
is still the simple `cuerpoBase`: composing the four-block description (with rejection/failure notices
and placeholders) is the caller's job (`tick.ts`, via `componerDescripcion()`), not this function's —
it stays a single-responsibility "assemble the payload from already-resolved pieces."

**Signature:**

```ts
function buildRequirementPayload(
  mail: Pick<IncomingMail, 'subject' | 'body'>,
  projectId: number,
  userId: string,
  ruteoConfig: Pick<RuteoConfig, 'placeholderTitle' | 'placeholderBody'>,
  fileIds?: readonly number[], // default []
): NewRequirementPayload
```

**Usage example:**

```ts
import { buildRequirementPayload } from '#domain/publicacion/mail-payload.js';

buildRequirementPayload(
  { subject: 'Falla en el login', body: 'No puedo entrar' },
  42,
  'machine-user-abc',
  { placeholderTitle: 'Ticket recibido por mail', placeholderBody: '(mail sin contenido)' },
  [101, 102],
);
// { title: 'Falla en el login', description: 'No puedo entrar', projectId: 42,
//   type: 'incidencia', priority: 'sin_prioridad', visibilityLevel: 'public', creator: 'machine-user-abc',
//   fileIds: [101, 102] }
```

---

## resolveCuerpoBase

**Location:** `src/domain/publicacion/mail-payload.ts`

**Description:** Extracted in S-021 from what used to be inline logic inside
`buildRequirementPayload()`: trim the mail body, replace with `ruteoConfig.placeholderBody` if the
trimmed result is `''`, no length cap. Exists as its own function so `tick.ts` can compute the exact
same `cuerpoBase` it needs to pass into `componerDescripcion()` — one calculation, shared, instead of
being duplicated (and risking divergence) between `mail-payload.ts` and `tick.ts`.

**Signature:**

```ts
function resolveCuerpoBase(
  body: string,
  ruteoConfig: Pick<RuteoConfig, 'placeholderBody'>,
): string
```

**Usage example:**

```ts
import { resolveCuerpoBase } from '#domain/publicacion/mail-payload.js';

resolveCuerpoBase('   ', { placeholderBody: '(mail sin contenido)' });
// '(mail sin contenido)'
resolveCuerpoBase('No puedo entrar', { placeholderBody: '(mail sin contenido)' });
// 'No puedo entrar'
```

---

## componerDescripcion

**Location:** `src/domain/publicacion/description.ts`

**Description:** Deterministically composes the requirement's final `description` from four
already-resolved blocks, in this fixed order: body, rejection notices, upload-failure notices, file
placeholders (always last). Pure, no injected dependencies — same spirit as `particionar()` /
`deduplicar()` / `aplicarTope()` from S-017. Does **not** know the origin of any input: it does not
know whether a rejection notice came from the local policy, from `core`, or from the cap being
exceeded, and it does not know whether a placeholder is for an image — it only receives already-
formatted strings from the caller (S-021 wires the real orchestration). Never truncates, never
throws, never logs. Builds one flat array of only the non-empty parts and joins them with `'\n'`,
so an empty block never leaves a dangling separator.

**Signature:**

```ts
interface ComposicionDescripcionInput {
  readonly cuerpoBase: string;
  readonly avisosDeRechazo: readonly string[];
  readonly avisosDeFallo: readonly string[];
  readonly placeholders: readonly string[];
}

function componerDescripcion(input: ComposicionDescripcionInput): string
```

**Usage example:**

```ts
import { componerDescripcion } from '#domain/publicacion/description.js';

componerDescripcion({
  cuerpoBase: '(mail sin contenido)',
  avisosDeRechazo: ['No se aceptó captura.png: tamaño excedido'],
  avisosDeFallo: [],
  placeholders: [],
});
// '(mail sin contenido)\nNo se aceptó captura.png: tamaño excedido'
```
