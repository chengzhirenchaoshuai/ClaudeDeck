import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ModelPrice } from '../lib/usage';
import {
  DEEPSEEK_V4_FLASH,
  DEEPSEEK_V4_PRO,
  normalizeProviderModelName,
} from '../lib/deepseek-models';
import { DEFAULT_DARK_SKIN, DEFAULT_LIGHT_SKIN, migrateLegacySkin, type SkinId } from '../lib/themes';

// --- Types ---

export type Theme = 'light' | 'dark' | 'system';
export type SecondaryPanelTab = 'files' | 'preview' | 'skills' | 'plugins';
export type ModelId =
  | 'claude-fable-5-1'
  | 'claude-opus-5-5'
  | 'claude-sonnet-5-5'
  | 'claude-opus-5'
  | 'claude-sonnet-5'
  | 'claude-opus-4-8'
  | 'claude-opus-4-7'
  | 'claude-opus-4-6'
  | 'claude-opus-4-6-1m'
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5-20251001';
export type SessionMode = 'code' | 'ask' | 'plan' | 'auto' | 'bypass';
export type FontFamily = 'system' | 'microsoft' | 'sourceHan' | 'lxgw' | 'mono';
/** CLI permission mode for the SDK control protocol */
export type CliPermissionMode = 'acceptEdits' | 'default' | 'plan' | 'auto' | 'bypassPermissions';
export type Locale = 'zh' | 'en';

/** Map frontend session mode to CLI permission mode */
export function mapSessionModeToPermissionMode(mode: SessionMode): CliPermissionMode {
  switch (mode) {
    case 'code': return 'acceptEdits';
    case 'ask': return 'default';
    case 'plan': return 'plan';
    case 'auto': return 'auto';
    case 'bypass': return 'bypassPermissions';
  }
}
/** 模型 / 思考档位选“CLI 默认”时的值：启动 CLI 时不传对应参数，沿用 CLI 自己的配置 */
export const CLI_DEFAULT = 'cli-default';
export type ThinkingLevel = typeof CLI_DEFAULT | 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ContextWindowMode = 'default' | 'large1m';

function defaultAutoCompactThreshold(mode: ContextWindowMode): number {
  return mode === 'large1m' ? 800_000 : 160_000;
}

function clampAutoCompactThreshold(tokens: number): number {
  if (!Number.isFinite(tokens)) return 160_000;
  return Math.max(10_000, Math.min(1_000_000, Math.round(tokens)));
}

// --- Model options (display mapping) ---

// 与已安装 CLI（2.1.291）内置的模型 ID 核对过；按新到旧排列
export const MODEL_OPTIONS: { id: ModelId; label: string; short: string }[] = [
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', short: 'Fable 5.1' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', short: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', short: 'Sonnet 5.5' },
  { id: 'claude-opus-5', label: 'Claude Opus 5', short: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', short: 'Sonnet 5' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', short: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', short: 'Opus 4.7' },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', short: 'Opus 4.6' },
  { id: 'claude-opus-4-6-1m', label: 'Claude Opus 4.6 (1M)', short: 'Opus 4.6 1M' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', short: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', short: 'Haiku 4.5' },
];

/** 官方模型所属档位；第三方供应商按档位（opus / sonnet / haiku）映射到自己的模型 */
export const MODEL_TIER_MAP: Record<string, 'opus' | 'sonnet' | 'haiku'> = {
  'claude-fable-5-1': 'opus',
  'claude-opus-5-5': 'opus',
  'claude-sonnet-5-5': 'sonnet',
  'claude-opus-5': 'opus',
  'claude-sonnet-5': 'sonnet',
  'claude-opus-4-8': 'opus',
  'claude-opus-4-7': 'opus',
  'claude-opus-4-6': 'opus',
  'claude-opus-4-6-1m': 'opus',
  'claude-sonnet-4-6': 'sonnet',
  'claude-haiku-4-5-20251001': 'haiku',
};

