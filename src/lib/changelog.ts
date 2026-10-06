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
