import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = new Map<string, string>();
vi.stubGlobal('sessionStorage', {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => { memory.set(k, v); },
  removeItem: (k: string) => { memory.delete(k); },
});
vi.stubGlobal('window', {});

const { useSessionStore } = await import('../../stores/sessionStore');
const { bridge } = await import('../tauri-bridge');
const { resolveResumeAt, resolveResumeAtForLatest } = await import('../rewind-point');

const SID = '350834e4-78bd-43c9-8678-a53c394af2da';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

// 两轮对话：U1 → A1(工具) → 工具结果 → A2(文字)
const base = [
  { type: 'user', uuid: U1, parentUuid: null, message: { content: '第一条' } },
  { type: 'assistant', uuid: 'a1', parentUuid: U1, message: { content: [{ type: 'tool_use' }] } },
  { type: 'user', uuid: 't1', parentUuid: 'a1', message: { content: [{ type: 'tool_result' }] } },
  { type: 'assistant', uuid: 'a2', parentUuid: 't1', message: { content: [{ type: 'text' }] } },
];

const load = vi.spyOn(bridge, 'loadSession');

describe('回退点定位', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [{ id: SID, path: 'x.jsonl' }] as never });
    load.mockReset();
  });

  it('按记录 uuid 找到这条消息之前最近的助手消息', async () => {
    load.mockResolvedValue([...base, { type: 'user', uuid: U2, parentUuid: 'a2', message: { content: '第二条' } }]);
    expect(await resolveResumeAt(SID, U2)).toBe('a2');
    expect(await resolveResumeAt(SID, U1)).toBeNull();
  });

  it('最后一轮还没写入会话文件：续接到文件末尾的助手消息', async () => {
    load.mockResolvedValue(base);
    expect(await resolveResumeAtForLatest(SID, U1)).toBe('a2');
  });

  it('最后一轮已写入但没回显 uuid：从文件里最后一条用户输入往前找，忽略工具结果和子代理', async () => {
    load.mockResolvedValue([
      ...base,
      { type: 'user', uuid: U2, parentUuid: 'a2', message: { content: '第二条' } },
      { type: 'assistant', uuid: 'a3', parentUuid: U2, message: { content: [{ type: 'tool_use' }] } },
      { type: 'user', uuid: 's1', parentUuid: null, isSidechain: true, message: { content: '子代理任务' } },
      { type: 'user', uuid: 't2', parentUuid: 'a3', message: { content: [{ type: 'tool_result' }] } },
    ]);
    expect(await resolveResumeAtForLatest(SID, U1)).toBe('a2');
  });

  it('没有上一轮：直接开新会话，不读文件', async () => {
    expect(await resolveResumeAtForLatest(SID, null)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});
