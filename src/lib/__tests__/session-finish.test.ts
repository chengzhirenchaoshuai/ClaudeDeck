import { describe, expect, it } from 'vitest';
import { finishedSessionIds, finishedTerminalSessionIds } from '../session-finish';

describe('finishedTerminalSessionIds', () => {
  it('只有 busy → idle 算回复完成', () => {
    const prev = new Map([['a', 'busy'], ['b', 'idle'], ['c', 'busy'], ['d', 'busy']]);
    const next = new Map([['a', 'idle'], ['b', 'idle'], ['c', 'busy']]);
    // d 消失（终端退出或切换了远程主机）不算
    expect(finishedTerminalSessionIds(prev, next)).toEqual(['a']);
  });

  it('首次轮询（之前没有记录）不算', () => {
    expect(finishedTerminalSessionIds(new Map(), new Map([['a', 'idle']]))).toEqual([]);
  });
});

describe('finishedSessionIds', () => {
  it('草稿升级为正式会话（同时有移除和新增）不算结束', () => {
    expect(finishedSessionIds(new Set(['desk_1']), new Set(['real']))).toEqual([]);
    expect(finishedSessionIds(new Set(['a', 'b']), new Set(['b']))).toEqual(['a']);
  });
});
