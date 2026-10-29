import { describe, expect, it } from 'vitest';
import type { SessionListItem } from '../../../lib/tauri-bridge';
import { filterSessions, groupByProject, isTempProject, sessionSortTime } from '../session-list-model';

function item(id: string, modifiedAt: number, lastPromptAt?: number, project = 'F:/proj'): SessionListItem {
  return { id, path: `${id}.jsonl`, project, projectDir: project, modifiedAt, lastPromptAt, preview: id };
}

describe('sessionSortTime', () => {
  it('优先用最后发言时间，未知时退回修改时间', () => {
    expect(sessionSortTime(item('a', 900, 100))).toBe(100);
    expect(sessionSortTime(item('b', 900, 0))).toBe(900);
    expect(sessionSortTime(item('c', 900))).toBe(900);
  });
});

describe('groupByProject', () => {
  it('正在回复的会话修改时间不断刷新，但不会因此排到最前', () => {
    // c 正在回复（修改时间最新），但用户最后一次给它发消息最早
    const sessions = [item('a', 100, 100), item('b', 200, 200), item('c', 999, 50)];
    const groups = groupByProject(sessions, new Set());
    expect(groups[0][1].map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });

  it('项目之间也按最后发言时间排序', () => {
    const sessions = [item('a', 999, 10, 'F:/x'), item('b', 100, 100, 'F:/y')];
    expect(groupByProject(sessions, new Set()).map(([key]) => key)).toEqual(['F:/y', 'F:/x']);
  });
});

describe('临时目录会话', () => {
  it('识别系统临时目录（含 8.3 短路径、目录名解码路径），不误伤普通项目', () => {
    expect(isTempProject(String.raw`C:\Users\Administrator\AppData\Local\Temp\claude\x\scratchpad\desc-opt\trigger-iso\trig-_83yd1jq`)).toBe(true);
    expect(isTempProject(String.raw`C:\Users\ADMINI~1\AppData\Local\Temp\claude\x`)).toBe(true);
    expect(isTempProject(String.raw`C:\Users\ADMINI\1\AppData\Local\Temp\claude\x`)).toBe(true);
    expect(isTempProject('C:/Users/me/AppData/Local/Temp')).toBe(true);
    expect(isTempProject(String.raw`F:\AI\mywork\ClaudeDock`)).toBe(false);
    expect(isTempProject(String.raw`F:\Temp\proj`)).toBe(false);
  });

  it('列表中隐藏临时目录的会话', () => {
    const sessions = [item('a', 1), item('b', 2, 0, String.raw`C:\Users\me\AppData\Local\Temp\claude\trig-1`)];
    const result = filterSessions(sessions, {
      activeEnv: 'local', showArchived: false, archivedSessions: new Set(), searchQuery: '', displayName: (s) => s.preview,
    });
    expect(result.map((s) => s.id)).toEqual(['a']);
  });
});

describe('本机隐藏项目', () => {
  const base = { activeEnv: 'local', showArchived: false, archivedSessions: new Set<string>(), searchQuery: '', displayName: (s: SessionListItem) => s.preview };

  it('隐藏项目下的会话（含之后新建的）都不显示，临时显示时恢复', () => {
    const sessions = [item('a', 1, 0, 'F:/home-proj'), item('b', 2, 0, 'F:/work-proj'), item('new', 3, 0, 'F:/work-proj')];
    const hiddenProjects = new Set(['F:/work-proj']);
    expect(filterSessions(sessions, { ...base, hiddenProjects }).map((s) => s.id)).toEqual(['a']);
    expect(filterSessions(sessions, { ...base, hiddenProjects, showHidden: true }).map((s) => s.id)).toEqual(['a', 'b', 'new']);
  });

  it('按项目分组键匹配，用户目录下的路径统一成 ~ 开头', () => {
    const sessions = [item('a', 1, 0, String.raw`C:\Users\me\work`)];
    const result = filterSessions(sessions, { ...base, hiddenProjects: new Set([String.raw`~\work`]) });
    expect(result).toEqual([]);
  });
});
