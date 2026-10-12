// 流消息里的错误文案：命中已知类别时显示友好提示，原始错误放进可折叠的详情里。
import { t } from '../../lib/i18n';

const ERROR_CATEGORIES: ReadonlyArray<{ pattern: RegExp; i18nKey: string }> = [
  { pattern: /40[13]|unauthorized|invalid.*key|api.key.*invalid/i, i18nKey: 'error.invalidKey' },
  { pattern: /429|rate.limit|too.many.request/i, i18nKey: 'error.rateLimit' },
  { pattern: /quota|insufficient.*balance|credit|billing/i, i18nKey: 'error.quotaExceeded' },
  { pattern: /model.*not.found|invalid.*model|not_found.*model/i, i18nKey: 'error.modelNotFound' },
  { pattern: /timeout|timed?.out|ECONNREFUSED|ECONNRESET|ENOTFOUND/i, i18nKey: 'error.networkError' },
  { pattern: /network|fetch.failed|dns/i, i18nKey: 'error.networkError' },
  { pattern: /permission.denied|operation.not.permitted|access.denied|forbidden/i, i18nKey: 'error.permissionDenied' },
  { pattern: /overloaded|capacity|503|service.unavailable/i, i18nKey: 'error.serviceUnavailable' },
  { pattern: /not.installed|command.not.found/i, i18nKey: 'error.cliNotInstalled' },
  { pattern: /token.*limit|context.*length|too.long/i, i18nKey: 'error.tokenLimit' },
];

export function formatErrorForUser(raw: string): string {
  if (!raw || raw.length < 10) return raw;
  const match = ERROR_CATEGORIES.find((c) => c.pattern.test(raw));
  const friendly = match ? t(match.i18nKey) : t('error.genericFallback');
  return `${friendly}\n\n<details>\n<summary>${t('error.showDetails')}</summary>\n\n\`\`\`\n${raw}\n\`\`\`\n\n</details>`;
}
