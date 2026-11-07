import { describe, expect, it } from 'vitest';
import type { ActivityPhase, ChatMessage, SessionStatus, TabSession } from '../../stores/chatStore';
import { buildAwaitingNotice, buildFinishedNotice, detectTransitions, snippet } from '../system-notify';

const t = (key: string) => ({
  'notification.completed': '回复完成',
  'notification.failed': '出错了',
  'notification.failedWith': '出错了：{detail}',
  'notification.awaiting': '等待你确认',
  'notification.awaitingPermission': '等待你确认：允许使用 {tool}',
  'notification.awaitingQuestion': '有问题等你回答：{question}',
  'notification.awaitingPlan': '计划已写好，等待你审阅',
}[key] ?? key);

const tab = (status: SessionStatus, phase: ActivityPhase = 'idle', messages: ChatMessage[] = []): TabSession => ({
  tabId: 'x', messages, sessionStatus: status, activityStatus: { phase },
} as unknown as TabSession);
const msg = (role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: content, role, type: 'text', content, timestamp: 0, ...extra,
});

describe('detectTransitions', () => {
  it('运行中变为完成、出错或空闲（进程中途退出）算一轮结束；仍在运行、原本就没运行的不算', () => {
    const prev = new Map([['a', tab('running')], ['b', tab('running')], ['c', tab('running')], ['d', tab('idle')], ['e', tab('running')]]);
    const next = new Map([['a', tab('completed')], ['b', tab('error')], ['c', tab('running')], ['d', tab('completed')], ['e', tab('idle')]]);
    expect(detectTransitions(prev, next).finished).toEqual(['a', 'b', 'e']);
  });

  it('刚进入等待确认才算；一直在等待的不重复报', () => {
    const prev = new Map([['a', tab('running', 'tool')], ['b', tab('running', 'awaiting')]]);
    const next = new Map([['a', tab('running', 'awaiting')], ['b', tab('running', 'awaiting')]]);
    expect(detectTransitions(prev, next).awaiting).toEqual(['a']);
  });

  it('草稿升级为正式会话（ID 替换）不算结束', () => {
    const prev = new Map([['draft_1', tab('running')]]);
    const next = new Map([['real-id', tab('running')]]);
    expect(detectTransitions(prev, next)).toEqual({ finished: [], awaiting: [] });
  });

  it('标签页对象没变时跳过', () => {
    const same = tab('running');
    expect(detectTransitions(new Map([['a', same]]), new Map([['a', same]]))).toEqual({ finished: [], awaiting: [] });
  });
});

describe('snippet', () => {
  it('去掉 Markdown 记号和代码块，合并空白', () => {
    expect(snippet('## 结论\n\n**改好了**，见 `a.ts` 和 [文档](http://x)。\n```ts\ncode()\n```\n- 第二点'))
      .toBe('结论 改好了，见 a.ts 和 文档。 第二点');
  });

  it('超长时截断并加省略号', () => {
    expect(snippet('一'.repeat(120), 100)).toBe(`${'一'.repeat(100)}…`);
    expect(snippet('短句', 100)).toBe('短句');
  });
});

describe('buildFinishedNotice', () => {
  it('完成：正文是最后一条回复的开头', () => {
    const notice = buildFinishedNotice(tab('completed', 'completed', [
      msg('assistant', '第一段'), msg('user', '继续'), msg('assistant', '**最终**答复'),
    ]), '我的会话', t);
    expect(notice).toEqual({ title: '我的会话', body: '最终答复' });
  });

  it('完成但没有文字回复（只调用了工具）：显示“回复完成”', () => {
    expect(buildFinishedNotice(tab('completed'), '会话', t).body).toBe('回复完成');
  });

  it('出错：显示最后一条系统消息', () => {
    const notice = buildFinishedNotice(tab('error', 'error', [msg('assistant', '做到一半'), msg('system', 'Error: rate limited')]), '会话', t);
    expect(notice.body).toBe('出错了：Error: rate limited');
  });

  it('进程中途退出（空闲）按出错处理，显示退出提示', () => {
    const notice = buildFinishedNotice(tab('idle', 'idle', [msg('assistant', '做到一半'), msg('system', 'CLI 意外退出')]), '会话', t);
    expect(notice.body).toBe('出错了：CLI 意外退出');
  });

  it('出错但没有错误信息', () => {
    expect(buildFinishedNotice(tab('error'), '会话', t).body).toBe('出错了');
  });
});

describe('buildAwaitingNotice', () => {
  it('权限请求：写明工具名', () => {
    const notice = buildAwaitingNotice(tab('running', 'awaiting', [
      msg('assistant', 'Bash wants to execute', { type: 'permission', permissionTool: 'Bash', resolved: false }),
    ]), '会话', t);
    expect(notice.body).toBe('等待你确认：允许使用 Bash');
  });

  it('提问：显示问题', () => {
    const notice = buildAwaitingNotice(tab('running', 'awaiting', [
      msg('assistant', '', { type: 'question', questions: [{ question: '用哪个数据库？', options: [] }], resolved: false }),
    ]), '会话', t);
    expect(notice.body).toBe('有问题等你回答：用哪个数据库？');
  });

  it('计划审阅', () => {
    const notice = buildAwaitingNotice(tab('running', 'awaiting', [msg('assistant', '', { type: 'plan_review', resolved: false })]), '会话', t);
    expect(notice.body).toBe('计划已写好，等待你审阅');
  });

  it('已经回答过的不算，退回通用文案', () => {
    const notice = buildAwaitingNotice(tab('running', 'awaiting', [
      msg('assistant', '', { type: 'permission', permissionTool: 'Bash', resolved: true }),
    ]), '会话', t);
    expect(notice.body).toBe('等待你确认');
  });
});
