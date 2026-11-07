import { afterEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});

const { useSettingsStore } = await import('../../stores/settingsStore');
const { t, translate } = await import('../i18n');
const zhParts = import.meta.glob<{ default: Record<string, string> }>('../i18n/zh/*.ts', { eager: true });
const enParts = import.meta.glob<{ default: Record<string, string> }>('../i18n/en/*.ts', { eager: true });

/** 各领域文件（不含 index） */
const domains = (parts: typeof zhParts) =>
  Object.entries(parts).filter(([path]) => !path.endsWith('/index.ts')).map(([path, mod]) => [path, mod.default] as const);
const merged = (parts: typeof zhParts) => Object.entries(parts).find(([path]) => path.endsWith('/index.ts'))![1].default;
// 平台占位符按语言分开写（中文 {fileManager}、英文 {fileManagerEn}），由 t() 统一替换，不参与比较
const PLATFORM_PLACEHOLDERS = new Set(['{mod}', '{fileManager}', '{fileManagerEn}']);
const placeholders = (text: string) =>
  (text.match(/\{[a-zA-Z]+\}/g) ?? []).filter((p) => !PLATFORM_PLACEHOLDERS.has(p)).sort();

describe('词条表', () => {
  it.each([['zh', zhParts], ['en', enParts]] as const)('%s：同一个 key 不能出现在两个领域文件里（合并时会被静默覆盖）', (_, parts) => {
    const owner = new Map<string, string>();
    const dupes: string[] = [];
    for (const [path, dict] of domains(parts)) {
      for (const key of Object.keys(dict)) {
        if (owner.has(key)) dupes.push(`${key}: ${owner.get(key)} / ${path}`);
        owner.set(key, path);
      }
    }
    expect(dupes).toEqual([]);
    expect(Object.keys(merged(parts))).toHaveLength(owner.size);
  });

  it('中英文的 key 完全一致', () => {
    expect(Object.keys(merged(enParts)).sort()).toEqual(Object.keys(merged(zhParts)).sort());
  });

  it('同一条词条中英文的占位符（{n}、{name} 等）一致', () => {
    const zh = merged(zhParts);
    const en = merged(enParts);
    const mismatched = Object.keys(zh).filter((k) => JSON.stringify(placeholders(zh[k])) !== JSON.stringify(placeholders(en[k])));
    expect(mismatched).toEqual([]);
  });

  it('没有空文案', () => {
    for (const dict of [merged(zhParts), merged(enParts)]) {
      expect(Object.entries(dict).filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([]);
    }
  });
});

describe('translate', () => {
  it('按传入的语言取文案，不受当前设置影响（useT 按语言缓存的基础）', () => {
    useSettingsStore.setState({ locale: 'zh' });
    expect(translate('en', 'common.cancel')).toBe('Cancel');
    expect(translate('zh', 'common.cancel')).toBe('取消');
  });

  it('当前语言缺少时退回英文，都没有时返回 key', () => {
    expect(translate('xx' as never, 'common.cancel')).toBe('Cancel');
    expect(translate('zh', 'no.such.key')).toBe('no.such.key');
  });
});

describe('t', () => {
  afterEach(() => {
    useSettingsStore.setState({ locale: 'zh' });
  });

  it('按当前语言取文案', () => {
    useSettingsStore.setState({ locale: 'zh' });
    expect(t('common.cancel')).toBe('取消');
    useSettingsStore.setState({ locale: 'en' });
    expect(t('common.cancel')).toBe('Cancel');
  });

  it('没有的 key 原样返回', () => {
    expect(t('no.such.key')).toBe('no.such.key');
  });

  it('替换平台占位符', () => {
    const zh = merged(zhParts);
    const key = Object.keys(zh).find((k) => zh[k].includes('{mod}'));
    expect(key).toBeDefined();
    useSettingsStore.setState({ locale: 'zh' });
    expect(t(key!)).not.toContain('{mod}');
    expect(t(key!)).toContain('Ctrl');
  });
});
