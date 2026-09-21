import { useEffect } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { finishedSessionIds } from '../lib/session-finish';

/**
 * 会话“未读”标记：会话任务结束时，如果用户当时不在该会话窗口
 * （选中了别的会话，或应用不在最前），就标记为未读；打开该会话或回到应用后清除。
 * 也可以在会话右键菜单里手动标记为未读 / 已读。
 */
export function useUnreadSessions(): void {
  useEffect(() => {
    const unsubscribe = useSessionStore.subscribe((state, prev) => {
      if (state.runningSessions !== prev.runningSessions) {
        for (const id of finishedSessionIds(prev.runningSessions, state.runningSessions)) {
          const watching = id === state.selectedSessionId && document.hasFocus();
          if (!watching) state.markUnread(id);
        }
      }
      // 切换到某个会话即视为已读
      if (state.selectedSessionId && state.selectedSessionId !== prev.selectedSessionId) {
        state.markRead(state.selectedSessionId);
      }
    });

    // 回到应用时，当前正在看的会话视为已读
    const onFocus = () => {
      const { selectedSessionId, markRead } = useSessionStore.getState();
      if (selectedSessionId) markRead(selectedSessionId);
    };
    window.addEventListener('focus', onFocus);

    return () => {
      unsubscribe();
      window.removeEventListener('focus', onFocus);
    };
  }, []);
}
