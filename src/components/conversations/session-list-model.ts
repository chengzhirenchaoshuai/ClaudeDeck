// 会话列表的数据处理：项目路径换算、按环境/隐藏项目/归档/搜索过滤、按项目分组。
import { bridge, type SessionListItem, type ContentSearchResult } from '../../lib/tauri-bridge';

let _cachedHomeDir: string | null = null;
bridge.getHomeDir().then((h) => { _cachedHomeDir = h; }).catch(() => {});

function isWindowsAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(p);
}

export function resolveProjectPath(raw: string): string {
  if (raw.startsWith('ssh://')) return raw;
  if (raw.startsWith('/') || isWindowsAbsolutePath(raw)) return raw;
  if (raw.startsWith('~/') || raw === '~') {
    if (_cachedHomeDir) return raw.replace('~', _cachedHomeDir);
    return raw;
  }
  if (/^[A-Za-z]-/.test(raw)) {
    const drive = raw[0];
    const rest = raw.slice(2);
    return `${drive}:\\${rest.replace(/-/g, '\\')}`;
  }
  return raw.replace(/-/g, '/');
}

export function normalizeProjectKey(raw: string): string {
  const unix = raw.match(/^\/(?:Users|home)\/[^/]+(\/.*)/);
  if (unix) return '~' + unix[1];
  const win = raw.match(/^[A-Za-z]:[/\\]Users[/\\][^/\\]+([/\\].*)/i);
  if (win) return '~' + win[1];
  return raw;
}

/** 会话所属项目的分组键（与 groupByProject 一致），置顶项目、本机隐藏项目都按它记录 */
export function sessionProjectKey(s: SessionListItem): string {
  return normalizeProjectKey(s.project || s.projectDir);
}

/** Extract display label from a project key.
 *  When `parentHint` is true (duplicate names), appends parent folder:
 *  "A (Desktop)" vs "A (坚果云)" */
export function projectLabel(project: string, parentHint?: boolean): string {
  const parts = project.replace(/^~[\\/]/, '').split(/[\\/]/);
  const name = parts[parts.length - 1] || project;
  if (parentHint && parts.length >= 2) {
    return `${name} (${parts[parts.length - 2]})`;
  }
  return name;
}

/**
 * 工作目录在系统临时目录（%LOCALAPPDATA%\Temp）下的会话：技能评测、描述优化等脚本
 * 为每个测试用例在 scratchpad 里建临时目录跑一次 claude，会留下大量一次性会话，列表中隐藏。
 * 兼容 8.3 短路径（ADMINI~1）和没有 cwd 时由目录名解码出的路径。
 */
export function isTempProject(project: string): boolean {
  return /[\\/]AppData[\\/]Local[\\/]Temp([\\/]|$)/i.test(project);
}

/** 只保留当前环境（本机或某台远程主机）的会话，再按归档视图和搜索词过滤 */
export function filterSessions(
  sessions: SessionListItem[],
  opts: {
    activeEnv: string;
    showArchived: boolean;
    archivedSessions: Set<string>;
    searchQuery: string;
    displayName: (session: SessionListItem) => string;
    /** 在本机隐藏的项目分组键 */
    hiddenProjects?: Set<string>;
    /** 为 true 时临时显示已隐藏的项目 */
    showHidden?: boolean;
  },
): SessionListItem[] {
  const { activeEnv, showArchived, archivedSessions, searchQuery, displayName, hiddenProjects, showHidden } = opts;
  // 本地与远程模式互相隔离：只显示当前环境的会话
  let result = sessions.filter((s) => (activeEnv === 'local' ? !s.host : s.host === activeEnv));
  result = result.filter((s) => !isTempProject(s.project));
  if (hiddenProjects && hiddenProjects.size > 0 && !showHidden) {
    result = result.filter((s) => !hiddenProjects.has(sessionProjectKey(s)));
  }

  // Archive filter: OFF = hide archived, ON = show ONLY archived
  if (showArchived) {
    result = result.filter((s) => archivedSessions.has(s.id));
  } else {
    result = result.filter((s) => !archivedSessions.has(s.id));
  }

  // Search
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    result = result.filter(
      (s) =>
        displayName(s).toLowerCase().includes(q) ||
        s.preview.toLowerCase().includes(q) ||
        s.project.toLowerCase().includes(q)
    );
  }

  return result;
}

/**
 * 会话的排序时间：用户最后一次发消息的时间，未知时（草稿、找不到用户消息）退回修改时间。
 * 不直接用修改时间：正在回复的会话会持续写入 JSONL，几个同时运行的会话会轮流跳到最前；
 * 按最后发言时间排序，会话只在用户给它发消息时上移，回复过程中和结束时都不动。
 */
export function sessionSortTime(s: SessionListItem): number {
  return s.lastPromptAt || s.modifiedAt;
}

/** 按项目分组：组内按排序时间倒序，置顶项目在前，其余按最近真实会话的排序时间排序 */
export function groupByProject(
  filtered: SessionListItem[],
  pinnedSessions: Set<string>,
): [string, SessionListItem[]][] {
  const map = new Map<string, SessionListItem[]>();
  for (const s of filtered) {
    const key = sessionProjectKey(s);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  for (const items of map.values()) {
    items.sort((a, b) => sessionSortTime(b) - sessionSortTime(a));
  }
  // 项目在列表里的排序位置，只看这个项目下"已经落盘"的真实会话，不算草稿——
  // 新建会话时草稿的 modifiedAt 是创建时刻（Date.now()），如果拿它参与排序，
  // 项目会先跳到最上面，等草稿后来被清理/落盘又跳回去，位置来回乱动。
  // 项目下全是草稿（刚新建的项目，还没有任何历史会话）时才退回用草稿的时间。
  const sortKey = (items: SessionListItem[]) => {
    const real = items.find((s) => s.path !== '');
    const first = real ?? items[0];
    return first ? sessionSortTime(first) : 0;
  };
  const entries = Array.from(map.entries());
  entries.sort((a, b) => {
    const pa = pinnedSessions.has(`project:${a[0]}`) ? 1 : 0;
    const pb = pinnedSessions.has(`project:${b[0]}`) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return sortKey(b[1]) - sortKey(a[1]);
  });
  return entries;
}

/** 只被内容搜索命中（标题/项目名没命中）的本机会话，同样遵守归档视图和本机隐藏项目 */
export function findContentOnlyMatches(
  sessions: SessionListItem[],
  filtered: SessionListItem[],
  contentSearchResults: Map<string, ContentSearchResult>,
  searchQuery: string,
  showArchived: boolean,
  archivedSessions: Set<string>,
  hiddenProjects?: Set<string>,
): SessionListItem[] {
  if (!searchQuery.trim() || contentSearchResults.size === 0) return [];
  const metadataIds = new Set(filtered.map((s) => s.id));
  return sessions.filter((s) => {
    if (s.host) return false;
    if (isTempProject(s.project)) return false;
    // 本机隐藏的项目同样不出现在内容搜索结果里（临时显示隐藏项目时由调用方不传）
    if (hiddenProjects?.has(sessionProjectKey(s))) return false;
    if (metadataIds.has(s.id)) return false;
    if (!contentSearchResults.has(s.id)) return false;
    // Respect archive filter
    if (showArchived) return archivedSessions.has(s.id);
    return !archivedSessions.has(s.id);
  });
}
