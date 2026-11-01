import { describe, it, expect } from 'vitest';
import { samePath } from '../home-dir';

describe('samePath', () => {
  it('忽略大小写、斜杠方向和末尾斜杠', () => {
    expect(samePath('C:\\Users\\Administrator', 'c:/users/administrator/')).toBe(true);
    expect(samePath('C:\\Users\\Administrator\\', 'C:\\Users\\Administrator')).toBe(true);
  });

  it('子目录和空路径不算相同', () => {
    expect(samePath('C:\\Users\\Administrator\\proj', 'C:\\Users\\Administrator')).toBe(false);
    expect(samePath('', '')).toBe(false);
    expect(samePath('C:\\Users\\Administrator', '')).toBe(false);
  });
});
