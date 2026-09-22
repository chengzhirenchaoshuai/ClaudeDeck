/**
 * useRewind — orchestration hook for the Rewind feature.
 * Manages turn parsing, kill-process, message truncation, code restore,
 * and summarization. Uses CLI native checkpoint system for file restoration.
 *
 * 5 actions after selecting a turn:
 *   1. Restore code and conversation — revert both
 *   2. Restore conversation only — keep code, rewind messages
 *   3. Restore code only — keep conversation, revert files
 *   4. Summarize from here — compress messages after selected point
 *   5. Cancel
 */
import { useMemo, useCallback } from 'react';
import { useChatStore, useActiveTab, getActiveTabState, generateMessageId } from '../stores/chatStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { bridge } from '../lib/tauri-bridge';
import { parseTurns, type Turn } from '../lib/turns';
import { resolveResumeAt, recordUuidOf } from '../lib/rewind-point';
import { t } from '../lib/i18n';
import { showToast } from '../components/shared/Toast';

export type RewindAction = 'restore_all' | 'restore_conversation' | 'restore_code' | 'summarize';

/**
 * Restore files to a CLI checkpoint via bridge.rewindFiles().
 * Returns true if files were restored, false if no checkpoint available.
 */
async function restoreFilesViaCheckpoint(turn: Turn): Promise<boolean> {
  if (!turn.checkpointUuid) return false;

  const tabState = getActiveTabState();
  const stdinId = tabState.sessionMeta.stdinId;
  const sessionId = tabState.sessionMeta.sessionId;
  const cwd = useSettingsStore.getState().workingDirectory;
  if (!sessionId || !cwd) return false;

  try {
    // Primary: SDK control protocol via stdin (fast, in-process)
    // Fallback: spawn new CLI process (slow, full initialization)
    await bridge.rewindFiles(stdinId || '', turn.checkpointUuid, sessionId, cwd);
    return true;
  } catch (err) {
    console.error('[rewind] rewindFiles failed:', err);
    return false;
  }
}

