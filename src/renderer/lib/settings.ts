// Ayarlar penceresi, Gece/Gündüz düğmesi ve hesap durumu (ana pencere ve bağlantı penceresi ortak).
import type { AccountState, Settings } from '../../shared/types';
import { LANGUAGES } from '../../shared/i18n';
import { api } from './api';
import { $, $$, confirmBox, esc, formatDate, h, icon, LANG, openModal, t, toast } from './ui';

export let acct: AccountState = { loggedIn: false, user: null, email: '', syncEnabled: false, state: 'idle', lastSyncAt: null, error: null };
const listeners: ((st: AccountState) => void)[] = [];

export function syncText(st: AccountState): string {
  if (st.devMode) return t('sync.devMode');
  if (!st.syncEnabled || st.state === 'off') return t('sync.off');
  if (st.state === 'syncing') return t('sync.syncing');
  if (st.state === 'offline') return t('sync.offline');
  if (st.state === 'error') {
    if (st.error === 'decrypt_failed') return t('sync.errDecrypt');
    if (st.error === 'too_large') return t('sync.errTooLarge');
    return t('sync.error', { msg: st.errorMessage || st.error || '' });
  }
  return st.lastSyncAt ? t('acct.lastSync', { time: formatDate(st.lastSyncAt) }) : t('acct.never');
}

export function onAcct(fn: (st: AccountState) => void) {
  listeners.push(fn);
  fn(acct);
}
function setAcct(st: AccountState) {
  acct = st;
  const live = document.querySelector('#acct-status');
  if (live) live.textContent = syncText(acct);
  listeners.forEach((fn) => fn(acct));
}
api.onAccountStatus(setAcct);
void api.accountState().then(setAcct);

export async function logout() {
  const ok = await confirmBox(t('acct.logout'), esc(t('acct.logoutMsg')), { okText: t('acct.logout') });
  if (ok) void api.logout();
}

/** Hızlı tema düğmesi: Gece ↔ Gündüz */
export function themeButton(btn: HTMLElement) {
  const light = matchMedia('(prefers-color-scheme: light)');
  const paint = () => {
    btn.innerHTML = icon(light.matches ? 'moon' : 'sun');
    btn.title = light.matches ? t('set.toDark') : t('set.toLight');
  };
  btn.onclick = () => api.setSettings({ appTheme: light.matches ? 'dark' : 'light' });
  light.addEventListener('change', paint);
  paint();
}

const OSS: [string, string][] = [
  ['Electron', 'MIT'], ['Chromium', 'BSD-3-Clause'], ['Node.js', 'MIT'], ['CodeMirror', 'MIT'], ['node-postgres (pg, pg-cursor)', 'MIT'],
  ['mssql / tedious', 'MIT'], ['mysql2', 'MIT'], ['DuckDB (@duckdb/node-api)', 'MIT'], ['SQLite', 'Public Domain'], ['ssh2', 'MIT'],
];

