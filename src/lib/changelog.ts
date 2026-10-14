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
    version: '1.2.2',
    date: '2026-10-14',
    highlights: {
      zh: ['全新「探头猫」图标，应用、任务栏、托盘风格统一'],
      en: ['New "peeking cat" icon, consistent across app, taskbar and tray'],
    },
    categories: [
      {
        label: { zh: '调整', en: 'Changed' },
        items: {
          zh: [
            '应用图标、任务栏、托盘、侧栏 Logo 统一为「探头猫」',
            '图标包含 16–256px 多种尺寸，小尺寸使用简化图形，任务栏不再发糊',
          ],
          en: [
            'App icon, taskbar, tray and sidebar logo now share the "peeking cat" design',
            'Icons ship in sizes from 16 to 256 px with a simplified small version, so the taskbar icon is no longer blurry',
          ],
        },
      },
    ],
  },
  {
    version: '1.2.1',
    date: '2026-10-14',
    highlights: {
      zh: ['长会话切换更流畅；会话列表显示后台任务；退出确认与运行状态修复'],
      en: ['Smoother switching for long sessions; background task indicator; exit prompt and running state fixes'],
    },
    categories: [
      {
        label: { zh: '新增', en: 'Added' },
        items: {
          zh: ['会话列表显示 CLI 后台任务运行状态（绿色转圈）'],
          en: ['Session list shows running CLI background tasks (green spinner)'],
        },
      },
      {
        label: { zh: '调整', en: 'Changed' },
        items: {
          zh: [
            '长会话分段渲染，滚到顶部再加载更早的消息',
            '加载会话时去掉截图等大块数据，切换会话不再卡顿',
            '会话文件没变化时不再重复读取',
          ],
          en: [
            'Long sessions render in pages; earlier messages load when scrolling up',
            'Screenshots and other bulky data are dropped when loading sessions, so switching no longer stalls',
            'Unchanged session files are no longer re-read',
          ],
        },
      },
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            '退出确认把已结束的会话也算作运行中',
            '加载会话途中切走后一直显示「运行中」',
            '右键菜单靠近窗口边缘时显示不全',
          ],
          en: [
            'Exit prompt counted finished sessions as running',
            'Session stuck in "running" after switching away during loading',
            'Context menu clipped near window edges',
          ],
        },
      },
    ],
  },
  {
    version: '1.2.0',
    date: '2026-10-12',
    highlights: {
      zh: ['远程项目文件树与终端恢复命令；排队消息、计划审批等多项修复；数据目录统一'],
      en: ['Remote file tree and terminal resume command; fixes for queued messages, plan approval and more; unified data directory'],
    },
    categories: [
      {
        label: { zh: '新增', en: 'Added' },
        items: {
          zh: [
            '远程项目支持只读文件树',
            '会话右键菜单新增「复制终端恢复命令」',
            '模型列表补齐 Opus 5.5、Sonnet 5.5、Opus 4.8、Opus 4.7',
            '错误页显示可复制的错误详情',
          ],
          en: [
            'Read-only file tree for remote projects',
            'Session menu: copy terminal resume command',
            'Model list adds Opus 5.5, Sonnet 5.5, Opus 4.8 and Opus 4.7',
            'Error page shows copyable error details',
          ],
        },
      },
      {
        label: { zh: '调整', en: 'Changed' },
        items: {
          zh: [
            '应用数据统一放到 %APPDATA%\\ClaudeDeck，首次启动自动迁移旧数据',
            '5 小时 / 7 天用量改读 CLI 的 rate_limit_event，不再使用 statusLine 钩子',
            '排队中的消息显示在列表底部，真正发送时才进入聊天记录',
            '会话列表、搜索、加载改在后台线程读取文件，界面不再卡顿',
          ],
          en: [
            'App data unified under %APPDATA%\\ClaudeDeck with automatic migration',
            '5-hour / 7-day usage now read from the CLI rate_limit_event instead of a statusLine hook',
            'Queued messages wait at the bottom and join the chat only when sent',
            'Session list, search and loading read files off the UI thread',
          ],
        },
      },
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            '批准计划后写文件仍弹权限卡',
            '1M 上下文会话显示 100% 并误触发自动压缩',
            '远程会话无法启动（CLIXML）、附件与斜杠命令读取本机',
            '输入框附件同步导致的无限更新；事件监听泄漏',
            '已完成消息里的空思考块显示「思考中...」',
          ],
          en: [
            'Approving a plan still asked permission for file writes',
            '1M-context sessions showed 100% and auto-compacted early',
            'Remote sessions failed to start (CLIXML); attachments and slash commands read locally',
            'Infinite update loop from attachment sync; event listener leaks',
            'Empty thinking blocks showed "Thinking..." on finished messages',
          ],
        },
      },
    ],
  },
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
