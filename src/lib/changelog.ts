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
    version: '1.4.5',
    date: '2026-10-28',
    highlights: {
      zh: ['运行指示器显示真实进度；远程会话与附件问题修复'],
      en: ['Activity indicator shows real progress; remote session and attachment fixes'],
    },
    categories: [
      {
        label: { zh: '新增', en: 'Added' },
        items: {
          zh: [
            '运行指示器显示正在执行的动作和对象（读取、运行、搜索），并行时显示其余数量',
            '复制消息文本时，文件链接带上完整路径',
          ],
          en: [
            'Activity indicator shows the current action and target (read, run, search), with a count of parallel tools',
            'Copying message text includes full paths for file links',
          ],
        },
      },
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: [
            '远程模式下新建会话出现影子行、没有自动命名',
            '远程项目添加附件一直显示加载中',
            '回复权限请求或提问后运行状态不正确',
          ],
          en: [
            'Shadow rows and missing titles for new sessions in remote mode',
            'Adding attachments in remote projects kept loading forever',
            'Wrong activity status after answering a permission request or question',
          ],
        },
      },
    ],
  },
  {
    version: '1.4.4',
    date: '2026-10-28',
    highlights: {
      zh: ['每轮回复显示用时；修复新建会话后的影子行'],
      en: ['Each reply shows how long it took; fixed ghost rows after starting a new session'],
    },
    categories: [
      {
        label: { zh: '新增', en: 'Added' },
        items: {
          zh: ['每轮回复结束后显示用时，历史会话同样显示'],
          en: ['Each turn shows how long it took once finished, including in past sessions'],
        },
      },
      {
        label: { zh: '调整', en: 'Changed' },
        items: {
          zh: ['发送消息后自动跳到底部', '项目根目录中不存在的文件名链接显示为灰色，不再点开后报错'],
          en: ['Sending a message scrolls to the bottom', 'File-name links not found in the project root are greyed out instead of failing to open'],
        },
      },
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: ['新建会话后列表里出现没有标题的影子行，选中一个会同时选中另一个'],
          en: ['A ghost untitled row appeared after starting a new session, and selecting one selected both'],
        },
      },
    ],
  },
  {
    version: '1.4.3',
    date: '2026-10-27',
    highlights: {
      zh: ['顶部栏显示 Git 分支与 gh 登录状态；会话列表更清爽'],
      en: ['Git branch and gh login status in the top bar; a tidier session list'],
    },
    categories: [
      {
        label: { zh: '新增', en: 'Added' },
        items: {
          zh: [
            'Git 小标签：当前分支、未提交改动数，点击查看提交署名、GitHub 账号与远程地址，gh 登录有问题时给出提醒',
            '项目展开后默认只显示 5 个会话，其余可展开',
            '隐藏工作目录在系统临时目录下的一次性会话',
          ],
          en: [
            'Git chip: current branch and uncommitted changes; click for commit identity, GitHub account and remote URL, with a hint when gh login needs attention',
            'Projects show 5 sessions by default, expandable to the rest',
            'One-off sessions whose working directory is in the system temp folder are hidden',
          ],
        },
      },
      {
        label: { zh: '调整', en: 'Changed' },
        items: {
          zh: ['工具调用预览不再截断，展开后的输出区域加高', '标题栏透明，面板背景延伸到窗口顶部'],
          en: ['Tool call previews are no longer truncated, and expanded output is taller', 'Transparent title bar with panel backgrounds reaching the top of the window'],
        },
      },
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: ['打开会话后没有滚动到末尾', '删除远程会话后仍显示在列表里'],
          en: ['Opening a session did not scroll to the end', 'Deleted remote sessions stayed in the list'],
        },
      },
    ],
  },
  {
    version: '1.4.2',
    date: '2026-10-26',
    highlights: {
      zh: ['免安装版也支持应用内更新'],
      en: ['In-app updates for the portable build'],
    },
    categories: [
      {
        label: { zh: '新增', en: 'Added' },
        items: {
          zh: [
            '免安装版下载新版本并校验签名后替换自身，自动重新打开',
            '免安装版更新后统一命名为 ClaudeDeck.exe，旧版本文件和下载残留自动清理',
            '更新后程序路径变化时，开机自启自动改用新路径',
          ],
          en: [
            'The portable build downloads, verifies and replaces itself, then relaunches',
            'After updating, the portable build is always named ClaudeDeck.exe; old files and leftovers are cleaned up',
            'Autostart follows the new path when the update changes it',
          ],
        },
      },
    ],
  },
  {
    version: '1.4.1',
    date: '2026-10-26',
    highlights: {
      zh: ['支持应用内更新'],
      en: ['In-app updates'],
    },
    categories: [
      {
        label: { zh: '新增', en: 'Added' },
        items: {
          zh: [
            '启动后自动检查新版本，顶栏出现更新按钮；安装版可直接下载并安装，装完自动重新打开',
            '免安装版发现新版本时引导到发布页手动下载',
            '设置页底栏恢复「检查更新」按钮',
            '安装更新前，如有任务正在运行会先确认，并有序结束所有会话',
          ],
          en: [
            'Checks for new versions on startup and shows an update button in the top bar; the installed build downloads, installs and relaunches in place',
            'The portable build opens the releases page to download the new version manually',
            'The "Check for Updates" button is back in the settings footer',
            'Before installing, running tasks are confirmed and all sessions are shut down cleanly',
          ],
        },
      },
    ],
  },
  {
    version: '1.4.0',
    date: '2026-10-23',
    highlights: {
      zh: ['全新主题方案与自绘标题栏；对话中显示上下文压缩提示'],
      en: ['New theme presets and custom title bar; context compaction notices in the conversation'],
    },
    categories: [
      {
        label: { zh: '新增', en: 'Added' },
        items: {
          zh: [
            '主题方案：浅色、深色各选一套，随外观自动切换',
            '自绘标题栏，与主题背景或自定义壁纸融为一体',
            '上下文压缩后，对话里显示压缩前后 token 数、保留的文件和压缩摘要',
            '文件预览可复制内容',
            '消息里的文件路径支持行号和中文路径',
          ],
          en: [
            'Theme presets: pick one light and one dark theme, switched with the appearance',
            'Custom title bar that blends with the theme background or wallpaper',
            'After context compaction, the conversation shows token counts, kept files and the summary',
            'Copy content from the file preview',
            'File paths in messages support line numbers and non-ASCII names',
          ],
        },
      },
      {
        label: { zh: '调整', en: 'Changed' },
        items: {
          zh: [
            '自定义背景上传时自动压缩，固定铺满',
            '打开设置时长会话不再卡顿',
            '远程文件树扫描更深、条目上限更高',
          ],
          en: [
            'Custom backgrounds are compressed on upload and always fill the window',
            'Opening settings no longer stalls long conversations',
            'Remote file tree scans deeper and lists more entries',
          ],
        },
      },
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: ['远程项目的文件打开、附件读取与路径恢复问题', '背景图过大时操作被打断'],
          en: ['Opening files, reading attachments and restoring paths in remote projects', 'Actions interrupted when the background image was too large'],
        },
      },
    ],
  },
  {
    version: '1.3.0',
    date: '2026-10-22',
    highlights: {
      zh: ['与终端 claude 打通：跟随 CLI 配置、会话互相续接、显示终端会话'],
      en: ['Works hand in hand with terminal claude: follow CLI config, shared sessions, terminal sessions in the list'],
    },
    categories: [
      {
        label: { zh: '新增', en: 'Added' },
        items: {
          zh: [
            '「跟随 CLI 配置」：App 启动的会话与终端行为一致，模型与思考档位可选「CLI 默认」',
            '终端续接会话时 App 自动同步，下次发送接上最新上下文',
            '运行中发送的消息直接交给 CLI，在工具调用间隙插入本轮',
            '会话列表显示终端里运行的 claude 会话（本机与远程），回复完成时标记未读',
            'App 启动的会话出现在终端 /resume 列表里',
            '用量显示距重置的剩余时间',
          ],
          en: [
            '"Follow CLI config": sessions started by the app behave like terminal claude; model and thinking level can use "CLI default"',
            'Sessions continued in the terminal sync back automatically, and the next message resumes the latest context',
            'Messages sent while running go straight to the CLI and join the current turn between tool calls',
            'Session list shows claude sessions running in terminals (local and remote) and marks them unread when they finish',
            'Sessions started by the app appear in the terminal /resume list',
            'Usage shows time remaining until reset',
          ],
        },
      },
      {
        label: { zh: '调整', en: 'Changed' },
        items: {
          zh: [
            '会话列表按最后发言时间排序，不再来回跳动',
            '选项卡重新设计，支持上一步，悬浮显示不挤占消息区',
            '美化 Markdown 表格、代码、引用、列表与脚注',
          ],
          en: [
            'Sessions are sorted by last prompt time and no longer jump around',
            'Redesigned question cards with a Back button, floating above the input bar',
            'Polished Markdown tables, code, quotes, lists and footnotes',
          ],
        },
      },
      {
        label: { zh: '修复', en: 'Fixed' },
        items: {
          zh: ['公式错位与裁切', '任务栏图标发糊'],
          en: ['Misaligned or clipped math formulas', 'Blurry taskbar icon'],
        },
      },
    ],
  },
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