function migrateModelSelection(model: unknown): ModelId | undefined {
  if (typeof model !== 'string') return undefined;
  const normalized = normalizeProviderModelName(model);
  if (normalized === DEEPSEEK_V4_PRO) return 'claude-opus-4-6';
  if (normalized === DEEPSEEK_V4_FLASH) return 'claude-sonnet-4-6';
  if (MODEL_OPTIONS.some((option) => option.id === model)) return model as ModelId;
  if (model === 'claude-haiku-4-5') return 'claude-haiku-4-5-20251001';
  return undefined;
}

// --- Store State & Actions ---

interface SettingsState {
  theme: Theme;
  /** 浅色外观下使用的主题方案 */
  lightSkin: SkinId;
  /** 深色外观下使用的主题方案 */
  darkSkin: SkinId;
  sidebarOpen: boolean;
  secondaryPanelOpen: boolean;
  secondaryPanelTab: SecondaryPanelTab;
  secondaryPanelWidth: number;
  settingsOpen: boolean;
  /** 用量面板是否打开（不持久化） */
  usageOpen: boolean;
  /** 用量面板打开时默认停在哪个 Tab（不持久化） */
  usageModalTab: 'usage' | 'activity';
  /** 用户自定义的模型价格（键为归一化的模型名）；覆盖内置的官方标价 */
  customModelPrices: Record<string, ModelPrice>;
  workingDirectory: string;
  /** 当前环境：'local' 表示本机，否则为远程主机 id。本地与远程模式互相隔离 */
  activeEnv: string;
  selectedModel: string;
  sessionMode: SessionMode;
  locale: Locale;
  /** Global UI font size in px (default 18) */
  fontSize: number;
  /** Global UI font family preset */
  fontFamily: FontFamily;
  /** Whether mono-styled UI labels should follow the selected interface font */
  monoFontFollowsInterface: boolean;
  /** Sidebar width in px (default 280) */
  sidebarWidth: number;
  /** Whether the CLI setup wizard has been completed or skipped */
  setupCompleted: boolean;
  /** Thinking effort level: off disables, low/medium/high/max set effort */
  thinkingLevel: ThinkingLevel;
  /** Declares that the selected/provider model supports a 1M context window. */
  contextWindowMode: ContextWindowMode;
  /** User-adjustable auto compact threshold in tokens. */
  /** 自动 compact 阈值（tokens）；null 表示按所选模型自动取上下文窗口的 80% */
  autoCompactThresholdTokens: number | null;
  /** Whether a newer CLI version is available */
  cliUpdateAvailable: boolean;
  /** Latest CLI version string (for display) */
  cliLatestVersion: string;
  /** Custom AI avatar image (data URL or empty string for default </> icon) */
  aiAvatarUrl: string;
  /** Custom user avatar image (data URL or empty string for default initials) */
  userAvatarUrl: string;
  /** User display name shown next to messages */
  userDisplayName: string;
  /** Whether to show dotfiles (hidden files) in the file tree */
  showHiddenFiles: boolean;
  /** Whether Enter sends (false, default) or Ctrl+Enter sends (true) */
  ctrlEnterToSend: boolean;
  /** 点击窗口关闭按钮时最小化到任务栏（默认开启），而不是退出应用 */
  minimizeOnClose: boolean;
  /** 在会话中加载 MCP 服务器（默认关闭：加载 MCP 会拖慢每个会话的启动） */
  enableMcp: boolean;
  /** 提示建议（默认开启）：每轮结束后预测下一句话，输入框为空时灰色显示，按 Tab 填入 */
  promptSuggestions: boolean;
  /** 跟随 CLI 配置（默认开启）：不注入 MCP、思考、输出上限、代理等参数，行为与终端里的 claude 一致 */
  followCli: boolean;
  /** 「CLI 默认」模式下 CLI 最近一次上报的实际模型；新会话在 CLI 上报前用它估算上下文窗口 */
  lastCliModel: string;
  /** Whether Ctrl+Click on a file opens it with the system default app */
  ctrlClickOpenExternally: boolean;
  /** Whether to show image thumbnail previews in chat for images < 50MB */
  showImageThumbnails: boolean;
  /** Extra user-selected roots containing Claude-compatible skills. */
  skillDirectories: string[];

