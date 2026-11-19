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
