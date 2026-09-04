// Vite supplies '/' locally and the Pages base path in deployment builds.
const base = import.meta.env.BASE_URL;
const prefix = base.replace(/\/$/, '');

export function withoutBase(path) {
  if (prefix && path === prefix) return '/';
  return prefix && path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path;
}

export function withBase(href) {
  if (!href.startsWith('/') || href.startsWith('//')) return href;
  return `${prefix}${withoutBase(href)}`;
}