  // ── Custom background (user-uploaded image) ──
  /** Base64 data URL of user-uploaded custom background image, empty = disabled */
  customBgImage: string;
  /** 背景图上的面板毛玻璃模糊（px，0–20） */
  glassBlur: number;
  /** 背景图上的面板不透明度（%，30–100，越大越不透明、文字越清楚） */
  glassOpacity: number;

  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  setLightSkin: (skin: SkinId) => void;
  setDarkSkin: (skin: SkinId) => void;
  /** Whether the floating agent panel is open */
  agentPanelOpen: boolean;

  toggleSidebar: () => void;
  toggleSecondaryPanel: () => void;
  toggleAgentPanel: () => void;
  setSecondaryTab: (tab: SecondaryPanelTab) => void;
  setSecondaryPanelWidth: (width: number) => void;
  toggleSettings: () => void;
  setWorkingDirectory: (dir: string) => void;
  /** 切换环境，并清空工作目录（本地与远程的项目路径互不通用） */
  setActiveEnv: (env: string) => void;
  setSelectedModel: (model: string) => void;
  setSessionMode: (mode: SessionMode) => void;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  setFontSize: (size: number) => void;
  setFontFamily: (family: FontFamily) => void;
  setMonoFontFollowsInterface: (enabled: boolean) => void;
  increaseFontSize: () => void;
  decreaseFontSize: () => void;
  setSidebarWidth: (width: number) => void;
  setSetupCompleted: (completed: boolean) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
  setContextWindowMode: (mode: ContextWindowMode) => void;
  setAutoCompactThresholdTokens: (tokens: number | null) => void;
  setAiAvatarUrl: (url: string) => void;
  setUserAvatarUrl: (url: string) => void;
  setUserDisplayName: (name: string) => void;
  toggleHiddenFiles: () => void;
  toggleCtrlEnterToSend: () => void;
  toggleMinimizeOnClose: () => void;
  toggleEnableMcp: () => void;
  togglePromptSuggestions: () => void;
  toggleFollowCli: () => void;
  setLastCliModel: (model: string) => void;
  /** 打开/关闭用量面板；传入 tab 时同时切到该 Tab（仅在从关闭状态打开时生效） */
  toggleUsage: (tab?: 'usage' | 'activity') => void;
  /** 面板打开时手动切换 Tab */
  setUsageModalTab: (tab: 'usage' | 'activity') => void;
  setCustomModelPrice: (model: string, price: ModelPrice | null) => void;
  toggleCtrlClickOpenExternally: () => void;
  toggleShowImageThumbnails: () => void;
  addSkillDirectory: (path: string) => void;
  removeSkillDirectory: (path: string) => void;
  setCustomBgImage: (image: string) => void;
  setGlassBlur: (blur: number) => void;
  setGlassOpacity: (opacity: number) => void;
  clearCustomBg: () => void;
}

// --- Theme cycle order ---

const themeCycle: Theme[] = ['light', 'dark', 'system'];

function nextTheme(current: Theme): Theme {
  const idx = themeCycle.indexOf(current);
  return themeCycle[(idx + 1) % themeCycle.length];
}

// --- Store ---

/**
 * localStorage 写满（通常是背景图、头像这类 data URL 太大）时 setItem 会同步抛错，
 * zustand 的 persist 不捕获，异常会从每次 set() 冒出来，打断调用方后续逻辑（例如打开会话）。
 * 这里吞掉写入错误，只记日志：设置照常生效，只是这次没能保存。
 */
