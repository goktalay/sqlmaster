// Ortak arayüz yardımcıları — SSH Master / FTP Masters ui.js'in TypeScript uyarlaması (aynı ikonlar, modal, bağlam menüsü, bildirimler).
import { createT, LANGUAGES } from '../../shared/i18n';
import { api } from './api';

export const LANG = api.lang || 'en';
export const t = createT(LANG);
document.documentElement.lang = LANG;
document.documentElement.dir = (LANGUAGES[LANG] || { dir: 'ltr' }).dir;

export const ICONS: Record<string, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  move: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  play: '<path d="M7 5v14l11-7z"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  home: '<path d="m3 11 9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  bolt: '<path d="M13 3 4 14h7l-1 7 9-11h-7z"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3M14 9l2 2"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  drive: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M5 13 7.5 5h9L19 13M7 16.5h.01"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  crosshair: '<circle cx="12" cy="12" r="8"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-4-4-7.2-9-7.2z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10.5" cy="7" r="1.2"/><circle cx="15" cy="7.5" r="1.2"/>',
  columns:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  rows: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  gauge: '<path d="M4 18a9 9 0 1 1 16 0"/><path d="m12 14 4-5"/><circle cx="12" cy="14" r="1.2"/>',
  swap: '<path d="M7 20V5M3 9l4-4 4 4M17 4v15M13 15l4 4 4-4"/>',
  broom: '<path d="M19 3 11 11M8 12l4 4-2 5-7-7 5-2zM6 17l-2 2"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  cloud: '<path d="M7 18a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>',
  cloudOff: '<path d="M3 3l18 18M8.5 5.4A6 6 0 0 1 18 9a4.5 4.5 0 0 1 2.4 8.3M15 18H7a5 5 0 0 1-1.6-9.7"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  reconnect:'<path d="M4 4v6h6M20 20v-6h-6"/><path d="M20 10a8 8 0 0 0-14.3-4.3L4 10M4 14a8 8 0 0 0 14.3 4.3L20 14"/>',

  database: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  schema: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M6.5 10v4a2 2 0 0 0 2 2H14"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18M3 15h18M9.5 9.5V20"/>',
  view: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18"/><path d="M7 15s2-2.5 5-2.5 5 2.5 5 2.5-2 2.5-5 2.5S7 15 7 15z"/>',
  matview: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 13h8M8 16.5h5"/>',
  func: '<path d="M14 4h-1.5A2.5 2.5 0 0 0 10 6.5V20M7 11h7"/><path d="m15 14 5 5M20 14l-5 5"/>',
  proc: '<path d="M5 4h14v16H5z"/><path d="m9 9 3 3-3 3M13 15h3"/>',
  trigger: '<path d="M13 3 4 14h7l-1 7 9-11h-7z"/>',
  sequence: '<path d="M4 7h3M4 12h3M4 17h3M10 7h10M10 12h10M10 17h10"/>',
  type: '<path d="M5 6h14M12 6v13M9 19h6"/>',
  index: '<path d="M4 6h16M4 12h10M4 18h6"/><path d="m17 15 3 3-3 3"/>',
  column: '<rect x="8" y="3" width="8" height="18" rx="1.5"/><path d="M8 8h8M8 13h8"/>',
  constraint: '<path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z"/>',
  code: '<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 4l-4 16"/>',
  sql: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M8 13h8M8 17h5"/>',
  builder: '<rect x="3" y="3" width="7" height="6" rx="1.5"/><rect x="14" y="15" width="7" height="6" rx="1.5"/><rect x="14" y="3" width="7" height="6" rx="1.5"/><path d="M10 6h4M17.5 9v6"/>',
  sortAsc: '<path d="M7 20V4M3 8l4-4 4 4M14 6h7M14 11h5M14 16h3"/>',
  sortDesc: '<path d="M7 4v16M3 16l4 4 4-4M14 6h3M14 11h5M14 16h7"/>',
  filter: '<path d="M4 5h16l-6 8v6l-4-2v-4z"/>',
  hide: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/>',
  exportFile: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14l3 3 3-3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  wrap: '<path d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-4M4 18h6"/><path d="m15 16-2 2 2 2"/>',
  format: '<path d="M4 6h16M8 10h12M8 14h12M4 18h16"/>',
  plusSq: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8M8 12h8"/>',
  sigma: '<path d="M18 5H6l6 7-6 7h12"/>',
  file2: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  dots: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
};

export function icon(name: string, cls = ''): string {
  return `<svg class="i ${cls}" viewBox="0 0 24 24">${ICONS[name] || ''}</svg>`;
}

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString(LANG, { dateStyle: 'short', timeStyle: 'short' });
}

export const formatNumber = (n: number) => n.toLocaleString(LANG);

export function h<T extends HTMLElement = HTMLElement>(html: string): T {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild as T;
}

export const $ = <T extends HTMLElement = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector(s) as T;
export const $$ = <T extends HTMLElement = HTMLElement>(s: string, root: ParentNode = document) => [...root.querySelectorAll(s)] as T[];

