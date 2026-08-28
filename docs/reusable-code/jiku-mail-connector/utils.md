# Utils/Helpers - jiku-mail-connector

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