const safeLocalStorage = {
  getItem: (name: string) => localStorage.getItem(name),
  setItem: (name: string, value: string) => {
    try {
      localStorage.setItem(name, value);
    } catch (e) {
      console.error(`[settings] 保存失败（${(value.length / 1024 / 1024).toFixed(1)}MB）：`, e);
    }
  },
  removeItem: (name: string) => localStorage.removeItem(name),
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'system',
      lightSkin: DEFAULT_LIGHT_SKIN,
      darkSkin: DEFAULT_DARK_SKIN,
      sidebarOpen: true,
      secondaryPanelOpen: false,
      secondaryPanelTab: 'files',
      secondaryPanelWidth: 300,
      settingsOpen: false,
      usageOpen: false,
      usageModalTab: 'usage',
      customModelPrices: {},
      agentPanelOpen: false,
      workingDirectory: '',
      activeEnv: 'local',
      selectedModel: CLI_DEFAULT,
      sessionMode: 'bypass',
      locale: 'zh',
      fontSize: 18,
      fontFamily: 'microsoft',
      monoFontFollowsInterface: true,
      sidebarWidth: 280,
      setupCompleted: false,
      thinkingLevel: CLI_DEFAULT as ThinkingLevel,
      contextWindowMode: 'default',
      autoCompactThresholdTokens: null,
      cliUpdateAvailable: false,
      cliLatestVersion: '',
      aiAvatarUrl: '',
      userAvatarUrl: '',
      userDisplayName: '',
      showHiddenFiles: false,
      ctrlEnterToSend: false,
      minimizeOnClose: true,
      enableMcp: false,
      promptSuggestions: true,
      followCli: true,
      lastCliModel: '',
      ctrlClickOpenExternally: false,
      showImageThumbnails: false,
      skillDirectories: [],
      customBgImage: '',
      glassBlur: 8,
      glassOpacity: 85,

      toggleTheme: () =>
        set((state) => ({ theme: nextTheme(state.theme) })),

      setTheme: (theme) => set(() => ({ theme })),

      setLightSkin: (lightSkin) => set(() => ({ lightSkin })),

      setDarkSkin: (darkSkin) => set(() => ({ darkSkin })),

      toggleSidebar: () =>
        set((state) => ({ sidebarOpen: !state.sidebarOpen })),

      toggleSecondaryPanel: () =>
        set((state) => ({
          secondaryPanelOpen: !state.secondaryPanelOpen,
        })),

      toggleAgentPanel: () =>
        set((state) => ({ agentPanelOpen: !state.agentPanelOpen })),

      setSecondaryTab: (tab) =>
        set(() => ({
          secondaryPanelTab: tab,
          secondaryPanelOpen: true,
        })),

      setSecondaryPanelWidth: (width) =>
        set(() => ({ secondaryPanelWidth: width })),

      toggleSettings: () =>
        set((state) => ({
          settingsOpen: !state.settingsOpen,
        })),

      setWorkingDirectory: (dir) =>
        set(() => ({ workingDirectory: dir })),

      setActiveEnv: (env) =>
        set((state) => (state.activeEnv === env ? {} : { activeEnv: env, workingDirectory: '' })),

      setSelectedModel: (model) =>
        set(() => ({ selectedModel: model })),

      setSessionMode: (mode) =>
        set(() => ({ sessionMode: mode })),

      setLocale: (locale) =>
        set(() => ({ locale })),

      toggleLocale: () =>
        set((state) => ({ locale: state.locale === 'zh' ? 'en' : 'zh' })),

      setFontSize: (size) =>
        set(() => ({ fontSize: Math.max(10, Math.min(36, size)) })),

      setFontFamily: (fontFamily) =>
        set(() => ({ fontFamily })),

      setMonoFontFollowsInterface: (monoFontFollowsInterface) =>
        set(() => ({ monoFontFollowsInterface })),

      increaseFontSize: () =>
        set((state) => ({ fontSize: Math.min(36, state.fontSize + 1) })),

      decreaseFontSize: () =>
        set((state) => ({ fontSize: Math.max(10, state.fontSize - 1) })),

      setSidebarWidth: (width) =>
        set(() => ({ sidebarWidth: Math.max(180, Math.min(450, width)) })),

      setSetupCompleted: (completed) =>
        set(() => ({ setupCompleted: completed })),

      setThinkingLevel: (level) =>
        set(() => ({ thinkingLevel: level })),

      setContextWindowMode: (contextWindowMode) =>
        set(() => ({ contextWindowMode })),

      setAutoCompactThresholdTokens: (autoCompactThresholdTokens) =>
        set(() => ({
          autoCompactThresholdTokens:
            autoCompactThresholdTokens === null ? null : clampAutoCompactThreshold(autoCompactThresholdTokens),
        })),

      setAiAvatarUrl: (url) =>
        set(() => ({ aiAvatarUrl: url })),

      setUserAvatarUrl: (url) =>
        set(() => ({ userAvatarUrl: url })),

      setUserDisplayName: (name) =>
        set(() => ({ userDisplayName: name.slice(0, 20) })),
      setCustomBgImage: (image) => set(() => ({ customBgImage: image })),
      setGlassBlur: (blur) => set(() => ({ glassBlur: Math.max(0, Math.min(20, blur)) })),
      setGlassOpacity: (opacity) => set(() => ({ glassOpacity: Math.max(30, Math.min(100, opacity)) })),
      clearCustomBg: () => set(() => ({ customBgImage: '', glassBlur: 8, glassOpacity: 85 })),
      toggleHiddenFiles: () =>
        set((state) => ({ showHiddenFiles: !state.showHiddenFiles })),
      toggleCtrlEnterToSend: () =>
        set((state) => ({ ctrlEnterToSend: !state.ctrlEnterToSend })),

      toggleMinimizeOnClose: () =>
        set((state) => ({ minimizeOnClose: !state.minimizeOnClose })),

      toggleEnableMcp: () =>
        set((state) => ({ enableMcp: !state.enableMcp })),

      togglePromptSuggestions: () =>
        set((state) => ({ promptSuggestions: !state.promptSuggestions })),

      setLastCliModel: (model) => set(() => ({ lastCliModel: model })),
      toggleFollowCli: () =>
        set((state) => ({ followCli: !state.followCli })),

      toggleUsage: (tab) => set((state) => ({
        usageOpen: !state.usageOpen,
        usageModalTab: !state.usageOpen && tab ? tab : state.usageModalTab,
      })),
      setUsageModalTab: (tab) => set({ usageModalTab: tab }),

      setCustomModelPrice: (model, price) =>
        set((state) => {
          const next = { ...state.customModelPrices };
          if (price) next[model] = price;
          else delete next[model];
          return { customModelPrices: next };
        }),
      toggleCtrlClickOpenExternally: () =>
        set((state) => ({ ctrlClickOpenExternally: !state.ctrlClickOpenExternally })),
      toggleShowImageThumbnails: () =>
        set((state) => ({ showImageThumbnails: !state.showImageThumbnails })),
      addSkillDirectory: (path) =>
        set((state) => {
          const normalized = path.trim().replace(/[\\/]+$/, '');
          if (!normalized || state.skillDirectories.includes(normalized)) return state;
          return { skillDirectories: [...state.skillDirectories, normalized] };
        }),
      removeSkillDirectory: (path) =>
        set((state) => ({ skillDirectories: state.skillDirectories.filter((item) => item !== path) })),
    }),
    {
      name: 'tokenicode-settings',
      storage: createJSONStorage(() => safeLocalStorage),
      version: 22,
      migrate: (persistedState: unknown, version: number) => {
        const persisted = persistedState as Record<string, unknown>;
        if (version === 0) {
          // Migrate legacy model IDs to current ones
          const legacyMap: Record<string, ModelId> = {
            'claude-opus-4-0': 'claude-opus-4-6',
            'claude-sonnet-4-0': 'claude-sonnet-4-6',
            'claude-haiku-3-5': 'claude-haiku-4-5-20251001',
          };
          const old = persisted.selectedModel as string;
          if (old && legacyMap[old]) {
            persisted.selectedModel = legacyMap[old];
          }
        }
        if (version < 2) {
          persisted.updateAvailable = false;
          persisted.updateVersion = '';
        }
        if (version < 3) {
          persisted.apiProviderMode = 'inherit';
          persisted.customProviderName = '';
          persisted.customProviderBaseUrl = '';
          persisted.customProviderModelMappings = [];
          persisted.customProviderApiFormat = 'anthropic';
        }
        if (version < 4) {
          // Migrate boolean thinkingEnabled → ThinkingLevel
          const oldThinking = persisted.thinkingEnabled;
          persisted.thinkingLevel = oldThinking === false ? 'off' : 'high';
          delete persisted.thinkingEnabled;
        }
        if (version < 5) {
          // Force default mode to bypass — old versions may have persisted 'code'/'ask'
          persisted.sessionMode = 'bypass';
        }
        if (version < 6) {
          // Fix Haiku model ID: claude-haiku-4-5 → claude-haiku-4-5-20251001
          if (persisted.selectedModel === 'claude-haiku-4-5') {
            persisted.selectedModel = 'claude-haiku-4-5-20251001';
          }
        }
        if (version < 7) {
          const migratedModel = migrateModelSelection(persisted.selectedModel);
          if (migratedModel) {
            persisted.selectedModel = migratedModel;
          }
        }
        if (version < 8) {
          persisted.backgroundTheme = 'garden';
        }
        if (version < 9) {
          persisted.monoFontFollowsInterface = true;
        }
        if (version < 10) {
          persisted.contextWindowMode = 'default';
        }
        if (version < 11) {
          const mode = persisted.contextWindowMode === 'large1m' ? 'large1m' : 'default';
          persisted.autoCompactThresholdTokens = defaultAutoCompactThreshold(mode);
        }
        if (version < 12) {
          persisted.customBgImage = '';
          persisted.customBgSize = 'cover';
          persisted.customBgPositionX = 50;
          persisted.customBgPositionY = 50;
          persisted.glassBlur = 8;
          persisted.glassOpacity = 85;
        }
        if (version < 13) {
          persisted.ctrlEnterToSend = false;
        }
        if (version < 14) {
          persisted.ctrlClickOpenExternally = false;
          persisted.showImageThumbnails = false;
        }
        if (version < 15) {
          persisted.skillDirectories = [];
        }
        if (version < 16) {
          // 旧版本的阈值固定为 160K / 800K（随模式的默认值），改为“按模型自动”；用户自定义的值保留
          const old = persisted.autoCompactThresholdTokens;
          if (old === 160_000 || old === 800_000) persisted.autoCompactThresholdTokens = null;
        }
        if (version < 17) {
          // 新增“跟随 CLI 配置”，默认开启；模型与思考档位改为跟随 CLI 自己的设置
          persisted.followCli = true;
          persisted.selectedModel = CLI_DEFAULT;
          persisted.thinkingLevel = CLI_DEFAULT;
        }
        if (version < 18) {
          // 主题色、背景风格合并为浅色 / 深色两套主题方案
          migrateLegacySkin(persisted);
        }
        if (version < 19) {
          // 背景图去掉尺寸与位置调节（固定铺满、居中）
          delete persisted.customBgSize;
          delete persisted.customBgPositionX;
          delete persisted.customBgPositionY;
        }
        if (version < 20) {
          persisted.lastCliModel = '';
        }
        if (version < 21) {
          // 应用更新状态移到不持久化的 updateStore
          delete persisted.updateAvailable;
          delete persisted.updateVersion;
        }
        if (version < 22) {
          // 新增提示建议，默认开启
          persisted.promptSuggestions = true;
        }
        return persisted;
      },
      partialize: (state) => ({
        theme: state.theme,
        lightSkin: state.lightSkin,
        darkSkin: state.darkSkin,
        sidebarOpen: state.sidebarOpen,
        secondaryPanelWidth: state.secondaryPanelWidth,
        workingDirectory: state.workingDirectory,
        activeEnv: state.activeEnv,
        selectedModel: state.selectedModel,
        sessionMode: state.sessionMode,
        locale: state.locale,
        fontSize: state.fontSize,
        fontFamily: state.fontFamily,
        monoFontFollowsInterface: state.monoFontFollowsInterface,
        sidebarWidth: state.sidebarWidth,
        setupCompleted: state.setupCompleted,
        thinkingLevel: state.thinkingLevel,
        contextWindowMode: state.contextWindowMode,
        autoCompactThresholdTokens: state.autoCompactThresholdTokens,
        aiAvatarUrl: state.aiAvatarUrl,
        userAvatarUrl: state.userAvatarUrl,
        userDisplayName: state.userDisplayName,
        showHiddenFiles: state.showHiddenFiles,
        ctrlEnterToSend: state.ctrlEnterToSend,
        minimizeOnClose: state.minimizeOnClose,
        enableMcp: state.enableMcp,
        promptSuggestions: state.promptSuggestions,
        followCli: state.followCli,
        lastCliModel: state.lastCliModel,
        customModelPrices: state.customModelPrices,
        ctrlClickOpenExternally: state.ctrlClickOpenExternally,
        showImageThumbnails: state.showImageThumbnails,
        skillDirectories: state.skillDirectories,
        customBgImage: state.customBgImage,
        glassBlur: state.glassBlur,
        glassOpacity: state.glassOpacity,
      }),
    },
  ),
);