export function useRewind() {
  const messages = useActiveTab((t) => t.messages);
  const sessionStatus = useActiveTab((t) => t.sessionStatus);

  const turns = useMemo(() => parseTurns(messages), [messages]);

  /** Button visible as long as there are user messages */
  const showRewind = turns.length >= 1;
  /** Button enabled when there is at least 1 turn and not running */
  const canRewind = turns.length >= 1 && sessionStatus !== 'running';

  /** Kill the current CLI process and clean up listeners */
  const killProcess = useCallback(async () => {
    const state = getActiveTabState();
    const stdinId = state.sessionMeta.stdinId;
    if (stdinId) {
      await bridge.killSession(stdinId).catch(() => {});
      if ((window as any).__claudeUnlisteners?.[stdinId]) {
        (window as any).__claudeUnlisteners[stdinId]();
        delete (window as any).__claudeUnlisteners[stdinId];
      }
      if ((window as any).__claudeUnlisten) {
        (window as any).__claudeUnlisten = null;
      }
    }
  }, []);

  /**
   * 回退后重置会话状态。
   * - keepSession（只回退代码）：对话内容不变，保留 CLI 会话 ID，下一条消息照常续接原会话。
   * - 回退对话：旧会话 ID 记为 rewoundFromSessionId（新分支创建后隐藏旧的）；
   *   resumeAt 有值时，下一次启动会续接旧会话并只保留到该消息为止的历史（分叉出新会话），
   *   为 null 表示回退到第一轮，直接开启全新会话。
   */
  const resetSession = useCallback((opts: {
    keepSession?: boolean;
    resumeAt?: string | null;
    pendingSummary?: string;
  } = {}) => {
    const tid = useSessionStore.getState().selectedSessionId;
    if (!tid) return;
    const previousSessionId = useChatStore.getState().getTab(tid)?.sessionMeta.sessionId;
    useChatStore.getState().setSessionStatus(tid, 'idle');
    if (opts.keepSession) {
      useChatStore.getState().setSessionMeta(tid, { stdinId: undefined });
      return;
    }
    useChatStore.getState().setSessionMeta(tid, {
      stdinId: undefined,
      // 有回退点时保留旧会话 ID 用于续接；没有（回到第一轮 / 还没有 CLI 会话）则开新会话
      sessionId: opts.resumeAt ? previousSessionId : undefined,
      resumeAtUuid: opts.resumeAt ?? undefined,
      rewoundFromSessionId: previousSessionId,
      pendingSummary: opts.pendingSummary,
    });
  }, []);

  /** Save rewound state to tab cache */
  const saveToTab = useCallback(() => {
    const tabId = useSessionStore.getState().selectedSessionId;
    if (tabId) {
      useChatStore.getState().saveToCache(tabId);
    }
  }, []);

  /**
   * Execute rewind with a specific action.
   * All actions restore the user's original input text to the input box.
   * overrideText：编辑已发送消息时，用修改后的文字替换原文回填到输入框
   * （其余回退到这条消息之前的逻辑完全一致）。
   */
  const executeRewind = useCallback(async (turn: Turn, action: RewindAction = 'restore_conversation', overrideText?: string) => {
    const tid = useSessionStore.getState().selectedSessionId;
    if (!tid) return;
    const state = getActiveTabState();

    // Guard: validate turn index
    if (turn.startMsgIdx < 0 || turn.startMsgIdx > state.messages.length) {
      console.error('[useRewind] Invalid turn startMsgIdx:', turn.startMsgIdx);
      return;
    }

    // 回退对话前先算出 CLI 该续接到哪条消息：找不到就整体中止，不能悄悄丢掉全部上下文。
    // 必须在杀进程和改界面之前做，失败时什么都不会被改动。
    let resumeAt: string | null | undefined;
    const oldCliSessionId = state.sessionMeta.sessionId;
    if (action !== 'restore_code' && oldCliSessionId && !oldCliSessionId.startsWith('desk_')) {
      try {
        resumeAt = await resolveResumeAt(oldCliSessionId, recordUuidOf(turn));
      } catch (err) {
        console.error('[useRewind] cannot locate rewind point:', err);
        showToast(t('rewind.locateFailed'), 'error');
        return;
      }
    }

    // For file-restore actions, send rewind via stdin BEFORE killing the process
    // (SDK control protocol is fast and needs the process alive)
    const needsFileRestore = action === 'restore_all' || action === 'restore_code';
    let fileRestoreOk = false;
    if (needsFileRestore && turn.checkpointUuid) {
      try {
        fileRestoreOk = await restoreFilesViaCheckpoint(turn);
      } catch { /* handled below */ }
    }

    // Kill CLI process after file restore (or immediately for non-file actions)
    try {
      await killProcess();
    } catch (err) {
      console.warn('[useRewind] Failed to kill process:', err);
    }

    // Grab original text before truncating (or the edited replacement, if provided)
    const originalUserText = overrideText ?? (state.messages[turn.startMsgIdx]?.content || '');

    try {
      switch (action) {
        case 'restore_all': {
          useChatStore.getState().rewindToTurn(tid, turn.startMsgIdx);
          resetSession({ resumeAt });
          useChatStore.getState().setInputDraft(tid, originalUserText);

          const successMsg = fileRestoreOk
            ? t('rewind.successAll').replace('{n}', String(turn.index))
            : t('rewind.successAllNoFiles').replace('{n}', String(turn.index));
          showToast(successMsg, fileRestoreOk ? 'success' : 'info');
          break;
        }

        case 'restore_conversation': {
          // Only restore conversation (keep code as-is)
          useChatStore.getState().rewindToTurn(tid, turn.startMsgIdx);
          resetSession({ resumeAt });
          useChatStore.getState().setInputDraft(tid, originalUserText);

          showToast(t('rewind.success').replace('{n}', String(turn.index)), 'success');
          break;
        }

        case 'restore_code': {
          // Don't truncate messages — keep full conversation and the CLI session
          resetSession({ keepSession: true });
          useChatStore.getState().setInputDraft(tid, originalUserText);

          const codeMsg = fileRestoreOk
            ? t('rewind.successCode').replace('{n}', String(turn.index))
            : t('rewind.codeRestoreFailed');
          showToast(codeMsg, fileRestoreOk ? 'success' : 'error');
          break;
        }

        case 'summarize': {
          // Compress messages from this turn onwards into a summary.
          // Messages before the selected turn stay intact (full detail).
          const msgsToSummarize = state.messages.slice(turn.startMsgIdx);
          const summaryParts: string[] = [];

          for (const m of msgsToSummarize) {
            if (m.role === 'user' && m.content) {
              summaryParts.push(`**User:** ${m.content.slice(0, 200)}${m.content.length > 200 ? '…' : ''}`);
            } else if (m.role === 'assistant' && m.type === 'text' && m.content) {
              summaryParts.push(`**Claude:** ${m.content.slice(0, 300)}${m.content.length > 300 ? '…' : ''}`);
            } else if (m.type === 'tool_use' && m.toolName) {
              const fp = m.toolInput?.file_path || m.toolInput?.command || '';
              summaryParts.push(`**${m.toolName}:** ${String(fp).slice(0, 100)}`);
            }
          }

          // Truncate to selected point
          useChatStore.getState().rewindToTurn(tid, turn.startMsgIdx);

          const totalTurns = turns.length;
          const summaryHeader = t('rewind.summaryTitle')
            .replace('{from}', String(turn.index))
            .replace('{to}', String(totalTurns));
          const summaryContent = `**${summaryHeader}**\n\n${summaryParts.join('\n\n')}`;
          // 模型的上下文也回到该轮之前，摘要作为下一条消息的前缀交给模型；
          // 否则界面上有摘要，模型却完全不知道被移除的内容
          resetSession({ resumeAt, pendingSummary: summaryContent });

          // 界面上以系统消息显示摘要

          useChatStore.getState().addMessage(tid, {
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: summaryContent,
            commandType: 'action',
            commandData: { action: 'rewind', turnIndex: turn.index, mode: 'summarize' },
            timestamp: Date.now(),
          });
          break;
        }
      }
    } catch (err) {
      console.error('[useRewind] executeRewind failed:', err);
      // Ensure we're in a recoverable state even if rewind failed
      resetSession({ keepSession: true });
    }

    // Save to cache
    saveToTab();
  }, [killProcess, resetSession, saveToTab, turns.length]);

  return { turns, showRewind, canRewind, executeRewind };
}
