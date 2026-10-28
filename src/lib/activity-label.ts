/**
 * 运行指示器里的工具说明：把工具名和参数转成“动作 + 对象”，例如“读取 turns.ts”“运行 pnpm test”。
 * 动作是 i18n 键，对象取参数里最能说明在做什么的那一项，过长时截断。
 */

export interface ToolActivity {
  /** i18n 键（activity.*） */
  verbKey: string;
  /** 动作对象，没有时为空串 */
  target: string;
  /** 对象是否按代码样式显示（命令、搜索词） */
  code: boolean;
}

const MAX_TARGET = 48;

function truncate(s: string, max = MAX_TARGET): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function baseName(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}

function hostName(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function describeTool(name: string | undefined, input: any): ToolActivity {
  const i = input && typeof input === 'object' ? input : {};
  const n = name || '';
  switch (n) {
    case 'Read':
      return { verbKey: 'activity.read', target: baseName(str(i.file_path)), code: false };
    case 'Write':
      return { verbKey: 'activity.write', target: baseName(str(i.file_path)), code: false };
    case 'Edit':
    case 'MultiEdit':
      return { verbKey: 'activity.edit', target: baseName(str(i.file_path)), code: false };
    case 'NotebookEdit':
      return { verbKey: 'activity.edit', target: baseName(str(i.notebook_path)), code: false };
    case 'Bash':
    case 'PowerShell':
      // 有说明时优先用说明（CLI 让模型写的人话描述），否则显示命令本身
      return str(i.description)
        ? { verbKey: 'activity.run', target: truncate(str(i.description)), code: false }
        : { verbKey: 'activity.run', target: truncate(str(i.command)), code: true };
    case 'Grep':
      return { verbKey: 'activity.search', target: truncate(str(i.pattern), 32), code: true };
    case 'Glob':
      return { verbKey: 'activity.findFiles', target: truncate(str(i.pattern), 32), code: true };
    case 'WebFetch':
      return { verbKey: 'activity.fetch', target: hostName(str(i.url)), code: false };
    case 'WebSearch':
      return { verbKey: 'activity.webSearch', target: truncate(str(i.query), 32), code: false };
    case 'Agent':
    case 'Task':
      return { verbKey: 'activity.agent', target: truncate(str(i.description) || str(i.prompt), 32), code: false };
    case 'TodoWrite':
      return { verbKey: 'activity.todo', target: '', code: false };
    case 'Skill':
      return { verbKey: 'activity.skill', target: str(i.skill) || str(i.name), code: false };
    case 'AskUserQuestion':
      return { verbKey: 'activity.ask', target: '', code: false };
  }
  // MCP 工具：mcp__<服务>__<工具>，只显示工具部分
  const mcp = n.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return { verbKey: 'activity.call', target: mcp[2], code: true };
  return { verbKey: 'activity.call', target: n, code: true };
}
