import { describe, expect, it } from 'vitest';

import { REDACT_PATHS } from '#shared/log-redaction.js';

/**
 * Esta story ES LA PRIMERA que ejercita `REDACT_PATHS` con datos reales de mail (ver
 * `logging.test.ts`). Este archivo verifica la LISTA en si: que ya declaraba lo necesario antes de
 * que esta story existiera, y que sigue sin declarar lo que ADR-006 exige que se loguee.
 *
 * No la construye y no la modifica -- `src/shared/log-redaction.ts` no se toca (ver Story Plan,
 * Tarea 6, AC-9).
 */

describe('REDACT_PATHS already covered the mail paths before this story', () => {
  it('contains the mail body and attachment content paths, in both root and wildcard form', () => {
    // TS-45
    const paths: readonly string[] = REDACT_PATHS;

    for (const path of [
      'body',
      '*.body',
      'content',
      '*.content',
      'attachments[*].content',
      '*.attachments[*].content',
    ]) {
      expect(paths, `missing path ${path}`).toContain(path);
    }
  });
});

describe('subject, recipient and senderEmail are NOT redacted', () => {
  it('does not contain subject, recipient or senderEmail in REDACT_PATHS', () => {
    // TS-46
    const paths: readonly string[] = REDACT_PATHS;

    for (const field of ['subject', 'recipient', 'senderEmail']) {
      expect(paths, `${field} must not be redacted -- ADR-006 requires it loggable`).not.toContain(field);
      expect(paths).not.toContain(`*.${field}`);
    }
  });
});
