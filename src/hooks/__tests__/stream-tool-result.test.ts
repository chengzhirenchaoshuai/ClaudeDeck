// 旧版 CLI 顶层 tool_result 消息：回填工具卡、修正提问卡、改文件后刷新文件树。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileStore } from '../../stores/fileStore';
import { handleToolResult } from '../stream/handlers/tool-result';
import { makeContext, tabOf } from './stream-test-utils';

const TAB = 'stream_tool_result_test_tab';

describe('handleToolResult', () => {
  let ctx: ReturnType<typeof makeContext>;
  let refreshTree: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    refreshTree = vi.fn();
    useFileStore.setState({ refreshTree } as never);
    ctx = makeContext(TAB);
  });
  afterEach(() => {
    // 防抖定时器是模块级状态：先跑完，否则残留的假定时器会让后续用例的刷新被当成“已排队”
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('回填到父工具卡，不另起一条消息', () => {
    ctx.addMessage({ id: 't1', role: 'assistant', type: 'tool_use', content: '', toolName: 'Read', timestamp: 1 });
    handleToolResult(ctx, { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '文件内容' }] });
    expect(tabOf(TAB).messages).toHaveLength(1);
    expect(tabOf(TAB).messages[0].toolResultContent).toBe('文件内容');
  });

  it('流式期间建成 tool_use 的 AskUserQuestion：改成提问卡并补上问题', () => {
    const questions = [{ question: '继续吗？' }];
    ctx.addMessage({
      id: 'q1', role: 'assistant', type: 'tool_use', content: '', toolName: 'AskUserQuestion',
      toolInput: { questions }, timestamp: 1,
    });
    handleToolResult(ctx, { type: 'tool_result', tool_use_id: 'q1', content: '已回答' });
    expect(tabOf(TAB).messages[0]).toMatchObject({ type: 'question', resolved: false, questions });
  });

  it('找不到父工具卡时作为独立结果消息显示，内容取 output', () => {
    handleToolResult(ctx, { type: 'tool_result', uuid: 'r1', tool_name: 'Bash', output: 'done' });
    expect(tabOf(TAB).messages[0]).toMatchObject({ id: 'r1', type: 'tool_result', content: 'done', toolName: 'Bash' });
  });

  it('改文件的工具完成后防抖刷新文件树，连续多次只刷新一次', () => {
    ctx.addMessage({ id: 'e1', role: 'assistant', type: 'tool_use', content: '', toolName: 'Edit', timestamp: 1 });
    handleToolResult(ctx, { type: 'tool_result', tool_use_id: 'e1', content: 'ok' });
    handleToolResult(ctx, { type: 'tool_result', tool_name: 'Write', content: 'ok' });
    expect(refreshTree).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(refreshTree).toHaveBeenCalledTimes(1);
  });

  it('只读工具不刷新文件树', () => {
    ctx.addMessage({ id: 'r1', role: 'assistant', type: 'tool_use', content: '', toolName: 'Read', timestamp: 1 });
    handleToolResult(ctx, { type: 'tool_result', tool_use_id: 'r1', content: 'ok' });
    vi.advanceTimersByTime(1000);
    expect(refreshTree).not.toHaveBeenCalled();
  });
});