/** Ayarlar penceresi — Mastertool ortak iskeleti: Genel · Hesap · Sorgular · Hakkında (solda sekmeler, 760 px) */
export async function openSettings(s: Settings, startTab: 'general' | 'account' | 'query' | 'about' = 'general') {
  let appTheme = s.appTheme || 'system';
  const originalTheme = appTheme;
  const langOptions = Object.entries(LANGUAGES).map(([code, l]) => `<option value="${code}" ${code === LANG ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  const tabs: [string, string, string][] = [['general', 'gear', t('set.general')], ['account', 'user', t('set.account')], ['query', 'sql', t('set.query')], ['about', 'info', t('set.about')]];
  const body = h(`<div class="set-wrap">
    <nav class="set-nav">${tabs.map(([k, ic, l]) => `<button type="button" data-tab="${k}">${icon(ic)}<span>${esc(l)}</span></button>`).join('')}</nav>
    <div class="set-pages">
      <section data-page="general">
        <div class="field"><label>${esc(t('set.language'))}</label><select class="input" id="s-lang">${langOptions}</select>
          <span class="set-hint">${esc(t('set.languageHint'))}</span></div>
        <div class="field"><label>${esc(t('set.theme'))}</label>
          <div class="seg" id="s-theme">
            <button type="button" data-v="dark">${icon('moon')}${esc(t('set.themeDark'))}</button>
            <button type="button" data-v="light">${icon('sun')}${esc(t('set.themeLight'))}</button>
            <button type="button" data-v="system">${icon('monitor')}${esc(t('set.themeSystem'))}</button>
          </div></div>
        <div class="section-title">${esc(t('set.startup'))}</div>
        <label class="check"><input type="checkbox" id="s-login" ${s.openAtLogin ? 'checked' : ''}><span>${esc(t('set.openAtLogin'))}<small>${esc(t('set.openAtLoginHint'))}</small></span></label>
        <label class="check"><input type="checkbox" id="s-mintray" ${s.minimizeToTray ? 'checked' : ''}><span>${esc(t('set.minTray'))}<small>${esc(t('set.minTrayHint'))}</small></span></label>
        <label class="check"><input type="checkbox" id="s-closetray" ${s.closeToTray ? 'checked' : ''}><span>${esc(t('set.closeTray'))}<small>${esc(t('set.closeTrayHint'))}</small></span></label>
      </section>

      <section data-page="account" class="hidden">
        <div class="acct-box">
          <div class="acct-who">${icon('user')}<span>${esc(t('acct.signedInAs', { email: acct.user?.email || acct.email || '' }))}</span></div>
          <label class="check"><input type="checkbox" id="s-sync" ${acct.syncEnabled ? 'checked' : ''} ${acct.devMode ? 'disabled' : ''}>
            <span>${esc(t('acct.syncToggle'))}<small>${esc(t('acct.syncHint'))}</small></span></label>
          <div class="acct-status">${icon('cloud')}<span id="acct-status">${esc(syncText(acct))}</span></div>
          <div class="acct-actions">
            <button class="btn sm" type="button" id="s-syncnow">${icon('refresh')}${esc(t('acct.syncNow'))}</button>
            <button class="btn sm" type="button" id="s-delremote">${icon('trash')}${esc(t('acct.deleteRemote'))}</button>
          </div>
          <div class="acct-actions">
            <button class="btn sm" type="button" id="s-web">${icon('open')}${esc(t('acct.myAccount'))}</button>
            <span style="flex:1"></span>
            <button class="btn sm danger" type="button" id="s-logout">${icon('logout')}${esc(t('acct.logout'))}</button>
          </div>
        </div>
      </section>

      <section data-page="query" class="hidden">
        <div class="row c-1-1">
          <div class="field"><label>${esc(t('set.rowLimit'))}</label><input class="input" id="s-limit" type="number" min="100" max="1000000" value="${esc(s.rowLimit)}"></div>
          <div class="field"><label>${esc(t('set.previewRows'))}</label><input class="input" id="s-preview" type="number" min="10" max="100000" value="${esc(s.previewRows)}"></div>
        </div>
        <div class="row c-1-1">
          <div class="field"><label>${esc(t('set.fontSize'))}</label><input class="input" id="s-font" type="number" min="9" max="24" value="${esc(s.editorFontSize)}"></div>
          <div></div>
        </div>
      </section>

      <section data-page="about" class="hidden">
        <div class="about-head"><img src="../../assets/icon.png" alt="">
          <div><div class="about-name">SQL Master</div><div class="about-ver">${esc(t('about.version', { version: api.version || '' }))}</div></div></div>
        <div class="set-hint">${esc(t('about.family'))}</div>
        <div class="acct-actions" style="align-items:center">
          <button class="btn sm" type="button" id="s-update">${icon('refresh')}${esc(t('about.checkUpdate'))}</button>
          <span class="about-update" id="s-update-res"></span>
        </div>
        <div class="section-title">${esc(t('about.licenses'))}</div>
        <div class="set-hint">${esc(t('about.licensesIntro'))}</div>
        <ul class="oss">${OSS.map(([n, l]) => `<li><span>${esc(n)}</span><span>${esc(l)}</span></li>`).join('')}</ul>
        <div class="acct-actions" style="align-items:center">
          <button class="btn sm" type="button" id="s-chromium">${icon('file2')}${esc(t('about.chromium'))}</button>
          <span class="set-hint" id="s-versions"></span>
        </div>
      </section>
    </div>
  </div>`);
  const q = <T extends HTMLElement = HTMLInputElement>(sel: string) => $<T>(sel, body);

  const showTab = (k: string) => {
    $$('.set-nav button', body).forEach((b) => b.classList.toggle('on', b.dataset.tab === k));
    $$('.set-pages section', body).forEach((p) => p.classList.toggle('hidden', p.dataset.page !== k));
  };
  $$('.set-nav button', body).forEach((b) => (b.onclick = () => showTab(b.dataset.tab!)));
  showTab(startTab);

  // Hesap bölümü anında uygulanır (Kaydet beklemez)
  q<HTMLInputElement>('#s-sync').onchange = async (e) => {
    const el = e.target as HTMLInputElement;
    const r = await api.setSyncEnabled(el.checked);
    if (!r.ok) { el.checked = !el.checked; toast(t('sync.error', { msg: r.code || '' }), { type: 'err' }); }
  };
  q('#s-syncnow').onclick = () => void api.syncNow();
  q('#s-web').onclick = () => void api.openWeb('account');
  q('#s-delremote').onclick = async () => {
    if (!(await confirmBox(t('acct.deleteRemote'), esc(t('acct.deleteRemoteMsg'))))) return;
    const r = await api.deleteRemoteLibrary();
    if (r.ok) { q<HTMLInputElement>('#s-sync').checked = false; toast(t('acct.deleteRemoteDone'), { type: 'ok' }); }
    else toast(t('sync.error', { msg: r.code || '' }), { type: 'err' });
  };
  q('#s-logout').onclick = logout;

  // Hakkında
  void api.about().then((a) => (q('#s-versions').textContent = `Electron ${a.electron} · Chromium ${a.chrome}`));
  q('#s-chromium').onclick = () => void api.openLicenses();
  q('#s-update').onclick = async () => {
    const res = q('#s-update-res');
    res.className = 'about-update';
    res.textContent = t('about.checking');
    const r = await api.checkUpdate();
    if (!r.ok) { res.className = 'about-update err'; res.textContent = t('about.checkFailed', { msg: r.message || '' }); }
    else if (r.newer && r.version) { res.className = 'about-update new'; res.textContent = t('about.newVersion', { version: r.version }); }
    else { res.className = 'about-update ok'; res.textContent = t('about.upToDate'); }
  };

  // Tema anında önizlenir; İptal'de eski temaya döner
  const setTheme = (v: Settings['appTheme']) => {
    appTheme = v;
    $$('#s-theme button', body).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    void api.setSettings({ appTheme: v });
  };
  $$('#s-theme button', body).forEach((b) => {
    b.onclick = () => setTheme(b.dataset.v as Settings['appTheme']);
    b.classList.toggle('on', b.dataset.v === appTheme);
  });

  const clamp = (v: string, min: number, max: number, def: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def; };
  const res = await openModal<Partial<Settings>>({
    title: t('set.title'), iconName: 'gear', width: 760, body,
    buttons: [
      { label: t('common.cancel'), value: null },
      {
        label: t('common.save'), cls: 'primary',
        onClick: () => ({
          appTheme,
          language: q<HTMLSelectElement>('#s-lang').value,
          openAtLogin: q<HTMLInputElement>('#s-login').checked,
          minimizeToTray: q<HTMLInputElement>('#s-mintray').checked,
          closeToTray: q<HTMLInputElement>('#s-closetray').checked,
          rowLimit: clamp(q<HTMLInputElement>('#s-limit').value, 100, 1_000_000, 10_000),
          previewRows: clamp(q<HTMLInputElement>('#s-preview').value, 10, 100_000, 100),
          editorFontSize: clamp(q<HTMLInputElement>('#s-font').value, 9, 24, 13),
        }),
      },
    ],
  });
  if (!res) {
    if (appTheme !== originalTheme) void api.setSettings({ appTheme: originalTheme });
    return null;
  }
  const langChanged = res.language !== LANG;
  if (!langChanged) delete res.language;
  await api.setSettings(res);
  if (!langChanged) toast(t('set.saved'), { type: 'ok' });
  return res;
}
