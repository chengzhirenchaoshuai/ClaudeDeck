import { useRef, useCallback, useEffect, useState, type ChangeEvent } from 'react';
import {
  useSettingsStore,
  FontFamily,
} from '../../stores/settingsStore';
import { useT } from '../../lib/i18n';
import { SKINS, skinForMode, type SkinDef, type SkinMode } from '../../lib/themes';
import { compressBackground } from '../../lib/custom-bg';
import { AiAvatar } from '../shared/AiAvatar';
import { UserAvatar } from '../shared/UserAvatar';
import { AvatarCropModal } from './AvatarCropModal';

const FONT_FAMILY_OPTIONS: { id: FontFamily; label: string; sample: string }[] = [
  { id: 'microsoft', label: '微软雅黑 UI', sample: '中文 Aa 123' },
  { id: 'system', label: '系统清晰字体', sample: '中文 Aa 123' },
  { id: 'sourceHan', label: '思源黑体 / Noto', sample: '中文 Aa 123' },
  { id: 'lxgw', label: '霞鹜文楷', sample: '中文 Aa 123' },
  { id: 'mono', label: '等宽字体', sample: '中文 Aa 123' },
];

/** 系统当前是否为深色，随系统设置变化 */
function useSystemDark() {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return dark;
}

/* 主题缩略图：用方案自己的颜色画一个简化的聊天界面 */
function SkinPreview({ skin }: { skin: SkinDef }) {
  const { bg, sidebar, accent, text, background } = skin.preview;
  return (
    <div className="w-full aspect-[5/3] rounded-lg overflow-hidden flex border"
      style={{ background: background ?? bg, borderColor: `color-mix(in srgb, ${text} 14%, transparent)` }}>
      {/* 侧栏 */}
      <div className="w-[24%] p-1.5 flex flex-col gap-1"
        style={{ background: sidebar, opacity: background ? 0.85 : 1 }}>
        <div className="w-full h-1.5 rounded-full" style={{ background: text, opacity: 0.25 }} />
        <div className="w-[80%] h-1.5 rounded-full" style={{ background: accent, opacity: 0.6 }} />
        <div className="w-[60%] h-1.5 rounded-full" style={{ background: text, opacity: 0.15 }} />
      </div>
      {/* 消息区 */}
      <div className="flex-1 flex flex-col p-2 gap-1.5">
        <div className="flex-1 flex flex-col gap-1 justify-center">
          <div className="w-[70%] h-1.5 rounded-full" style={{ background: text, opacity: 0.45 }} />
          <div className="w-[50%] h-1.5 rounded-full" style={{ background: text, opacity: 0.3 }} />
          <div className="w-[45%] h-2.5 rounded self-end" style={{ background: accent }} />
        </div>
        <div className="h-2.5 rounded border"
          style={{ background: bg, borderColor: `color-mix(in srgb, ${text} 20%, transparent)` }} />
      </div>
    </div>
  );
}

