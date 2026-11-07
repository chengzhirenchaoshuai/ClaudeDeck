// 界面文案（中文 / 英文，默认中文）。词条按领域分在 zh/、en/ 下，英文文件逐条对应中文，缺漏会编译报错。
import { useSettingsStore } from '../../stores/settingsStore';
import type { Locale } from '../../stores/settingsStore';
import zh from './zh';
import en from './en';

const messages: Record<Locale, Record<string, string>> = { zh, en };

// --- 平台相关占位符替换（只支持 Windows） ---

function resolvePlatformPlaceholders(text: string): string {
  if (!text.includes('{')) return text;
  return text
    .replace(/\{mod\}/g, 'Ctrl')
    .replace(/\{fileManager\}/g, '资源管理器')
    .replace(/\{fileManagerEn\}/g, 'Explorer');
}

// --- 组件外使用的非响应式 t() ---

export function t(key: string): string {
  const locale = useSettingsStore.getState().locale;
  const raw = messages[locale]?.[key] || messages['en'][key] || key;
  return resolvePlatformPlaceholders(raw);
}

// --- 组件内使用的响应式 hook：切换语言时重新渲染 ---

export function useT() {
  const locale = useSettingsStore((s) => s.locale);
  return (key: string): string => {
    const raw = messages[locale]?.[key] || messages['en'][key] || key;
    return resolvePlatformPlaceholders(raw);
  };
}
