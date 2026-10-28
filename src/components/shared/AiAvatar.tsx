import { useSettingsStore } from '../../stores/settingsStore';

/** Default </> icon SVG — always uses 171×171 viewBox, scaled by parent container */
function DefaultIcon() {
  // 图形本身占 viewBox 约 3/4，再缩到容器的 72%，四周留白，避免铺满显得拥挤
  return (
    <svg width="72%" height="72%" viewBox="0 0 171 171" fill="none">
      <path d="M66.79 58.73L40.33 85.19L66.79 111.66L57.53 120.92L21.8 85.19L57.53 49.47Z" className="fill-white dark:fill-black" />
      <path d="M111.5 49.47L147.22 85.19L111.5 120.92L102.24 111.66L128.7 85.19L102.24 58.73Z" className="fill-white dark:fill-black" />
      <path d="M90.01 39.92L102.01 39.92L79.24 129.92L67.24 129.92L79.24 81.92Z" fill="var(--color-icon-slash)" />
    </svg>
  );
}

interface AiAvatarProps {
  /** Tailwind size class for the container, e.g. "w-8 h-8", "w-16 h-16", "w-20 h-20" */
  size: string;
  /** Tailwind border-radius class, e.g. "rounded-[10px]", "rounded-2xl", "rounded-3xl" */
  rounded?: string;
  /** Extra classes for the container */
  className?: string;
}

/**
 * AI avatar that shows a user-customized image if set, otherwise the default </> icon.
 * The custom image is stored as a data URL in settingsStore.aiAvatarUrl.
 */
export function AiAvatar({ size, rounded = 'rounded-[10px]', className = '' }: AiAvatarProps) {
  const avatarUrl = useSettingsStore((s) => s.aiAvatarUrl);

  // When custom image is set, use transparent bg to avoid black border bleed on rounded corners
  const bgClass = avatarUrl ? 'bg-transparent' : 'bg-black dark:bg-white';

  return (
    <div className={`${size} ${rounded} ${bgClass}
      flex items-center justify-center flex-shrink-0 shadow-md overflow-hidden ${className}`}>
      {avatarUrl ? (
        <img src={avatarUrl} alt="AI" className="w-full h-full object-cover" />
      ) : (
        <DefaultIcon />
      )}
    </div>
  );
}
