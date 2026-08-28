import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';

import { extractAddress, mergeReferenceIds, pickRecipient } from '#domain/ingesta/headers.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/mails/', import.meta.url));

function fixture(name: string): Buffer {
  return readFileSync(`${FIXTURES_DIR}${name}`);
}

describe('mergeReferenceIds', () => {
  it('merges and dedupes, preserving order with In-Reply-To first', () => {
    // TS-9
    expect(mergeReferenceIds('<a@x>', ['<a@x>', '<b@x>'])).toEqual(['<a@x>', '<b@x>']);
  });

  it('tolerates references as a single string (mailparser returns string, not array)', () => {
    // TS-11
    expect(mergeReferenceIds(undefined, '<only@x>')).toEqual(['<only@x>']);
  });

  it('returns an empty array for a new mail with neither header', () => {
    expect(mergeReferenceIds(undefined, undefined)).toEqual([]);
  });

  it('never throws', () => {
    expect(() => mergeReferenceIds(undefined, undefined)).not.toThrow();
  });
});

describe('pickRecipient', () => {
  it('prefers Delivered-To over To', async () => {
    // TS-13
    const parsed = await simpleParser(fixture('delivered-to-multiple.eml'), { skipHtmlToText: true });
    expect(pickRecipient(parsed)).toBe('tickets+alfa@grava.io');
  });

  it('falls back to To when there is no Delivered-To', async () => {
    // TS-15
    const parsed = await simpleParser(fixture('to-fallback.eml'), { skipHtmlToText: true });
    expect(pickRecipient(parsed)).toBe('tickets+beta@grava.io');
  });

  it('returns only the first Delivered-To when there are two, never joined with a comma', () => {
    // TS-16: sin depender de mailparser, para poder afirmar exactamente el defecto que NO se porta.
    const headers = new Map<string, unknown>([
      [
        'delivered-to',
        [
          { value: [{ address: 'tickets+alfa@grava.io', name: '' }], html: '', text: 'tickets+alfa@grava.io' },
          { value: [{ address: 'otro@grava.io', name: '' }], html: '', text: 'otro@grava.io' },
        ],
      ],
    ]);
    const parsed = { headers, to: { text: 'soporte@grava.io' } } as Parameters<typeof pickRecipient>[0];

    const recipient = pickRecipient(parsed);
    expect(recipient).toBe('tickets+alfa@grava.io');
    expect(recipient).not.toContain(', ');
    expect(recipient).not.toContain('otro@grava.io');
  });

  it('returns an empty string when neither header is present', () => {
    // TS-17 (parte de pickRecipient)
    const headers = new Map<string, unknown>();
    const parsed = { headers, to: undefined } as Parameters<typeof pickRecipient>[0];

    expect(pickRecipient(parsed)).toBe('');
  });

  it('never throws', () => {
    const headers = new Map<string, unknown>();
    const parsed = { headers, to: undefined } as Parameters<typeof pickRecipient>[0];

    expect(() => pickRecipient(parsed)).not.toThrow();
  });
});

describe('extractAddress', () => {
  it('isolates the address from a display-name form', () => {
    // TS-18
    expect(extractAddress('Juan Pérez <juan@cliente.com>')).toBe('juan@cliente.com');
  });

  it('returns the trimmed address as-is when From is a bare address', () => {
    // TS-19
    expect(extractAddress('juan@cliente.com')).toBe('juan@cliente.com');
  });

  it('returns an empty string when there is no From header', () => {
    // TS-20
    expect(extractAddress(undefined)).toBe('');
  });

  it('never throws', () => {
    expect(() => extractAddress(undefined)).not.toThrow();
  });
});
