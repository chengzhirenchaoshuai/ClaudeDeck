import { describe, expect, it } from 'vitest';
import { parseSessionMessages } from '../session-loader';

describe('session history loading', () => {
  it('drops replayed JSONL records with the same source UUID', () => {
    const user = {
      type: 'user',
      uuid: 'user-1',
      timestamp: 1,
      message: { content: [{ type: 'text', text: 'hello' }] },
    };
    const assistant = {
      type: 'assistant',
      uuid: 'assistant-1',
      timestamp: 2,
      message: { content: [{ type: 'text', text: 'world' }] },
    };
    const loaded = parseSessionMessages([user, assistant, user, assistant]);
    expect(loaded.messages.map((message) => message.content)).toEqual(['hello', 'world']);
  });

  it('压缩边界之后的摘要与文件记录合并成一条压缩提示（结构取自真实会话 JSONL）', () => {
    const loaded = parseSessionMessages([
      { type: 'user', uuid: 'u1', timestamp: 1, message: { content: [{ type: 'text', text: 'hello' }] } },
      {
        type: 'system', subtype: 'compact_boundary', uuid: 'b1', content: 'Conversation compacted', isMeta: false,
        timestamp: '2026-10-22T10:00:00.000Z',
        compactMetadata: { trigger: 'auto', preTokens: 218154, postTokens: 12720 },
      },
      { type: 'user', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation…' } },
      { type: 'attachment', attachment: { type: 'file', filename: 'F:\p\a.py', displayPath: 'a.py', content: 'x' } },
      { type: 'attachment', attachment: { type: 'compact_file_reference', filename: 'F:\p\b.py', displayPath: 'b.py' } },
      { type: 'attachment', attachment: { type: 'deferred_tools_delta' } },
      { type: 'user', uuid: 'u2', timestamp: 3, message: { content: [{ type: 'text', text: 'next' }] } },
      // 压缩之后用户再引用文件：不应算进压缩提示
      { type: 'attachment', attachment: { type: 'file', filename: 'F:\p\c.py', displayPath: 'c.py' } },
    ]);
    const kinds = loaded.messages.map((m) => m.commandType ?? m.content);
    expect(kinds).toEqual(['hello', 'compact', 'next']);
    const notice = loaded.messages[1].commandData!;
    expect(notice.trigger).toBe('auto');
    expect(notice.preTokens).toBe(218154);
    expect(notice.postTokens).toBe(12720);
    expect(notice.summary).toMatch(/^This session is being continued/);
    expect(notice.files).toEqual([
      { path: 'F:\p\a.py', display: 'a.py', full: true },
      { path: 'F:\p\b.py', display: 'b.py', full: false },
    ]);
  });

  it('手动压缩：摘要与文件之间夹着 /compact 命令记录，文件仍归入压缩提示', () => {
    const loaded = parseSessionMessages([
      { type: 'system', subtype: 'compact_boundary', uuid: 'b2', compactMetadata: { trigger: 'manual', preTokens: 319973, postTokens: 30000 } },
      { type: 'user', isCompactSummary: true, message: { content: 'This session is being continued…' } },
      { type: 'user', isMeta: true, message: { content: '<local-command-caveat>…</local-command-caveat>' } },
      { type: 'user', message: { content: '<command-name>/compact</command-name>' } },
      { type: 'attachment', attachment: { type: 'file', filename: 'F:\p\d.py', displayPath: 'd.py' } },
    ]);
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.messages[0].commandData!.trigger).toBe('manual');
    expect(loaded.messages[0].commandData!.files).toHaveLength(1);
  });
});
