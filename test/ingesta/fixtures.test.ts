import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';

/**
 * Test de sanidad de los fixtures `.eml` (Tarea 2).
 *
 * No prueba `normalize()` -- eso lo hacen las Tareas 3 a 6. Este archivo prueba que cada fixture
 * ES un mail RFC 822 parseable por `simpleParser`, para que un fixture mal formado falle ACA y no
 * dentro de un test de otra tarea, donde el error real quedaria escondido detras de una aserción
 * que no tiene nada que ver con el formato del archivo.
 *
 * `no-message-id.eml` es intencionalmente parseable pero sin `Message-Id`: es el fixture que
 * ejercita el descarte de CA-1, no un fixture mal formado.
 */

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/mails/', import.meta.url));

function fixtureFiles(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith('.eml'))
    .sort();
}

describe('test/fixtures/mails/*.eml', () => {
  it('has every fixture the testing convention and this story enumerate', () => {
    const expected = [
      'plain-text.eml',
      'html-only.eml',
      'quoted-reply.eml',
      're-re-fwd-subject.eml',
      'no-message-id.eml',
      'no-body.eml',
      'with-attachments.eml',
      'duplicate-attachments.eml',
      'inline-image.eml',
      'in-reply-to.eml',
      'delivered-to-multiple.eml',
      'to-fallback.eml',
      'no-recipient.eml',
      'both-text-and-html.eml',
      'single-reference.eml',
      'no-subject.eml',
      'subject-only-prefixes.eml',
      'declared-mime-mismatch.eml',
      'oversized-and-exe.eml',
      'attachment-without-filename.eml',
      'sensitive-body.eml',
      'html-only-quoted-reply.eml',
      // S-029: la respuesta que ARRASTRA el adjunto del original — el caso que motiva REQ-006, y el
      // unico fixture con `References` poblado Y un adjunto con bytes reales al mismo tiempo.
      'reply-with-dragged-attachment.eml',
    ].sort();

    expect(fixtureFiles()).toEqual(expected);
  });

  it.each(fixtureFiles())('%s parses without throwing', async (name) => {
    const raw = readFileSync(join(FIXTURES_DIR, name));

    await expect(simpleParser(raw, { skipHtmlToText: true })).resolves.toBeDefined();
  });

  it('html-only.eml carries the img and href that CA-11 requires', async () => {
    const raw = readFileSync(join(FIXTURES_DIR, 'html-only.eml'));
    const parsed = await simpleParser(raw, { skipHtmlToText: true });

    expect(parsed.html).toContain('<img src="logo.png">');
    expect(parsed.html).toContain('<a href="http://x">acá</a>');
  });

  it('inline-image.eml carries one attachment and one inline part with a Content-Id', async () => {
    const raw = readFileSync(join(FIXTURES_DIR, 'inline-image.eml'));
    const parsed = await simpleParser(raw, { skipHtmlToText: true });

    expect(parsed.attachments).toHaveLength(2);
    const inline = parsed.attachments.find((att) => att.contentDisposition === 'inline');
    expect(inline?.contentId).toBe('<logo>');
  });
});
