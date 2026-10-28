import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../stores/chatStore';
import { computeTurnDurations } from '../turns';

const msg = (id: string, role: ChatMessage['role'], timestamp: number | string, type: ChatMessage['type'] = 'text'): ChatMessage =>
  ({ id, role, type, content: id, timestamp: timestamp as number });

describe('computeTurnDurations', () => {
  it('从用户消息到这一轮最后一条回复计时，记在最后一条消息上', () => {
    const messages = [
      msg('u1', 'user', 1_000),
      msg('t1', 'assistant', 2_000, 'tool_use'),
      msg('a1', 'assistant', 84_000),
      msg('u2', 'user', 100_000),
      msg('a2', 'assistant', 105_500),
    ];
    const d = computeTurnDurations(messages, false);
    expect(d.get('a1')).toBe(83_000);
    expect(d.get('a2')).toBe(5_500);
    expect(d.size).toBe(2);
  });

  it('从磁盘加载的 ISO 字符串时间戳也能计算（例子取自真实会话）', () => {
    const messages = [
      msg('u1', 'user', '2026-10-28T01:32:28.780Z'),
      msg('a1', 'assistant', '2026-10-28T01:33:12.000Z'),
    ];
    expect(computeTurnDurations(messages, false).get('a1')).toBe(43_220);
  });

  it('运行中时最后一轮不显示，前面已结束的轮次照常显示', () => {
    const messages = [
      msg('u1', 'user', 0),
      msg('a1', 'assistant', 3_000),
      msg('u2', 'user', 10_000),
      msg('a2', 'assistant', 12_000),
    ];
    const d = computeTurnDurations(messages, true);
    expect(d.get('a1')).toBe(3_000);
    expect(d.has('a2')).toBe(false);
  });

  it('没有回复的轮次和时间戳异常的轮次不显示', () => {
    const messages = [
      msg('u1', 'user', 5_000),
      msg('u2', 'user', 6_000),
      msg('a2', 'assistant', 1_000),
    ];
    expect(computeTurnDurations(messages, false).size).toBe(0);
  });
});
