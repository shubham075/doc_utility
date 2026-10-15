import { describe, expect, it } from 'vitest';
import type { TextItem } from '@pdfsuite/engine';
import { compileQuery, findPatterns, luhn } from './redactPatterns';

const item = (str: string, x = 10, y = 20, hasEOL = true): TextItem => ({ str, x, y, width: str.length * 5, height: 10, fontSize: 10, ascent: 0.8, angle: 0, hasEOL }) as unknown as TextItem;

describe('redaction patterns', () => {
  it('checks card numbers with the Luhn checksum', () => {
    expect(luhn('4111 1111 1111 1111')).toBe(true);
    expect(luhn('4111 1111 1111 1112')).toBe(false);
    expect(luhn('1234')).toBe(false);
  });

  it('finds SSNs, emails and valid cards but not look-alikes', () => {
    const items = [item('SSN 123-45-6789 and 1234-56-78901'), item('mail alice@example.com now'), item('card 4111 1111 1111 1111 vs 4111 1111 1111 1112')];
    const found = findPatterns(0, items, compileQuery({ kinds: ['ssn', 'email', 'card'] }));
    expect(found.map((f) => f.text).sort()).toEqual(['123-45-6789', '4111 1111 1111 1111', 'alice@example.com']);
    expect(found.every((f) => f.rects.length >= 1 && f.rects[0]!.width > 0)).toBe(true);
  });

  it('matches words and custom expressions and reports bad ones', () => {
    const items = [item('Project  Falcon is secret'), item('code ZX-12')];
    expect(findPatterns(2, items, compileQuery({ kinds: [], words: ['project falcon'], regex: 'Z[A-Z]-\\d+' })).map((f) => f.text)).toEqual(['Project  Falcon', 'ZX-12']);
    expect(() => compileQuery({ kinds: [], regex: '(' })).toThrow(/Invalid expression/);
  });

  it('spans text runs', () => {
    const items = [item('call 555-12', 10, 20, false), item('3-4567 today')];
    const m = findPatterns(0, items, compileQuery({ kinds: ['phone'] }));
    expect(m).toHaveLength(1);
    expect(m[0]!.rects).toHaveLength(2);
  });
});
