import { useSettingsStore } from '../stores/settingsStore';
import { t } from './i18n';

/**
 * 当前生效的压缩默认参数：设置为 null 时用内置默认文案，空串表示不附加。
 * 换行折成空格：参数作为斜杠命令的一部分经 stdin 发给 CLI，保持单行最稳妥。
 */
export function getCompactInstructions(): string {
  const custom = useSettingsStore.getState().compactInstructions;
  const text = custom ?? t('settings.compactInstructionsDefault');
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * 拼出发给 CLI 的 /compact 命令。用户自己写了参数时原样使用，
 * 否则附上默认参数（让摘要用指定语言书写、保留 CLAUDE.md 等长期要求）。
 */
export function buildCompactCommand(args?: string): string {
  const own = args?.trim();
  if (own) return `/compact ${own}`;
  const instructions = getCompactInstructions();
  return instructions ? `/compact ${instructions}` : '/compact';
}