// --- Bağlam menüsü ------------------------------------------------------------
export interface MenuItem {
  label: string;
  icon?: string;
  kbd?: string;
  danger?: boolean;
  disabled?: boolean;
  action: () => void;
}
let activeCtx: HTMLElement | null = null;
export function closeContextMenu() {
  if (activeCtx) { activeCtx.remove(); activeCtx = null; }
}
export function contextMenu(x: number, y: number, items: (MenuItem | '-' | null | false | undefined)[]) {
  closeContextMenu();
  const menu = h('<div class="ctx"></div>');
  for (const it of items) {
    if (it === '-') { menu.appendChild(h('<hr>')); continue; }
    if (!it) continue;
    const b = h<HTMLButtonElement>(`<button class="${it.danger ? 'danger' : ''}">${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span>${it.kbd ? `<span class="kbd">${esc(it.kbd)}</span>` : ''}</button>`);
    if (it.disabled) b.disabled = true;
    b.addEventListener('click', () => { closeContextMenu(); it.action(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 6)) + 'px';
  activeCtx = menu;
}
window.addEventListener('mousedown', (e) => { if (activeCtx && !activeCtx.contains(e.target as Node)) closeContextMenu(); }, true);
window.addEventListener('blur', closeContextMenu);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeContextMenu(); });

// --- Bildirimler --------------------------------------------------------------
function toastHost() {
  let el = document.querySelector<HTMLElement>('.toasts');
  if (!el) { el = h('<div class="toasts"></div>'); document.body.appendChild(el); }
  return el;
}
export function toast(title: string, { type = '', sub = '', timeout = 3500 }: { type?: '' | 'ok' | 'err'; sub?: string; timeout?: number } = {}) {
  const el = h(`<div class="toast ${type}"><div class="t-body"><div class="t-title">${esc(title)}</div>${sub ? `<div class="t-sub">${esc(sub)}</div>` : ''}</div></div>`);
  toastHost().appendChild(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}

// --- Modal --------------------------------------------------------------------
export interface ModalButton<R> {
  label: string;
  cls?: string;
  icon?: string;
  left?: boolean;
  value?: R | null;
  onClick?: (modal: HTMLElement, btn: HTMLButtonElement) => R | false | undefined | void | Promise<R | false | undefined | void>;
}
export function openModal<R = unknown>(o: { title: string; iconName?: string; body: string | HTMLElement; buttons?: ModalButton<R>[]; width?: number; onMount?: (m: HTMLElement, close: (v: R | null) => void) => void }): Promise<R | null> {
  return new Promise((resolve) => {
    const back = h('<div class="modal-backdrop"></div>');
    const modal = h(`<div class="modal">
      <header>${o.iconName ? `<span style="color:var(--accent)">${icon(o.iconName)}</span>` : ''}<h2>${esc(o.title)}</h2></header>
      <div class="body"></div><footer><span class="spacer"></span></footer></div>`);
    if (o.width) modal.style.width = `min(${o.width}px, calc(100vw - 32px))`;
    const bodyEl = $('.body', modal);
    if (typeof o.body === 'string') bodyEl.innerHTML = o.body; else bodyEl.appendChild(o.body);
    const footer = $('footer', modal);
    const close = (val: R | null) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    for (const b of o.buttons ?? []) {
      const btn = h<HTMLButtonElement>(`<button class="btn ${b.cls || ''}">${b.icon ? icon(b.icon) : ''}${esc(b.label)}</button>`);
      btn.addEventListener('click', async () => {
        if (b.onClick) {
          const r = await b.onClick(modal, btn);
          if (r === false) return;
          close(r === undefined ? (b.value ?? null) : (r as R));
        } else close(b.value ?? null);
      });
      if (b.left) footer.insertBefore(btn, $('.spacer', footer)); else footer.appendChild(btn);
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'TEXTAREA' && !(e.target as HTMLElement).closest('.cm-editor')) {
        const primary = [...footer.querySelectorAll<HTMLButtonElement>('.btn.primary')].pop();
        if (primary) { e.preventDefault(); primary.click(); }
      }
    };
    document.addEventListener('keydown', onKey);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
    back.appendChild(modal);
    document.body.appendChild(back);
    o.onMount?.(modal, close);
    const first = modal.querySelector<HTMLElement>('input:not([type=checkbox]):not([disabled]),textarea,select');
    if (first) setTimeout(() => first.focus(), 30);
  });
}

export function prompt(title: string, { label = '', value = '', placeholder = '', okText = t('common.ok'), iconName = 'edit', type = 'text' } = {}): Promise<string | null> {
  return openModal<string>({
    title, iconName,
    body: `<div class="field"><label>${esc(label)}</label><input class="input" id="pv" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}"></div>`,
    buttons: [
      { label: t('common.cancel'), value: null },
      { label: okText, cls: 'primary', onClick: (m) => { const i = $<HTMLInputElement>('#pv', m); const v = type === 'password' ? i.value : i.value.trim(); if (!v) { i.classList.add('invalid'); return false; } return v; } },
    ],
    onMount: (m) => { const i = $<HTMLInputElement>('#pv', m); setTimeout(() => i.select(), 40); },
  });
}

export function confirmBox(title: string, message: string, { okText = t('common.delete'), danger = true } = {}): Promise<boolean | null> {
  return openModal<boolean>({
    title, iconName: danger ? 'trash' : 'check',
    body: `<div style="color:var(--text-2);line-height:1.5">${message}</div>`,
    buttons: [
      { label: t('common.giveUp'), value: false },
      { label: okText, cls: danger ? 'primary danger-primary' : 'primary', value: true },
    ],
  });
}

export const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