// --- Per-session effective value helpers (Phase 4) ---
// These read the snapshotted value from SessionMeta, falling back to the global store.
// Import SessionMeta lazily to avoid circular dependency.

/** Get the effective session mode for a given session's meta snapshot */
export function getEffectiveMode(meta: { snapshotMode?: SessionMode } | undefined): SessionMode {
  return meta?.snapshotMode ?? useSettingsStore.getState().sessionMode;
}

/** Get the effective model for a given session's meta snapshot */
export function getEffectiveModel(meta: { snapshotModel?: string } | undefined): string {
  return meta?.snapshotModel ?? useSettingsStore.getState().selectedModel;
}

/** Get the effective thinking level for a given session's meta snapshot */
export function getEffectiveThinking(meta: { snapshotThinking?: ThinkingLevel } | undefined): ThinkingLevel {
  return meta?.snapshotThinking ?? useSettingsStore.getState().thinkingLevel;
}

export function isLargeContextMode(model?: string, mode?: ContextWindowMode): boolean {
  if (mode === 'large1m') return true;
  const lower = (model || '').toLowerCase();
  // 官方 API 下默认即 1M 上下文、无需 [1m] 后缀的模型：Fable 5.x、Sonnet 5、Opus 4.7 及之后
  if (/^claude-(fable-5|sonnet-5|opus-5|opus-4-[78])/.test(lower)) return true;
  // DeepSeek V4 Pro / Flash 官方文档标注 1,000,000 token 上下文
  if (lower.replace(/[\s_.()[\]-]/g, '').includes('deepseekv4')) return true;
  return lower.includes('1m') || lower.includes('[1m]');
}

