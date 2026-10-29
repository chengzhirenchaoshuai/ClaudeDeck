// 会话与项目的置顶、归档状态：localStorage 快速缓存 + 磁盘文件为准 + 远程主机各自的归档文件同步。
// 另含“在本机隐藏的项目”：按项目分组键记录，只存本客户端，不同步到远程主机。
import { useCallback, useEffect, useState } from 'react';
import { bridge, type RemoteHost, type SessionListItem } from '../../lib/tauri-bridge';

export function usePinnedArchived(remoteHosts: RemoteHost[], remoteSessionsList: SessionListItem[]) {
  const [pinnedSessions, setPinnedSessions] = useState<Set<string>>(() => {
    try {
      const data = localStorage.getItem('tokenicode_pinned_sessions');
      return new Set(data ? JSON.parse(data) : []);
    } catch { return new Set(); }
  });
  const [archivedSessions, setArchivedSessions] = useState<Set<string>>(() => {
    try {
      const data = localStorage.getItem('tokenicode_archived_sessions');
      return new Set(data ? JSON.parse(data) : []);
    } catch { return new Set(); }
  });

  const [hiddenProjects, setHiddenProjects] = useState<Set<string>>(() => {
    try {
      const data = localStorage.getItem('claudedeck_hidden_projects');
      return new Set(data ? JSON.parse(data) : []);
    } catch { return new Set(); }
  });

  // Persist pinned/archived
  const persistPinned = useCallback((next: Set<string>) => {
    setPinnedSessions(next);
    localStorage.setItem('tokenicode_pinned_sessions', JSON.stringify([...next]));
    bridge.savePinnedSessions([...next]).catch(() => {});
  }, []);

  const persistArchived = useCallback((next: Set<string>) => {
    setArchivedSessions(next);
    localStorage.setItem('tokenicode_archived_sessions', JSON.stringify([...next]));
    bridge.saveArchivedSessions([...next]).catch(() => {});
  }, []);

  const persistHiddenProjects = useCallback((next: Set<string>) => {
    setHiddenProjects(next);
    localStorage.setItem('claudedeck_hidden_projects', JSON.stringify([...next]));
    bridge.saveHiddenProjects([...next]).catch(() => {});
  }, []);

  // 归档和改名一样是 ClaudeDeck 自己的概念，claude CLI 没有这个功能，本机只存在
  // <数据目录>/config/archived.json 里。远程会话的归档状态额外写一份到远程主机自己的
  // CLAUDE_CONFIG_DIR 下，让远程主机成为源端：每次远程会话列表刷新（不管是哪里
  // 触发的，比如侧边栏“刷新”按钮），这里都会重新拉取每台主机自己的归档文件，
  // 用远程数据覆盖本地对应会话的归档状态（含“远程那边取消归档了”这种减法）。
  useEffect(() => {
    if (remoteHosts.length === 0) return;
    let cancelled = false;
    (async () => {
      const results = await Promise.allSettled(
        remoteHosts.map((h) => bridge.loadRemoteArchivedSessions(h.id)),
      );
      if (cancelled) return;
      setArchivedSessions((current) => {
        const next = new Set(current);
        let changed = false;
        remoteHosts.forEach((h, i) => {
          const r = results[i];
          if (r.status !== 'fulfilled') return;
          const remoteIds = new Set(r.value);
          for (const s of remoteSessionsList) {
            if (s.host !== h.id) continue;
            const shouldBeArchived = remoteIds.has(s.id);
            if (shouldBeArchived !== next.has(s.id)) {
              changed = true;
              if (shouldBeArchived) next.add(s.id);
              else next.delete(s.id);
            }
          }
        });
        if (!changed) return current;
        localStorage.setItem('tokenicode_archived_sessions', JSON.stringify([...next]));
        bridge.saveArchivedSessions([...next]).catch(() => {});
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [remoteHosts, remoteSessionsList]);

  // 归档一个远程会话时，把这台主机名下的全部归档 ID 写回它自己的归档文件
  const pushArchivedToRemote = useCallback((session: SessionListItem, archivedIds: Set<string>) => {
    if (!session.host) return;
    const hostId = session.host;
    const hostArchived = remoteSessionsList
      .filter((s) => s.host === hostId && archivedIds.has(s.id))
      .map((s) => s.id);
    bridge.saveRemoteArchivedSessions(hostId, hostArchived).catch(() => {});
  }, [remoteSessionsList]);

  // Load pinned/archived from backend on init
  useEffect(() => {
    // 磁盘文件是权威来源（本地存储只是快速缓存）：文件存在时，即使为空也以它为准，
    // 这样清空磁盘记录后，界面不会被旧的本地缓存带回去
    bridge.loadPinnedSessions?.()
      .then((data: string[] | null) => {
        if (Array.isArray(data)) {
          setPinnedSessions(new Set(data));
          localStorage.setItem('tokenicode_pinned_sessions', JSON.stringify(data));
        }
      })
      .catch(() => {});
    bridge.loadArchivedSessions?.()
      .then((data: string[] | null) => {
        if (Array.isArray(data)) {
          setArchivedSessions(new Set(data));
          localStorage.setItem('tokenicode_archived_sessions', JSON.stringify(data));
        }
      })
      .catch(() => {});
    bridge.loadHiddenProjects()
      .then((data: string[] | null) => {
        if (Array.isArray(data)) {
          setHiddenProjects(new Set(data));
          localStorage.setItem('claudedeck_hidden_projects', JSON.stringify(data));
        }
      })
      .catch(() => {});
  }, []);

  return {
    pinnedSessions, archivedSessions, hiddenProjects,
    persistPinned, persistArchived, persistHiddenProjects, pushArchivedToRemote,
  };
}