/** 界面：头像、主题、背景、语言、字体等外观类设置 */
export function InterfaceTab() {
  const t = useT();
  const theme = useSettingsStore((s) => s.theme);
  const lightSkin = useSettingsStore((s) => s.lightSkin);
  const darkSkin = useSettingsStore((s) => s.darkSkin);
  const locale = useSettingsStore((s) => s.locale);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const monoFontFollowsInterface = useSettingsStore((s) => s.monoFontFollowsInterface);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setLightSkin = useSettingsStore((s) => s.setLightSkin);
  const setDarkSkin = useSettingsStore((s) => s.setDarkSkin);
  const setLocale = useSettingsStore((s) => s.setLocale);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const setFontFamily = useSettingsStore((s) => s.setFontFamily);
  const setMonoFontFollowsInterface = useSettingsStore((s) => s.setMonoFontFollowsInterface);
  const showImageThumbnails = useSettingsStore((s) => s.showImageThumbnails);
  const toggleShowImageThumbnails = useSettingsStore((s) => s.toggleShowImageThumbnails);
  const aiAvatarUrl = useSettingsStore((s) => s.aiAvatarUrl);
  const setAiAvatarUrl = useSettingsStore((s) => s.setAiAvatarUrl);
  const userAvatarUrl = useSettingsStore((s) => s.userAvatarUrl);
  const setUserAvatarUrl = useSettingsStore((s) => s.setUserAvatarUrl);
  const userDisplayName = useSettingsStore((s) => s.userDisplayName);
  const setUserDisplayName = useSettingsStore((s) => s.setUserDisplayName);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const userFileInputRef = useRef<HTMLInputElement>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [cropTarget, setCropTarget] = useState<'ai' | 'user'>('ai');
  const systemDark = useSystemDark();
  const activeMode: SkinMode = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
  const activeSkinId = skinForMode(activeMode === 'dark' ? darkSkin : lightSkin, activeMode).id;

  // 选中某个方案：记到对应深浅，并把外观切到该方案的深浅，让点击立即生效
  const pickSkin = useCallback((skin: SkinDef) => {
    if (skin.mode === 'dark') setDarkSkin(skin.id);
    else setLightSkin(skin.id);
    setTheme(skin.mode);
  }, [setDarkSkin, setLightSkin, setTheme]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>, target: 'ai' | 'user') => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCropTarget(target);
    setCropFile(file);
    e.target.value = '';
  }, []);

  return (
    <div className="space-y-6">
      {/* Avatars — AI & User side by side */}
      <div>
        <h3 className="text-[13px] font-medium text-text-primary mb-3">{t('settings.aiAvatar')} / {t('settings.userAvatar')}</h3>
        <div className="flex items-start gap-6">
          {/* AI Avatar */}
          <div className="flex flex-col items-center gap-1.5">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="group relative cursor-pointer"
              title={t('settings.aiAvatarChange')}
            >
              <AiAvatar size="w-14 h-14" rounded="rounded-2xl" />
              <div className="absolute inset-0 rounded-2xl bg-black/40 opacity-0 group-hover:opacity-100
                transition-smooth flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M12 9v4H4V9M8 3v7M5 6l3-3 3 3" />
                </svg>
              </div>
            </button>
            <span className="text-[11px] text-text-tertiary">AI</span>
            {aiAvatarUrl && (
              <button
                onClick={() => setAiAvatarUrl('')}
                className="text-[11px] text-text-muted hover:text-red-500 transition-smooth"
              >
                {t('settings.aiAvatarReset')}
              </button>
            )}
          </div>

          {/* User Avatar + Name */}
          <div className="flex flex-col items-center gap-1.5">
            <button
              onClick={() => userFileInputRef.current?.click()}
              className="group relative cursor-pointer"
              title={t('settings.userAvatarChange')}
            >
              <UserAvatar size="w-14 h-14" rounded="rounded-2xl" />
              <div className="absolute inset-0 rounded-2xl bg-black/40 opacity-0 group-hover:opacity-100
                transition-smooth flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M12 9v4H4V9M8 3v7M5 6l3-3 3 3" />
                </svg>
              </div>
            </button>
            <input
              type="text"
              value={userDisplayName}
              onChange={(e) => setUserDisplayName(e.target.value)}
              placeholder={t('settings.userNamePlaceholder')}
              className="w-24 px-2 py-1 rounded-lg text-[11px] text-center bg-bg-secondary border border-border-subtle
                text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent/50 transition-smooth"
              maxLength={20}
            />
            {userAvatarUrl && (
              <button
                onClick={() => setUserAvatarUrl('')}
                className="text-[11px] text-text-muted hover:text-red-500 transition-smooth"
              >
                {t('settings.userAvatarReset')}
              </button>
            )}
          </div>

          <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => handleFileSelect(e, 'ai')} />
          <input ref={userFileInputRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => handleFileSelect(e, 'user')} />
        </div>
      </div>

      {/* Avatar crop modal */}
      {cropFile && (
        <AvatarCropModal
          imageFile={cropFile}
          onSave={(dataUrl) => {
            if (cropTarget === 'ai') setAiAvatarUrl(dataUrl);
            else setUserAvatarUrl(dataUrl);
            setCropFile(null);
          }}
          onCancel={() => setCropFile(null)}
        />
      )}

      {/* 浅色 / 深色主题方案 */}
      {(['light', 'dark'] as const).map((mode) => {
        return (
          <div key={mode}>
            <h3 className="text-[13px] font-medium text-text-primary mb-3">
              {t(mode === 'dark' ? 'settings.darkSkin' : 'settings.lightSkin')}
            </h3>
            <div className="grid grid-cols-4 gap-3 max-w-[680px]">
              {SKINS.filter((skin) => skin.mode === mode).map((skin) => (
                <button
                  key={skin.id}
                  onClick={() => pickSkin(skin)}
                  title={t(`skin.${skin.id}`)}
                  className={`group relative rounded-xl p-2 transition-smooth text-left
                    ${activeSkinId === skin.id
                      ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg-card bg-accent/[0.03]'
                      : 'hover:scale-[1.02] border border-border-subtle hover:border-black/10 dark:hover:border-white/10'
                    }`}
                >
                  <SkinPreview skin={skin} />
                  <div className="mt-2 text-center text-[12px] font-medium text-text-muted truncate">
                    {t(`skin.${skin.id}`)}
                  </div>
                  {activeSkinId === skin.id && (
                    <span className="absolute top-1 right-1 px-1.5 py-px rounded-md text-[10px] font-medium
                      bg-accent text-text-inverse">
                      {t('settings.skinInUse')}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        );
      })}

      {/* Custom Background Image */}
      <div>
        <h3 className="text-[13px] font-medium text-text-primary mb-3">{t('settings.customBg')}</h3>
        <CustomBackgroundSection />
      </div>

      {/* Settings row */}
      <div className="flex items-start gap-8 flex-wrap">
        {/* Language */}
        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.language')}</h3>
          <div className="inline-flex rounded-lg border border-border-subtle overflow-hidden">
            {(['zh', 'en'] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLocale(l)}
                className={`py-1.5 px-3 text-[13px] font-medium transition-smooth
                  border-r border-border-subtle last:border-r-0
                  ${locale === l
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-muted hover:bg-bg-secondary'
                  }`}
              >
                {l === 'zh' ? '中文' : 'EN'}
              </button>
            ))}
          </div>
        </div>

        {/* Font Size */}
        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.fontSize')}</h3>
          <div className="inline-flex items-center rounded-lg border border-border-subtle
            overflow-hidden">
            <button
              onClick={() => setFontSize(fontSize - 1)}
              disabled={fontSize <= 10}
              className="w-8 h-8 text-[13px] font-bold text-text-primary
                hover:bg-bg-secondary transition-smooth
                disabled:opacity-30 disabled:cursor-not-allowed
                flex items-center justify-center border-r border-border-subtle"
            >-</button>
            <span className="w-12 text-center text-[13px] font-semibold text-text-primary">
              {fontSize}px
            </span>
            <button
              onClick={() => setFontSize(fontSize + 1)}
              disabled={fontSize >= 36}
              className="w-8 h-8 text-[13px] font-bold text-text-primary
                hover:bg-bg-secondary transition-smooth
                disabled:opacity-30 disabled:cursor-not-allowed
                flex items-center justify-center border-l border-border-subtle"
            >+</button>
          </div>
        </div>

        {/* Font Family */}
        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.fontFamily')}</h3>
          <select
            value={fontFamily}
            onChange={(e) => setFontFamily(e.target.value as FontFamily)}
            className="h-8 min-w-40 px-2 rounded-lg bg-bg-secondary border border-border-subtle
              text-[13px] text-text-primary outline-none focus:border-accent/60"
          >
            {FONT_FAMILY_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label} · {option.sample}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-text-tertiary">
            {t('settings.fontFamilyHint')}
          </p>
          <button
            onClick={() => setMonoFontFollowsInterface(!monoFontFollowsInterface)}
            className="mt-2 inline-flex items-center gap-2 text-[12px] text-text-secondary
              hover:text-text-primary transition-smooth"
          >
            <span className={`relative w-8 h-4 rounded-full transition-smooth border
              ${monoFontFollowsInterface ? 'bg-accent/80 border-accent/30' : 'bg-bg-tertiary border-border-subtle'}`}
            >
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-all
                ${monoFontFollowsInterface ? 'right-0.5' : 'left-0.5'}`}
              />
            </span>
            {t('settings.monoFontFollowsInterface')}
          </button>
        </div>

        {/* Show image thumbnails */}
        <div>
          <button
            onClick={toggleShowImageThumbnails}
            className="inline-flex items-center gap-2 text-[12px] text-text-secondary
              hover:text-text-primary transition-smooth"
          >
            <span className={`relative w-8 h-4 rounded-full transition-smooth border
              ${showImageThumbnails ? 'bg-accent/80 border-accent/30' : 'bg-bg-tertiary border-border-subtle'}`}
            >
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-all
                ${showImageThumbnails ? 'right-0.5' : 'left-0.5'}`}
              />
            </span>
            {t('settings.showImageThumbnails')}
          </button>
          <p className="mt-1 text-[11px] text-text-tertiary leading-relaxed">
            {t('settings.showImageThumbnailsHint')}
          </p>
        </div>
      </div>
    </div>
  );
}

