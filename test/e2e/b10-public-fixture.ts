export const B10_PUBLIC_FIXTURE_BASE_URL =
  process.env.B10_PUBLIC_FIXTURE_BASE_URL?.replace(/\/+$/, '') ?? '';

export function b10PublicUrl(path: string): string | null {
  if (!B10_PUBLIC_FIXTURE_BASE_URL) return null;
  return `${B10_PUBLIC_FIXTURE_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

export const B10_PUBLIC_FIXTURE_PATHS = {
  normal: '/b10/normal.html',
  selector: '/b10/selector.html',
  noise: '/b10/noise.html',
  chinese: '/b10/zh.html',
  redirectOne: '/b10/redirect/one',
  redirectPrivate: '/b10/redirect/private',
  redirectLoop: '/b10/redirect/loop',
  empty: '/b10/empty.html',
  noSelectorMatch: '/b10/no-selector-match.html',
  brokenHtml: '/b10/broken.html',
  unsupportedMime: '/b10/unsupported.bin',
  slow: '/b10/slow',
  large: '/b10/large',
  flaky: '/b10/flaky',
  recursive: '/b10/recursive.html',
} as const;
