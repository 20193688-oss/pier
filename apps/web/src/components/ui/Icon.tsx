/* A small stroke icon set (24px grid, currentColor). Decorative unless given a label. */
import type { SVGProps } from 'react';

const PATHS = {
  copy: 'M9 9h10v11H9zM5 15V4h10',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  chevron: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6L4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 16.5a4.5 4.5 0 100-9 4.5 4.5 0 000 9z',
  moon: 'M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z',
  wallet: 'M3.5 7.5h17v12h-17zM3.5 7.5l13-3.5v3.5M16.5 13.5h.01',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4',
  globe:
    'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9s1.2-6.4 3.7-9z',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 017 0v3',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  alert:
    'M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 8h.01',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  key: 'M14.5 9.5a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM13.2 12.8L20 19.5M17.5 17l2-2',
  bolt: 'M13 3L5 13.5h6L10 21l8-10.5h-6z',
  users:
    'M9 11a4 4 0 100-8 4 4 0 000 8zM2.5 20a6.5 6.5 0 0113 0M16 3.5a4 4 0 010 7.5M21.5 20a6.5 6.5 0 00-4-6',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  coins:
    'M9 10a6 3 0 100-.01M3 10v4c0 1.7 2.7 3 6 3s6-1.3 6-3v-4M15 7.5c3.3 0 6 1.3 6 3v4c0 1.7-2.7 3-6 3',
  tag: 'M3.5 12.5V4h8.5l8.5 8.5-8 8zM8 8h.01',
  bank: 'M3 9.5L12 4l9 5.5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20.5h18',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  link: 'M10 14a4.5 4.5 0 006.4 0l3-3a4.5 4.5 0 00-6.4-6.4l-1.2 1.2M14 10a4.5 4.5 0 00-6.4 0l-3 3a4.5 4.5 0 006.4 6.4l1.2-1.2',
  send: 'M4 12l16-8-6 16-2.5-6.5z',
  book: 'M5 4.5h10a3 3 0 013 3V20H8a3 3 0 01-3-3zM5 17a3 3 0 013-3h10',
  hook: 'M7 4v7a5 5 0 0010 0V9M14 6l3 3 3-3',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 5v6h-6',
  scan: 'M4 8V5.5A1.5 1.5 0 015.5 4H8M16 4h2.5A1.5 1.5 0 0120 5.5V8M20 16v2.5a1.5 1.5 0 01-1.5 1.5H16M8 20H5.5A1.5 1.5 0 014 18.5V16M4 12h16',
  home: 'M4 10.5L12 4l8 6.5V20h-5.5v-5.5h-5V20H4z',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4.5 20.5a7.5 7.5 0 0115 0',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  torch: 'M8 3h8l-1.5 6h-5zM9.5 9h5v11.5h-5zM12 13v2',
  image: 'M4 5h16v14H4zM4 16l4.5-4.5 4 4 2.5-2.5 5 5M15.5 9.5h.01',
  share: 'M12 15V3.5M7.5 8L12 3.5 16.5 8M5 12v8h14v-8',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 14.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
  eyeOff: 'M3 3l18 18M10.6 5.6A9.4 9.4 0 0112 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 01-2.9 3.7M6.4 6.5C3.9 8.2 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1.1M9.9 9.9a2.5 2.5 0 003.5 3.5',
  store: 'M4 9.5L5.5 4h13L20 9.5M4 9.5h16v1a3 3 0 01-6 0 3 3 0 01-4 0 3 3 0 01-6 0zM5 13v7h14v-7M10 20v-4h4v4',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 20,
  label,
  ...rest
}: { name: IconName; size?: number; label?: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