export function getContextWindowForModel(model?: string, mode?: ContextWindowMode): number {
  return isLargeContextMode(model, mode) ? 1_000_000 : 200_000;
}

/** 自动 compact 阈值：用户自定义值优先；否则取所选模型上下文窗口的 80%（200K -> 160K，1M -> 800K） */
export function getAutoCompactThreshold(model?: string, mode?: ContextWindowMode, overrideTokens?: number | null): number {
  if (typeof overrideTokens === 'number') {
    return clampAutoCompactThreshold(overrideTokens);
  }
  return Math.round(getContextWindowForModel(model, mode) * 0.8);
}

// --- 运行时切换模式 ---
// 实际发送 set_permission_mode 的订阅在 chatStore.ts（避免循环依赖），这里只管「跳过一次」标记。

let _skipNextModeSync = false;

/** Update frontend sessionMode WITHOUT sending set_permission_mode to CLI.
 *  Use when CLI already switched modes internally (e.g. after ExitPlanMode allow). */
export function setSessionModeLocal(mode: SessionMode): void {
  _skipNextModeSync = true;
  useSettingsStore.getState().setSessionMode(mode);
}

/** 批准计划时要让 CLI 切到的权限模式：前端处于 plan 模式时，批准后切到 code（acceptEdits）。
 *  ExitPlanMode 获批后 CLI 只会回到启动前的模式，所以要随权限响应显式指定，否则写文件仍会请求授权。 */
export function planApprovalCliMode(): string | undefined {
  return useSettingsStore.getState().sessionMode === 'plan'
    ? mapSessionModeToPermissionMode('code')
    : undefined;
}

/** 读取并清除「跳过下一次模式同步」标记，供 chatStore 里的模式同步订阅使用 */
export function takeSkipModeSync(): boolean {
  const skip = _skipNextModeSync;
  _skipNextModeSync = false;
  return skip;
}
