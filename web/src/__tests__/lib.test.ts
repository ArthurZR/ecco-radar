import { describe, expect, it } from 'vitest';
import { wordDiff } from '../lib/diff';
import { niceTicks } from '../components/charts';
import { qs } from '../lib/api';
import { fmtPct, hostOf } from '../lib/format';

describe('wordDiff', () => {
  it('marks added and removed words and reassembles both texts', () => {
    const a = 'Poster by an unknown designer, 1987.';
    const b = 'Poster by Example Designer, 1987.';
    const d = wordDiff(a, b);
    expect(d.filter((p) => p.kind !== 'add').map((p) => p.text).join('')).toBe(a);
    expect(d.filter((p) => p.kind !== 'del').map((p) => p.text).join('')).toBe(b);
    expect(d.some((p) => p.kind === 'add' && p.text.includes('Example'))).toBe(true);
  });
});

describe('niceTicks', () => {
  it('covers the range with round steps', () => {
    const t = niceTicks(0, 9349);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(9349);
    expect(t).toEqual([0, 2500, 5000, 7500, 10000]);
  });
});

describe('helpers', () => {
  it('qs drops empty values and joins arrays', () => {
    expect(qs({ a: '', b: undefined, status: ['saved', 'rejected'], n: 0 })).toBe('?status=saved%2Crejected&n=0');
  });
  it('formats percentages and hosts', () => {
    expect(fmtPct(0.0552, 2)).toBe('5.52%');
    expect(fmtPct(null)).toBe('—');
    expect(hostOf('https://www.example.org/x')).toBe('example.org');
  });
});