/* ─── 自定义背景 ─── */
function CustomBackgroundSection() {
  const t = useT();
  const customBgImage = useSettingsStore((s) => s.customBgImage);
  const glassBlur = useSettingsStore((s) => s.glassBlur);
  const glassOpacity = useSettingsStore((s) => s.glassOpacity);
  const setCustomBgImage = useSettingsStore((s) => s.setCustomBgImage);
  const setGlassBlur = useSettingsStore((s) => s.setGlassBlur);
  const setGlassOpacity = useSettingsStore((s) => s.setGlassOpacity);
  const clearCustomBg = useSettingsStore((s) => s.clearCustomBg);
  const bgInputRef = useRef<HTMLInputElement>(null);

  const handleBgUpload = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    compressBackground(file).then(setCustomBgImage).catch((err) => {
      console.error('[settings] 背景图处理失败：', err);
    });
  }, [setCustomBgImage]);

  return (
    <div className="flex items-start gap-4">
      {/* 缩略图：点击上传 / 更换，右上角 × 移除 */}
      <div className="relative shrink-0">
        <button
          onClick={() => bgInputRef.current?.click()}
          title={customBgImage ? t('settings.customBgReplace') : t('settings.customBgUpload')}
          className={`group relative w-36 h-24 rounded-xl overflow-hidden transition-smooth
            flex flex-col items-center justify-center gap-1.5
            ${customBgImage
              ? 'border border-border-subtle'
              : 'border-2 border-dashed border-border-subtle hover:border-accent/40 hover:bg-bg-secondary'
            }`}
        >
          {customBgImage ? (
            <>
              <img src={customBgImage} alt="" className="w-full h-full object-cover" />
              <span className="absolute inset-0 flex items-center justify-center bg-black/30
                text-white text-xs font-medium opacity-0 group-hover:opacity-100 transition-smooth">
                {t('settings.customBgReplace')}
              </span>
            </>
          ) : (
            <>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
                className="text-text-tertiary">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />
              </svg>
              <span className="text-xs text-text-muted">{t('settings.customBgUpload')}</span>
            </>
          )}
        </button>
        {customBgImage && (
          <button
            onClick={clearCustomBg}
            title={t('settings.customBgRemove')}
            className="absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center
              bg-bg-card border border-border-subtle text-text-muted shadow-sm
              hover:text-error hover:border-error/40 transition-smooth"
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        )}
        <input ref={bgInputRef} type="file" accept="image/*" className="hidden"
          onChange={handleBgUpload} />
      </div>

      <div className="flex-1 min-w-0 max-w-[320px] pt-1">
        {customBgImage ? (
          <div className="space-y-3">
            <Slider label={t('settings.glassOpacity')} value={glassOpacity}
              onChange={setGlassOpacity} min={30} max={100} unit="%"
              hint={t('settings.glassOpacityHint')} />
            <Slider label={t('settings.glassBlur')} value={glassBlur}
              onChange={setGlassBlur} min={0} max={20} unit="px" />
          </div>
        ) : (
          <p className="text-xs text-text-tertiary leading-relaxed">{t('settings.customBgHint')}</p>
        )}
      </div>
    </div>
  );
}

function Slider({
  label, value, onChange, min = 0, max = 100, unit = '', left, right, hint,
}: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; unit?: string; left?: string; right?: string; hint?: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-text-tertiary">{label}</span>
        <span className="text-xs font-mono text-text-secondary">{value}{unit}</span>
      </div>
      <div className="flex items-center gap-2">
        {left && <span className="text-[11px] text-text-tertiary shrink-0">{left}</span>}
        <input type="range" min={min} max={max} value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1 h-1.5 rounded-full appearance-none bg-bg-tertiary cursor-pointer"
          style={{ accentColor: 'var(--color-accent)' }} />
        {right && <span className="text-[11px] text-text-tertiary shrink-0">{right}</span>}
      </div>
      {hint && <p className="mt-1 text-[11px] text-text-tertiary">{hint}</p>}
    </div>
  );
}
