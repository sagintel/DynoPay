import Svg, { Circle, Path, Rect } from 'react-native-svg';
import type { IconName } from '@/genui/types';
import { useI18n } from '@/i18n/context';
import { colors } from '@/theme/tokens';

/** One stroke-icon set (24px grid, 1.8 stroke) shared by everything the agent can render. */
const PATHS: Record<IconName, (c: string) => React.ReactNode> = {
  send: () => <Path d="M7 17 17 7M9 7h8v8" />,
  plus: () => <Path d="M12 5v14M5 12h14" />,
  split: () => (
    <>
      <Circle cx="8" cy="9" r="3" />
      <Circle cx="16.5" cy="9" r="2.5" />
      <Path d="M3 19c.6-2.8 2.6-4.5 5-4.5s4.4 1.7 5 4.5M14 14.6c2.6-.6 5.3.9 6 4.4" />
    </>
  ),
  card: () => (
    <>
      <Rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <Path d="M3 10h18M7 15h4" />
    </>
  ),
  chart: () => <Path d="M4 19V5M4 19h16M8 15l3.5-4 3 2.5L20 7" />,
  'arrow-up': () => <Path d="M12 19V5M6 11l6-6 6 6" />,
  'arrow-down': () => <Path d="M12 5v14M6 13l6 6 6-6" />,
  'arrow-right': () => <Path d="M5 12h14M13 6l6 6-6 6" />,
  'arrow-left': () => <Path d="M19 12H5M11 6l-6 6 6 6" />,
  lock: () => (
    <>
      <Rect x="5" y="10.5" width="14" height="10" rx="2.5" />
      <Path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </>
  ),
  unlock: () => (
    <>
      <Rect x="5" y="10.5" width="14" height="10" rx="2.5" />
      <Path d="M8 10.5V8a4 4 0 0 1 7.6-1.7" />
    </>
  ),
  trash: () => <Path d="M4 7h16M10 11v6M14 11v6M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M9 7V4.5h6V7" />,
  edit: () => <Path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4" />,
  check: () => <Path d="m5 12.5 4.5 4.5L19 7.5" />,
  close: () => <Path d="M6 6l12 12M18 6 6 18" />,
  user: () => (
    <>
      <Circle cx="12" cy="8.5" r="3.8" />
      <Path d="M4.5 20c1-3.6 4-5.6 7.5-5.6s6.5 2 7.5 5.6" />
    </>
  ),
  users: () => (
    <>
      <Circle cx="9" cy="8.5" r="3.4" />
      <Path d="M2.8 19.5c.8-3.2 3.4-5 6.2-5s5.4 1.8 6.2 5M15.5 5.3a3.4 3.4 0 0 1 0 6.4M17.5 14.7c1.8.6 3.2 2.2 3.7 4.8" />
    </>
  ),
  calendar: () => (
    <>
      <Rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <Path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  repeat: () => <Path d="M17 3l3 3-3 3M4 11V9.5A3.5 3.5 0 0 1 7.5 6H20M7 21l-3-3 3-3M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H4" />,
  wallet: () => (
    <>
      <Path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3M4 7.5v10A2.5 2.5 0 0 0 6.5 20H20v-12H6.5A2.5 2.5 0 0 1 4 7.5z" />
      <Circle cx="16" cy="14" r="1.2" />
    </>
  ),
  paypal: () => <Path d="M8 20l2.2-14h5.3c2.6 0 4 1.7 3.5 4-.6 2.8-2.7 4-5.3 4h-2.4L10.4 20H8zM5 17l2-13" />,
  shield: () => <Path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6L12 3zM9 12l2 2 4-4" />,
  info: () => (
    <>
      <Circle cx="12" cy="12" r="9" />
      <Path d="M12 11v5.5M12 7.6v.2" />
    </>
  ),
  warning: () => <Path d="M12 4 2.8 19.5h18.4L12 4zM12 10v4.5M12 17.2v.2" />,
  search: () => (
    <>
      <Circle cx="11" cy="11" r="6.5" />
      <Path d="m20 20-4.2-4.2" />
    </>
  ),
  settings: () => (
    <>
      <Circle cx="12" cy="12" r="3" />
      <Path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3" />
    </>
  ),
  star: () => <Path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8L12 3.5z" />,
  sparkle: () => <Path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z" />,
  receipt: () => <Path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6M9 16h3" />,
  bolt: () => <Path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3z" />,
  mic: () => (
    <>
      <Rect x="9" y="3" width="6" height="11" rx="3" />
      <Path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </>
  ),
  'chevron-right': () => <Path d="m9 5 7 7-7 7" />,
  logout: () => <Path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15M10 16l-4-4 4-4M6 12h10" />,
};

/** Directional icons, mirrored for right-to-left languages. */
const DIRECTIONAL = new Set<IconName>(['arrow-right', 'arrow-left', 'chevron-right', 'send', 'logout']);

export function Icon({ name, size = 18, color = colors.text, strokeWidth = 1.8 }: { name: IconName; size?: number; color?: string; strokeWidth?: number }) {
  const { rtl } = useI18n();
  const draw = PATHS[name] ?? PATHS.info;
  return (
    <Svg style={rtl && DIRECTIONAL.has(name) ? { transform: [{ scaleX: -1 }] } : undefined} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {draw(color)}
    </Svg>
  );
}
