import { describe, expect, it } from 'vitest';
import { defaultExportFileName, pickPixelRatio, selectExportMessages } from '../export-image';
import { parseTurns } from '../turns';
import type { ChatMessage } from '../../stores/chatStore';

const m = (id: string, role: ChatMessage['role'], type: ChatMessage['type'] = 'text', content = id): ChatMessage => ({
  id, role, type, content, timestamp: 0,
});

const messages: ChatMessage[] = [
  m('u1', 'user'),
  m('th1', 'assistant', 'thinking'),
  m('t1', 'assistant', 'tool_use', ''),
  m('a1', 'assistant'),
  m('u2', 'user'),
  m('sys', 'system'),
  m('a2', 'assistant'),
  m('empty', 'assistant', 'text', '  '),
  m('u3', 'user'),
  m('a3', 'assistant'),
];
const turns = parseTurns(messages);
const ids = (list: ChatMessage[]) => list.map((x) => x.id);

describe('selectExportMessages', () => {
  it('单轮只导出问答，去掉思考、工具和空回复', () => {
    expect(ids(selectExportMessages(messages, turns, 0, 0, { includeTools: false }))).toEqual(['u1', 'a1']);
  });

  it('勾选工具时保留工具调用行', () => {
    expect(ids(selectExportMessages(messages, turns, 0, 0, { includeTools: true }))).toEqual(['u1', 't1', 'a1']);
  });

  it('多轮范围包含两端，系统消息不导出，起止顺序颠倒也可以', () => {
    expect(ids(selectExportMessages(messages, turns, 2, 1, { includeTools: false }))).toEqual(['u2', 'a2', 'u3', 'a3']);
  });

  it('越界时收拢到有效范围', () => {
    expect(ids(selectExportMessages(messages, turns, 2, 99, { includeTools: false }))).toEqual(['u3', 'a3']);
    expect(selectExportMessages([], [], 0, 0, { includeTools: false })).toEqual([]);
  });
});

describe('selectExportMessages 仅结论', () => {
  const flow: ChatMessage[] = [
    m('q1', 'user'),
    m('mid1', 'assistant'),               // 过程文字：我先看看……
    m('tool1', 'assistant', 'tool_use', ''),
    m('res1', 'assistant', 'tool_result'),
    m('mid2', 'assistant'),
    m('tool2', 'assistant', 'tool_use', ''),
    m('end1', 'assistant'),               // 最终回复可能分成多段
    m('end2', 'assistant'),
    m('q2', 'user'),
    m('only', 'assistant'),               // 没有工具调用的一轮
    m('q3', 'user'),
    m('last', 'assistant'),
    m('tool3', 'assistant', 'tool_use', ''), // 以工具调用收尾：取最后一段文字
  ];
  const flowTurns = parseTurns(flow);
  const opts = { includeTools: true, conclusionOnly: true };

  it('只留提问和最后一次工具调用之后的回复', () => {
    expect(ids(selectExportMessages(flow, flowTurns, 0, 0, opts))).toEqual(['q1', 'end1', 'end2']);
  });

  it('多轮各自取结论；无工具的轮次保留全部回复；以工具收尾时取最后一段文字', () => {
    expect(ids(selectExportMessages(flow, flowTurns, 0, 2, opts)))
      .toEqual(['q1', 'end1', 'end2', 'q2', 'only', 'q3', 'last']);
  });
});

describe('pickPixelRatio', () => {
  it('不太高时用 2 倍', () => {
    expect(pickPixelRatio(5000)).toBe(2);
  });
  it('较高时降低倍率，不超过画布上限', () => {
    const r = pickPixelRatio(20000);
    expect(r).toBeGreaterThanOrEqual(1);
    expect(r * 20000).toBeLessThanOrEqual(32000);
  });
  it('1 倍也放不下时返回 0', () => {
    expect(pickPixelRatio(40000)).toBe(0);
  });
});

describe('defaultExportFileName', () => {
  it('去掉文件名非法字符并带上时间', () => {
    expect(defaultExportFileName('修复 a/b: "问题"', new Date(2026, 0, 2, 3, 4)))
      .toBe('修复 a b 问题-20260102-0304.png');
  });
  it('标题为空时用默认名', () => {
    expect(defaultExportFileName('  ', new Date(2026, 0, 2, 3, 4))).toBe('ClaudeDeck-20260102-0304.png');
  });
});
