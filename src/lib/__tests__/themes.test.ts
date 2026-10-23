import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DARK_SKIN,
  DEFAULT_LIGHT_SKIN,
  SKINS,
  migrateLegacySkin,
  skinForMode,
} from '../themes';
import i18nSource from '../i18n.ts?raw';

describe('themes', () => {
  it('方案 id 不重复，且两种深浅都有方案', () => {
    const ids = SKINS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(skinForMode(DEFAULT_LIGHT_SKIN, 'light').id).toBe(DEFAULT_LIGHT_SKIN);
    expect(skinForMode(DEFAULT_DARK_SKIN, 'dark').id).toBe(DEFAULT_DARK_SKIN);
  });

  it('每套方案都有中英文名称', () => {
    // i18n.ts 里 zh、en 各一份，名称键应恰好出现两次
    for (const skin of SKINS) {
      expect(i18nSource.split(`'skin.${skin.id}':`).length - 1, skin.id).toBe(2);
    }
  });

  it('id 不存在或深浅不符时退回默认方案', () => {
    expect(skinForMode('nope', 'light').id).toBe(DEFAULT_LIGHT_SKIN);
    expect(skinForMode('dracula', 'light').id).toBe(DEFAULT_LIGHT_SKIN);
    expect(skinForMode('sakura', 'dark').id).toBe(DEFAULT_DARK_SKIN);
    // 旧的「花园」已改为樱花
    expect(skinForMode('garden', 'light').id).toBe('sakura');
    expect(skinForMode('dracula', 'dark').id).toBe('dracula');
    // 已下线的方案
    expect(skinForMode('nord', 'dark').id).toBe(DEFAULT_DARK_SKIN);
  });

  describe('migrateLegacySkin', () => {
    it('粉樱 → 樱花，外观改为浅色', () => {
      const p: Record<string, unknown> = { theme: 'system', colorTheme: 'blue', backgroundTheme: 'sakura' };
      migrateLegacySkin(p);
      expect(p).toEqual({ theme: 'light', lightSkin: 'sakura', darkSkin: DEFAULT_DARK_SKIN });
    });

    it('已下线的浅色背景风格 → 默认浅色方案', () => {
      const p: Record<string, unknown> = { theme: 'system', backgroundTheme: 'lake' };
      migrateLegacySkin(p);
      expect(p).toEqual({ theme: 'light', lightSkin: DEFAULT_LIGHT_SKIN, darkSkin: DEFAULT_DARK_SKIN });
    });

    it('VS Code Dark → 默认深色方案，外观改为深色', () => {
      const p: Record<string, unknown> = { theme: 'light', backgroundTheme: 'vscode' };
      migrateLegacySkin(p);
      expect(p).toEqual({ theme: 'dark', lightSkin: DEFAULT_LIGHT_SKIN, darkSkin: DEFAULT_DARK_SKIN });
    });

    it('缺失或未知的值按默认浅色方案处理', () => {
      const p: Record<string, unknown> = { theme: 'dark', backgroundTheme: 'unknown' };
      migrateLegacySkin(p);
      expect(p).toEqual({ theme: 'light', lightSkin: DEFAULT_LIGHT_SKIN, darkSkin: DEFAULT_DARK_SKIN });
    });
  });
});
