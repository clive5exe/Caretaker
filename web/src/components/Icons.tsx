/** Line icons, drawn in currentColor so a tile or a nav row colors them. */
import type { ReactNode } from "react";

const S = ({ children, size = 17, w = 1.8 }: { children: ReactNode; size?: number; w?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const ICONS = {
  inbox: () => (<S><path d="M3 13h5l1.5 3h5L16 13h5" /><path d="M5 5h14l2 8v6H3v-6z" /></S>),
  runs: () => (<S><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" /></S>),
  doc: () => (<S><path d="M6 3h8l4 4v14H6z" /><path d="M10 12l-2 2 2 2M14 12l2 2-2 2" /></S>),
  play: () => (<S><path d="M7 5l12 7-12 7z" /></S>),
  search: () => (<S><circle cx="11" cy="11" r="6" /><path d="M20 20l-4-4" /></S>),
  panel: () => (<S><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M10 4v16" /></S>),
  filter: () => (<S><path d="M4 7h16M7 12h10M10 17h4" /></S>),
  chev: () => (<S size={14} w={2}><path d="M9 6l6 6-6 6" /></S>),
  down: () => (<S size={14} w={2}><path d="M6 9l6 6 6-6" /></S>),
  q: () => (<S><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01" /></S>),
  x: () => (<S><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></S>),
  pr: () => (<S><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /><path d="M6 8v8M18 16V9a3 3 0 0 0-3-3h-4" /><path d="M13 4l-2 2 2 2" /></S>),
  code: () => (<S size={19} w={2}><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" /></S>),
  chat: () => (<S size={19} w={2}><path d="M4 5h11v8H9l-3 3v-3H4z" /><path d="M15 9h5v8h-2v3l-3-3h-4v-2" /></S>),
  shield: () => (<S size={19} w={2}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></S>),
  check: () => (<S size={19} w={2}><path d="M5 12l5 5 9-10" /></S>),
  flow: () => (<S size={19} w={2}><path d="M5 4v12a3 3 0 0 0 3 3h6M5 9h9" /><circle cx="17" cy="9" r="2.5" /><circle cx="17" cy="19" r="2.5" /></S>),
  gauge: () => (<S><path d="M4 18a8 8 0 1 1 16 0" /><path d="M12 18l4-6" /></S>),
  board: () => (<S><rect x="3" y="4" width="5" height="16" rx="1.5" /><rect x="10" y="4" width="5" height="11" rx="1.5" /><rect x="17" y="4" width="4" height="7" rx="1.5" /></S>),
  bot: () => (<S><rect x="5" y="8" width="14" height="11" rx="3" /><path d="M12 4v4M9 13h.01M15 13h.01" /></S>),
  chart: () => (<S><path d="M4 20V4M4 20h16M8 16l4-5 3 3 5-7" /></S>),
  cog: () => (<S><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" /></S>),
  book: () => (<S><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" /><path d="M4 21V5" /></S>),
  home: () => (<S><path d="M4 11l8-7 8 7v9H4z" /><path d="M10 20v-5h4v5" /></S>),
};
export type IconName = keyof typeof ICONS;
export function Icon({ name }: { name: IconName }) {
  const C = ICONS[name];
  return <C />;
}
