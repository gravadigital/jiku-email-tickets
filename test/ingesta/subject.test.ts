import { describe, expect, it } from 'vitest';

import { cleanSubject } from '#domain/ingesta/subject.js';

describe('cleanSubject', () => {
  it('strips stacked prefixes iteratively', () => {
    // TS-4
    expect(cleanSubject('Re: Re: Fwd: Falla en el login')).toBe('Falla en el login');
  });

  it('strips prefixes case-insensitively, including RV', () => {
    // TS-6
    expect(cleanSubject('RV: re: FWD: problema')).toBe('problema');
  });

  it('leaves an empty string when the subject was only prefixes', () => {
    // TS-7
    expect(cleanSubject('Re: Fwd:')).toBe('');
  });

  it('never throws on an empty string', () => {
    expect(cleanSubject('')).toBe('');
  });

  it('leaves a subject without any prefix untouched', () => {
    expect(cleanSubject('Falla en el login')).toBe('Falla en el login');
  });
});
