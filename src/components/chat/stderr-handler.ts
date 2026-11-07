// CLI stderr 行的处理：后台标签页的直接显示在对话里；前台的记下最后一行（进程无回复退出时展示），
// 并在计划模式下兜底识别“退出计划模式”的提示，生成计划审阅卡。
// 权限请求已改走 SDK 控制协议（control_request），stderr 只用于诊断。
import type { MutableRefObject } from 'react';
import { useChatStore, getActiveTabState, generateMessageId } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSessionStore } from '../../stores/sessionStore';
import { stripAnsi } from '../../lib/strip-ansi';

export function handleStderrLine(line: string, sid: string, lastStderrRef: MutableRefObject<string>): void {
  const clean = stripAnsi(line).trim();

  // 属于后台标签页：逐行显示在它自己的对话里
  if (sid) {
    const ownerTabId = useSessionStore.getState().getTabForStdin(sid);
    const activeTabId = useSessionStore.getState().selectedSessionId;
    if (ownerTabId && ownerTabId !== activeTabId) {
      if (clean) {
        useChatStore.getState().addMessage(ownerTabId, {
          id: generateMessageId(),
          role: 'system',
          type: 'text',
          content: `[stderr] ${clean}`,
          timestamp: Date.now(),
        });
      }
      return;
    }
  }

  console.log('[ClaudeDeck:stderr]', clean);
  // 记下最后一行非空 stderr，进程没回复就退出时展示给用户
  if (clean) lastStderrRef.current = clean;

  // 计划模式下识别“退出计划模式”的提示，兜底生成计划审阅卡（代码/跳过模式由 CLI 或后端处理）
  if (/(?:Exit|Leave)\s+plan\s+mode/i.test(clean) && useSettingsStore.getState().sessionMode === 'plan') {
    const tabId = useSessionStore.getState().selectedSessionId;
    const tab = getActiveTabState();
    const existingReview = tab.messages.find((m) => m.id === 'plan_review_current' && m.type === 'plan_review');
    // 已有审阅卡（无论是否已处理）时不再重复生成
    if (existingReview || !tabId) return;
    let planContent = '';
    for (let i = tab.messages.length - 1; i >= 0; i--) {
      const m = tab.messages[i];
      if (m.type === 'tool_use' && m.toolName === 'Write' && m.toolInput?.content) {
        planContent = m.toolInput.content;
        break;
      }
    }
    useChatStore.getState().addMessage(tabId, {
      id: 'plan_review_current',
      role: 'assistant',
      type: 'plan_review',
      content: planContent,
      planContent,
      resolved: false,
      timestamp: Date.now(),
    });
    useChatStore.getState().setActivityStatus(tabId, { phase: 'awaiting' });
  }
}
