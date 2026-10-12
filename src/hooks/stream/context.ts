// 流消息处理函数共用的上下文：消息已路由到的标签页、前台标记、代理树动作与常用写入方法。
import type { MutableRefObject } from 'react';
import type { ActivityStatus, ChatMessage, SessionMeta, SessionStatus } from '../../stores/chatStore';
import type { useAgentStore } from '../../stores/agentStore';
import type { StreamMessage } from '../../lib/stream-message';

/** InputBar 传给流处理器的 ref 与回调 */
export interface StreamProcessorConfig {
  exitPlanModeSeenRef: MutableRefObject<boolean>;
  autoCompactFiredRef: MutableRefObject<boolean>;
  silentRestartRef: MutableRefObject<boolean>;
  handleSubmitRef: MutableRefObject<() => void>;
  handleStderrLineRef: MutableRefObject<(line: string, sid: string) => void>;
  /** 最近一行 stderr 错误：进程没回复就退出时展示给用户 */
  lastStderrRef: MutableRefObject<string>;
  setInputSync: (text: string) => void;
}

export interface StreamContext {
  /** 消息所属标签页（草稿标签页已提升为真实会话 ID） */
  tabId: string;
  msgStdinId?: string;
  /** 是否为当前选中的标签页；依赖 InputBar ref 或 agentStore 的动作只在前台执行 */
  isForeground: boolean;
  /** agentStore 只保存当前标签页的代理树，后台标签页为 null */
  agentActions: ReturnType<typeof useAgentStore.getState> | null;
  agentId: string;
  agentDepth?: number;
  config: StreamProcessorConfig;
  /** 重新进入流处理（自动重试时给新进程注册监听用） */
  dispatch: (msg: StreamMessage) => void;
  addMessage: (message: ChatMessage) => void;
  setSessionStatus: (status: SessionStatus) => void;
  setSessionMeta: (meta: Partial<SessionMeta>) => void;
  setActivityStatus: (status: ActivityStatus) => void;
  /** 清掉流式中的临时正文/思考（会被完整消息取代） */
  clearPartial: () => void;
}
