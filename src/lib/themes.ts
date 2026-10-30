/**
 * 主题方案清单。
 *
 * 每套方案的颜色变量写在 App.css 的 `:root[data-skin="<id>"]` 下；
 * 这里只登记 id、深浅、是否简洁风格和设置页缩略图用的颜色。
 * 新增方案：在 SKINS 里加一项 + App.css 加一段变量 + i18n 加 `skin.<id>`。
 */

export type SkinMode = 'light' | 'dark';

export type SkinId =
  // 浅色
  | 'sakura'
  | 'mint'
  | 'orange'
  | 'sky'
  // 深色
  | 'sakura-night'
  | 'mint-night'
  | 'orange-night'
  | 'sky-night'
  | 'terminal';

export interface SkinDef {
  id: SkinId;
  mode: SkinMode;
  /** 简洁风格：去掉水彩边框、点缀符号和网格底纹，改用极光晕染 */
  flat: boolean;
  /** 缩略图配色：主区背景、侧栏、强调色、文字 */
  preview: {
    bg: string;
    sidebar: string;
    accent: string;
    text: string;
    /** 主区背景渐变（水彩底色或极光），缺省用 bg */
    background?: string;
  };
}

/** 缩略图里的极光：右上、左下各一团方案色，与 App.css 质感层一致 */
const aurora = (bg: string, a: string, b: string) =>
  `radial-gradient(circle at 100% 0%, ${a}55, transparent 60%), radial-gradient(circle at 0% 100%, ${b}44, transparent 55%), ${bg}`;

export const SKINS: SkinDef[] = [
  {
    id: 'sakura', mode: 'light', flat: false,
    preview: {
      bg: '#FFF7FA', sidebar: '#FFEEF4', accent: '#E0507F', text: '#55283A',
      background: 'radial-gradient(circle at 88% 12%, #F7A8C2 0 18%, transparent 20%), linear-gradient(135deg, #FFF7FA, #FAD3E0)',
    },
  },
  {
    id: 'mint', mode: 'light', flat: true,
    preview: { bg: '#FAFEFB', sidebar: '#EEF8F2', accent: '#17915A', text: '#1C3A2C', background: aurora('#FAFEFB', '#7DDCB0', '#5CC8E0') },
  },
  {
    id: 'orange', mode: 'light', flat: true,
    preview: { bg: '#FFFCF8', sidebar: '#FFF4E9', accent: '#E8700F', text: '#3D2614', background: aurora('#FFFCF8', '#FFB36B', '#FFD36B') },
  },
  {
    id: 'sky', mode: 'light', flat: true,
    preview: { bg: '#F9FCFF', sidebar: '#EDF6FD', accent: '#1E8FD6', text: '#15324A', background: aurora('#F9FCFF', '#7FD0FF', '#9EE6F0') },
  },
  {
    id: 'sakura-night', mode: 'dark', flat: false,
    preview: {
      bg: '#21151C', sidebar: '#1A1116', accent: '#BE3F71', text: '#F8E6ED',
      background: 'radial-gradient(circle at 88% 12%, #BE3F71 0 18%, transparent 20%), linear-gradient(135deg, #21151C, #3D2732)',
    },
  },
  {
    id: 'mint-night', mode: 'dark', flat: true,
    preview: { bg: '#121D18', sidebar: '#0E1612', accent: '#137D4D', text: '#E4F4EB', background: aurora('#121D18', '#34C38F', '#2AA5C4') },
  },
  {
    id: 'orange-night', mode: 'dark', flat: true,
    preview: { bg: '#1E1711', sidebar: '#17110C', accent: '#BD5A0B', text: '#F8EBDF', background: aurora('#1E1711', '#F08A3C', '#E0B040') },
  },
  {
    id: 'sky-night', mode: 'dark', flat: true,
    preview: { bg: '#101B26', sidebar: '#0C141C', accent: '#1673B5', text: '#E3F1FB', background: aurora('#101B26', '#38A8F0', '#3FC4D4') },
  },
  {
    // 命令行控制台风，不带极光
    id: 'terminal', mode: 'dark', flat: true,
    preview: { bg: '#0D110E', sidebar: '#0A0D0B', accent: '#1C7F45', text: '#D0DAD3' },
  },
];

export const DEFAULT_LIGHT_SKIN: SkinId = 'sakura';
export const DEFAULT_DARK_SKIN: SkinId = 'sakura-night';

const SKIN_MAP = new Map<string, SkinDef>(SKINS.map((s) => [s.id, s]));

export function getSkin(id: string): SkinDef | undefined {
  return SKIN_MAP.get(id);
}

/** 取指定深浅的方案；id 不存在或深浅不符时退回该深浅的默认方案 */
export function skinForMode(id: string, mode: SkinMode): SkinDef {
  const skin = SKIN_MAP.get(id);
  if (skin && skin.mode === mode) return skin;
  return SKIN_MAP.get(mode === 'dark' ? DEFAULT_DARK_SKIN : DEFAULT_LIGHT_SKIN)!;
}

/** 旧 backgroundTheme 里唯一的深色方案；其余旧值（garden/sakura/lake/dusk/ink/minimal）都是浅色 */
const LEGACY_DARK_BACKGROUNDS = new Set(['vscode']);

/**
 * settings v18 迁移：旧的 colorTheme（已失效）和 backgroundTheme（实际决定界面颜色）
 * 改为 lightSkin / darkSkin。外观设为旧方案的深浅；旧方案已下线时用该深浅的默认方案。
 */
export function migrateLegacySkin(persisted: Record<string, unknown>): void {
  const old = String(persisted.backgroundTheme ?? '');
  const mode: SkinMode = LEGACY_DARK_BACKGROUNDS.has(old) ? 'dark' : 'light';
  const skin = skinForMode(old, mode);
  persisted.lightSkin = mode === 'light' ? skin.id : DEFAULT_LIGHT_SKIN;
  persisted.darkSkin = mode === 'dark' ? skin.id : DEFAULT_DARK_SKIN;
  persisted.theme = mode;
  delete persisted.colorTheme;
  delete persisted.backgroundTheme;
}
