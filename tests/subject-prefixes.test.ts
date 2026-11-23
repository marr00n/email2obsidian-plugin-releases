import { describe, it, expect } from 'vitest';
import { parsePrefixList, stripSubjectPrefixes } from '../src/subject-prefixes';

describe('parsePrefixList', () => {
  it('splits on commas and trims whitespace', () => {
    expect(parsePrefixList('RE:, FWD:, FWD-')).toEqual(['RE:', 'FWD:', 'FWD-']);
  });

  it('drops empty entries from stray commas', () => {
    expect(parsePrefixList('RE:,, FWD:,')).toEqual(['RE:', 'FWD:']);
  });

  it('returns an empty list for a blank string', () => {
    expect(parsePrefixList('   ')).toEqual([]);
  });
});

describe('stripSubjectPrefixes (literal list)', () => {
  const config = { value: 'RE:, FWD:, FWD-' };

  it('strips a single matching prefix', () => {
    expect(stripSubjectPrefixes('RE: Invoice', config)).toBe('Invoice');
  });

  it('matches case-insensitively', () => {
    expect(stripSubjectPrefixes('re: Invoice', config)).toBe('Invoice');
    expect(stripSubjectPrefixes('Fwd- Invoice', config)).toBe('Invoice');
  });

  it('strips repeated/chained prefixes', () => {
    expect(stripSubjectPrefixes('Re: Fwd: Re: Invoice', config)).toBe('Invoice');
  });

  it('leaves a prefix in the middle of the subject alone', () => {
    expect(stripSubjectPrefixes('Invoice RE: December', config)).toBe('Invoice RE: December');
  });

  it('leaves the subject untouched when nothing configured', () => {
    expect(stripSubjectPrefixes('RE: Invoice', {})).toBe('RE: Invoice');
    expect(stripSubjectPrefixes('RE: Invoice', { value: '' })).toBe('RE: Invoice');
    expect(stripSubjectPrefixes('RE: Invoice', { value: '   ' })).toBe('RE: Invoice');
  });

  it('leaves the subject untouched when no prefix matches', () => {
    expect(stripSubjectPrefixes('Invoice', config)).toBe('Invoice');
  });

  it('can strip down to an empty string', () => {
    expect(stripSubjectPrefixes('RE:', config)).toBe('');
  });
});

describe('stripSubjectPrefixes (regex)', () => {
  it('strips using a user-supplied pattern, anchored to the start', () => {
    const result = stripSubjectPrefixes('Re[3]: Invoice', {
      value: 're(\\[\\d+\\])?:',
      useRegex: true,
    });
    expect(result).toBe('Invoice');
  });

  it('applies the pattern repeatedly for chained prefixes', () => {
    const result = stripSubjectPrefixes('Re: Fwd: Invoice', {
      value: '(re|fwd):',
      useRegex: true,
    });
    expect(result).toBe('Invoice');
  });

  it('matches case-insensitively even though the source has no flags', () => {
    expect(stripSubjectPrefixes('RE: Invoice', { value: 're:', useRegex: true })).toBe('Invoice');
  });

  it('reports an invalid pattern and leaves the subject untouched', () => {
    const warnings: string[] = [];
    const result = stripSubjectPrefixes(
      'RE: Invoice',
      { value: '(unclosed', useRegex: true },
      (msg) => warnings.push(msg)
    );
    expect(result).toBe('RE: Invoice');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('not a valid regular expression');
  });

  it('never strips a match from the middle of the subject', () => {
    const result = stripSubjectPrefixes('Invoice RE: December', {
      value: 're:',
      useRegex: true,
    });
    expect(result).toBe('Invoice RE: December');
  });
});
