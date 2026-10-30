// 斜杠即时命令：模式切换、/cost、/usage、/help 等在界面层处理；其余命令经 stdin 交给 CLI。
// stream-json 模式下 CLI 把内置命令当普通文本，所以这些命令都在这里处理。
import { useChatStore, getActiveTabState, generateMessageId } from '../../stores/chatStore';
import { useSettingsStore, MODEL_OPTIONS } from '../../stores/settingsStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useCommandStore } from '../../stores/commandStore';
import { useProviderStore } from '../../stores/providerStore';
import { bridge, isRemotePath } from '../../lib/tauri-bridge';
import { displayProviderModelName } from '../../lib/deepseek-models';
import { getContextUsedTokens } from '../../lib/context-usage';
import { t } from '../../lib/i18n';

export async function executeImmediateCommand(
  cmdName: string,
  args: string | undefined,
  setInputSync: (text: string) => void,
): Promise<void> {
  const cmd = cmdName.toLowerCase().replace(/^\//, '');
  const { addMessage } = useChatStore.getState();
  const tabId = useSessionStore.getState().selectedSessionId;

  // Always clear the input box first
  setInputSync('');

  // Helper: resolve model ID to display name
  const modelLabel = (id: string | undefined): string => {
    if (!id) return '—';
    return MODEL_OPTIONS.find((m) => m.id === id)?.label || displayProviderModelName(id);
  };

  // Helper: add a structured command feedback message
  const feedback = (
    commandType: 'mode' | 'info' | 'help' | 'action' | 'error' | 'login',
    content: string,
    commandData?: Record<string, any>,
  ) => {
    if (!tabId) return;
    addMessage(tabId, {
      id: generateMessageId(),
      role: 'system',
      type: 'text',
      content,
      commandType,
      commandData,
      timestamp: Date.now(),
    });
  };

  switch (cmd) {
    // --- Mode switching ---
    case 'ask':
      useSettingsStore.getState().setSessionMode('ask');
      feedback('mode', t('cmd.switchedToAsk'), { mode: 'ask', icon: '💬' });
      return;
    case 'plan':
      useSettingsStore.getState().setSessionMode('plan');
      feedback('mode', t('cmd.switchedToPlan'), { mode: 'plan', icon: '📋' });
      return;
    case 'code':
      useSettingsStore.getState().setSessionMode('code');
      feedback('mode', t('cmd.switchedToCode'), { mode: 'code', icon: '⚡' });
      return;
    case 'bypass':
      useSettingsStore.getState().setSessionMode('bypass');
      feedback('mode', t('cmd.switchedToBypass'), { mode: 'bypass', icon: '🔓' });
      return;

    // --- Session management ---
    case 'clear':
      if (tabId) useChatStore.getState().resetTab(tabId);
      return;

    case 'rewind':
      window.dispatchEvent(new CustomEvent('tokenicode:rewind'));
      return;

    case 'login':
      // 远程项目的 CLI 在远端，本机登录对它无效
      if (isRemotePath(useSettingsStore.getState().workingDirectory)) {
        feedback('error', t('cmd.loginRemote'));
        return;
      }
      try {
        await bridge.openTerminalLogin();
        feedback('login', t('cmd.loginOpened'));
      } catch (err) {
        feedback('error', `${t('cmd.loginFailed')}: ${err}`);
      }
      return;

    // /compact is handled in the session stdin commands group below

    // --- Info commands ---
    case 'cost': {
      const meta = getActiveTabState().sessionMeta;
      const hasData = meta.cost != null || meta.duration != null || meta.turns != null
        || meta.inputTokens != null || meta.outputTokens != null;
      const tokenValue = (meta.inputTokens != null || meta.outputTokens != null)
        ? `${(meta.inputTokens ?? 0).toLocaleString()} input / ${(meta.outputTokens ?? 0).toLocaleString()} output`
        : '—';
      feedback('info', hasData ? t('cmd.costTitle') : t('cmd.noSessionData'), {
        command: '/cost',
        title: t('cmd.costTitle'),
        rows: [
          { label: t('cmd.costModel'), value: modelLabel(meta.model || useSettingsStore.getState().selectedModel) },
          { label: t('cmd.costAmount'), value: meta.cost != null ? `$${meta.cost.toFixed(4)}` : '—' },
          { label: t('cmd.costDuration'), value: meta.duration != null ? `${(meta.duration / 1000).toFixed(1)}s` : '—' },
          { label: t('cmd.costTurns'), value: meta.turns != null ? String(meta.turns) : '—' },
          { label: t('cmd.costTokens'), value: tokenValue },
        ],
        hasData,
      });
      return;
    }

    case 'usage': {
      const meta = getActiveTabState().sessionMeta;
      const isOfficialProvider = useProviderStore.getState().activeProviderId === null;

      if (isOfficialProvider) {
        // Official Anthropic account: quota data is only available in the CLI REPL TUI.
        // Show local session data + a hint to use the terminal.
        const hasData = meta.cost != null || meta.turns != null
          || meta.inputTokens != null || meta.outputTokens != null;
        const totalInput = meta.totalInputTokens ?? 0;
        const totalOutput = meta.totalOutputTokens ?? 0;
        feedback('info', hasData ? t('cmd.usageTitle') : t('cmd.noSessionData'), {
          command: '/usage',
          title: t('cmd.usageTitle'),
          rows: [
            { label: t('cmd.costModel'), value: modelLabel(meta.model || useSettingsStore.getState().selectedModel) },
            { label: t('cmd.costTurns'), value: meta.turns != null ? String(meta.turns) : '—' },
            { label: t('cmd.usageTotalSession'), value: totalInput || totalOutput
              ? `${totalInput.toLocaleString()} in / ${totalOutput.toLocaleString()} out`
              : '—' },
          ],
          hasData,
          hint: t('cmd.usageOfficialHint'),
        });
      } else {
        // Third-party API provider: show detailed token breakdown.
        const hasData = meta.inputTokens != null || meta.outputTokens != null
          || meta.totalInputTokens != null || meta.totalOutputTokens != null;
        const turnInput = meta.inputTokens ?? 0;
        const turnOutput = meta.outputTokens ?? 0;
        const totalInput = meta.totalInputTokens ?? 0;
        const totalOutput = meta.totalOutputTokens ?? 0;
        feedback('info', hasData ? t('cmd.usageTitle') : t('cmd.noSessionData'), {
          command: '/usage',
          title: t('cmd.usageTitle'),
          rows: [
            { label: t('cmd.costModel'), value: modelLabel(meta.model || useSettingsStore.getState().selectedModel) },
            { label: `${t('cmd.usageCurrentTurn')} — ${t('cmd.usageInput')}`, value: turnInput.toLocaleString() },
            { label: `${t('cmd.usageCurrentTurn')} — ${t('cmd.usageOutput')}`, value: turnOutput.toLocaleString() },
            { label: `${t('cmd.usageTotalSession')} — ${t('cmd.usageInput')}`, value: totalInput.toLocaleString() },
            { label: `${t('cmd.usageTotalSession')} — ${t('cmd.usageOutput')}`, value: totalOutput.toLocaleString() },
            { label: t('cmd.usageTotal'), value: (totalInput + totalOutput).toLocaleString() },
            { label: t('cmd.costAmount'), value: meta.cost != null ? `$${meta.cost.toFixed(4)}` : '—' },
          ],
          hasData,
        });
      }
      return;
    }

    case 'help': {
      const cmds = useCommandStore.getState().commands;
      const builtins = cmds.filter((c) => c.category === 'builtin')
        .map((c) => ({ name: c.name, desc: c.description }));
      const customCount = cmds.filter((c) => c.category === 'command').length;
      const skillCount = cmds.filter((c) => c.category === 'skill').length;
      feedback('help', t('cmd.helpTitle'), {
        builtins,
        customCount,
        skillCount,
      });
      return;
    }

    // --- External commands ---
    case 'bug':
      feedback('action', t('cmd.bugReport'), { action: 'bug', url: 'https://github.com/anthropics/claude-code/issues' });
      return;

    // --- UI-handled commands ---

    case 'rename': {
      if (!args) {
        feedback('error', t('cmd.renameNoArgs'));
        return;
      }
      const sessionId = useSessionStore.getState().selectedSessionId;
      if (sessionId) {
        useSessionStore.getState().setCustomPreview(sessionId, args);
        feedback('action', t('cmd.renamed').replace('{name}', args));
      }
      return;
    }

    case 'export': {
      const meta = getActiveTabState().sessionMeta;
      const sessions = useSessionStore.getState().sessions;
      const session = sessions.find((s: any) => s.id === meta.sessionId);
      const sessionPath = session?.path;
      if (!sessionPath) {
        feedback('error', t('cmd.exportNoPath'));
        return;
      }
      const outputPath = args || sessionPath.replace(/\.jsonl$/, '.md');
      await bridge.exportSessionMarkdown(sessionPath, outputPath);
      feedback('action', `${t('export.success')} ${outputPath}`);
      return;
    }

    // --- All CLI commands: pass through to active session via stdin ---
    // ClaudeDeck is a GUI wrapper — all slash commands are handled by Claude Code CLI.
    default: {
      const stdinId = getActiveTabState().sessionMeta.stdinId;
      if (stdinId && tabId) {
        // Emit a processing card immediately so user sees feedback
        const processingMsgId = generateMessageId();
        // /compact 手动输入触发这条路径时，也提前记一下压缩前的 token 数（原因同
        // ChatPanel 里 ContextMeter 的 handleCompact：不等 CLI 那个时有时无的
        // compact_boundary 事件）。
        const compactSummary = cmd === 'compact'
          ? { compactSummary: { preTokens: getContextUsedTokens(getActiveTabState().sessionMeta) } }
          : {};
        addMessage(tabId, {
          id: processingMsgId,
          role: 'system',
          type: 'text',
          content: '',
          commandType: 'processing',
          commandData: { command: `/${cmd}${args ? ' ' + args : ''}`, ...compactSummary },
          commandStartTime: Date.now(),
          commandCompleted: false,
          timestamp: Date.now(),
        });
        useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: processingMsgId });
        useChatStore.getState().setSessionStatus(tabId, 'running');
        useChatStore.getState().setActivityStatus(tabId, { phase: 'thinking' });
        await bridge.sendStdin(stdinId, `/${cmd}${args ? ' ' + args : ''}`);
      } else {
        feedback('error', `/${cmd}: ${t('cmd.noActiveSession')}`, { command: `/${cmd}` });
      }
      return;
    }
  }
}
