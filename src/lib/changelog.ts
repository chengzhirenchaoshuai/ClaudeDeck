import type { Locale } from '../stores/settingsStore';

export interface ChangelogCategory {
  label: Record<Locale, string>;
  items: Record<Locale, string[]>;
}

export interface ChangelogEntry {
  version: string;
  date: string;
  highlights: Record<Locale, string[]>;
  categories?: ChangelogCategory[];
}

/**
 * 设置页“更新内容”弹窗的数据，只显示与当前应用版本号一致的那一条。
 * 发布新版本时在最前面追加一条，旧条目可以删除；完整历史见 CHANGELOG.md。
 */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '1.1.0',
    date: '2026-10-06',
    highlights: {
      zh: ['自用版本 ClaudeDeck 首个发布：会话同步、远程主机、用量显示'],
      en: ['First ClaudeDeck release: session sync, remote hosts, usage display'],
    },
    categories: [
      {
        label: { zh: '新增', en: 'Added' },
        items: {
          zh: [
            '会话列表以 CLI 的 projects 目录为准，按项目分组并实时同步',
            'SSH 远程主机：侧栏切换本地/远程，远程会话可新建、改名、归档、删除',
            '用量显示：token 统计、费用估算、5 小时 / 7 天真实用量状态条',
            '直接编辑已发送的消息；未读标记与任务栏角标',
            '系统托盘、关闭时最小化、开机自启动、界面设置页',
          ],
          en: [
            'Session list follows the CLI projects directory, grouped by project with live sync',
            'SSH remote hosts with a local/remote switch; create, rename, archive and delete remote sessions',
            'Usage display: token stats, cost estimate, real 5-hour / 7-day usage bar',
            'Edit sent messages; unread markers and taskbar badge',
            'System tray, minimize on close, launch at startup, interface settings',
          ],
        },
      },
      {
        label: { zh: '调整', en: 'Changed' },
        items: {
          zh: [
            '项目改名为 ClaudeDeck，关闭应用内自动更新',
            '模型、思考强度、权限模式选项与当前 Claude Code 保持一致',
            '按模型识别上下文窗口与自动压缩阈值',
          ],
          en: [
            'Renamed to ClaudeDeck; in-app updater disabled',
            'Model, thinking and permission options match current Claude Code',
            'Context window and auto-compact threshold follow the selected model',
          ],
        },
      },
    ],
  },
  {
    version: '1.0.8',
    date: '2026-08-04',
    highlights: {
      zh: ['修复 AskUserQuestion、历史会话、上下文恢复与思考显示回归'],
      en: ['AskUserQuestion, session history, context restore, and thinking display regression fixes'],
    },
    categories: [
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            'AskUserQuestion 选择结果按问题原文组装并通过控制协议真实回传，不再只显示已响应',
            '历史列表不再过滤尚无助手记录的会话，避免 v1.0.7 升级后旧对话消失',
            '重新打开会话时恢复最新上下文快照，并对重复消息记录去重，避免归零或双倍计算',
            '已完成的思考过程默认展开，直接显示小字思考内容',
            '启动诊断日志不再记录提示词、回复、思考内容或工具参数',
          ],
          en: [
            'AskUserQuestion selections are keyed by question text and delivered through the control protocol',
            'Sessions without an assistant record remain visible instead of disappearing from history',
            'Reopened sessions restore the latest context snapshot with duplicate message usage removed',
            'Completed thinking details are expanded by default',
            'Startup diagnostics no longer record prompts, replies, thinking text, or tool input',
          ],
        },
      },
    ],
  },
];

export function getChangelog(version: string): ChangelogEntry | null {
  return CHANGELOG.find((e) => e.version === version) || null;
}
