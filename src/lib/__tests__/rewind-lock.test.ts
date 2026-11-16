import { describe, expect, it } from 'vitest';
import { beginRewind, endRewind, isRewinding } from '../rewind-lock';

describe('rewind-lock', () => {
  it('同一标签页不能重复加锁，结束后可再次加锁', () => {
    expect(isRewinding('a')).toBe(false);
    expect(beginRewind('a')).toBe(true);
    expect(isRewinding('a')).toBe(true);
    expect(beginRewind('a')).toBe(false);
    endRewind('a');
    expect(isRewinding('a')).toBe(false);
    expect(beginRewind('a')).toBe(true);
    endRewind('a');
  });

  it('各标签页互不影响', () => {
    expect(beginRewind('a')).toBe(true);
    expect(isRewinding('b')).toBe(false);
    expect(beginRewind('b')).toBe(true);
    endRewind('a');
    expect(isRewinding('a')).toBe(false);
    expect(isRewinding('b')).toBe(true);
    endRewind('b');
  });

  it('空标签页 ID 视为未在回退', () => {
    expect(isRewinding(null)).toBe(false);
    expect(isRewinding(undefined)).toBe(false);
  });
});
