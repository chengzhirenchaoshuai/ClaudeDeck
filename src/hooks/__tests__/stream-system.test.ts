// system 消息处理：init 模型、错误提示、后台任务数、压缩边界（实时流为蛇形字段）。
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { CLI_DEFAULT, useSettingsStore } from '../../stores/settingsStore';
import { handleSystemMessage } from '../stream/handlers/system';
import type { SystemMessage } from '../../lib/stream-message';
import { makeContext, tabOf } from './stream-test-utils';

const TAB = 'stream_system_test_tab';
const lastMessage = () => {
  const msgs = tabOf(TAB).messages;
  return msgs[msgs.length - 1];
};
const system = (subtype: string, extra: Partial<SystemMessage> = {}): SystemMessage => ({
  type: 'system', subtype, ...extra,
});

describe('handleSystemMessage', () => {
  let ctx: ReturnType<typeof makeContext>;
  beforeEach(() => {
    ctx = makeContext(TAB);
  });

  it('init：记下模型；以 CLI 默认启动时同时记住 CLI 实际选的模型', () => {
    useChatStore.getState().setSessionMeta(TAB, { spawnedModel: CLI_DEFAULT });
    handleSystemMessage(ctx, system('init', { model: 'claude-opus-5-5' }));
    expect(tabOf(TAB).sessionMeta.model).toBe('claude-opus-5-5');
    expect(useSettingsStore.getState().lastCliModel).toBe('claude-opus-5-5');
  });

  it('error：在对话里显示错误，不静默丢弃', () => {
    handleSystemMessage(ctx, system('error', { message: 'boom' }));
    const last = lastMessage();
    expect(last).toMatchObject({ role: 'system', type: 'text' });
    expect(last?.content).toContain('boom');
  });

  it('background_tasks_changed：按完整列表覆盖计数，不计 CLI 自身的任务', () => {
    handleSystemMessage(ctx, system('background_tasks_changed', {
      tasks: [
        { task_id: 'a', task_type: 'local_bash', description: 'pnpm dev' },
        { task_id: 'b', task_type: 'local_agent', description: '子代理' },
        { task_id: 'c', task_type: 'local_bash', description: 'CLI 自身', ambient: true },
      ],
    }));
    expect(useSessionStore.getState().backgroundTasks.get(TAB)).toBe(2);
    handleSystemMessage(ctx, system('background_tasks_changed', { tasks: [] }));
    expect(useSessionStore.getState().backgroundTasks.get(TAB) ?? 0).toBe(0);
  });

  describe('compact_boundary', () => {
    const boundary = system('compact_boundary', {
      compact_metadata: { trigger: 'auto', pre_tokens: 90000, post_tokens: 8000 },
    });

    it('CLI 自动压缩：插入压缩提示，并把上下文占用改为压缩后的数值', () => {
      useChatStore.getState().setSessionMeta(TAB, { contextInputTokens: 90000, contextOutputTokens: 500 });
      handleSystemMessage(ctx, boundary);
      const notice = lastMessage();
      expect(notice).toMatchObject({ commandType: 'compact' });
      expect(notice?.commandData).toMatchObject({ trigger: 'auto', preTokens: 90000, postTokens: 8000 });
      expect(tabOf(TAB).sessionMeta).toMatchObject({ contextInputTokens: 8000, contextOutputTokens: 0 });
    });

    it('从处理卡发起的 /compact：不另插提示，前后 token 写进处理卡', () => {
      ctx.addMessage({
        id: 'cmd', role: 'system', type: 'text', content: '',
        commandData: { command: '/compact' }, timestamp: 1,
      });
      useChatStore.getState().setSessionMeta(TAB, { pendingCommandMsgId: 'cmd' });
      handleSystemMessage(ctx, boundary);
      const msgs = tabOf(TAB).messages;
      expect(msgs).toHaveLength(1);
      expect(msgs[0].commandData?.compactSummary).toEqual({ preTokens: 90000, postTokens: 8000 });
    });

    it('驼峰的 compactMetadata 只出现在磁盘 JSONL，实时流里不认', () => {
      useChatStore.getState().setSessionMeta(TAB, { contextInputTokens: 90000 });
      handleSystemMessage(ctx, system('compact_boundary', {
        compactMetadata: { postTokens: 8000 },
      } as Partial<SystemMessage>));
      expect(tabOf(TAB).sessionMeta.contextInputTokens).toBe(90000);
    });
  });
});
