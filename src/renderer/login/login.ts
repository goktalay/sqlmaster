// Giriş ekranı: uygulama Mastertool hesabıyla girişsiz açılmaz.
import { LANGUAGES } from '../../shared/i18n';
import { api } from '../lib/api';
import { $, esc, h, icon, LANG, t } from '../lib/ui';
import { mastertoolButton } from '../lib/mastertool';

$('#subtitle').textContent = t('auth.subtitle');
$('#lEmail').textContent = t('auth.email');
$('#lPassword').textContent = t('auth.password');
$('#lRemember').textContent = t('auth.remember');
$('#forgot').textContent = t('auth.forgot');
$('#noAccount').textContent = t('auth.noAccount');
$('#register').textContent = t('auth.register');
$('#submit').textContent = t('auth.submit');
document.body.appendChild(Object.assign(mastertoolButton(), { id: 'mtk' }));
$('#eye').innerHTML = icon('eye');
$('#eye').title = t('common.show');

for (const [code, l] of Object.entries(LANGUAGES)) $('#lang').appendChild(h(`<option value="${code}" ${code === LANG ? 'selected' : ''}>${esc(l.name)}</option>`));
$<HTMLSelectElement>('#lang').onchange = (e) => api.setSettings({ language: (e.target as HTMLSelectElement).value });

$('#eye').onclick = () => {
  const p = $<HTMLInputElement>('#password');
  p.type = p.type === 'password' ? 'text' : 'password';
  $('#eye').innerHTML = icon(p.type === 'password' ? 'eye' : 'eyeOff');
};
$('#forgot').onclick = (e) => { e.preventDefault(); void api.openWeb('forgot'); };
$('#register').onclick = (e) => { e.preventDefault(); void api.openWeb('register'); };

const ERRORS: Record<string, string> = {
  bad_credentials: 'auth.errBadCredentials', unverified: 'auth.errUnverified', suspended: 'auth.errSuspended',
  rate_limited: 'auth.errRateLimited', offline: 'auth.errOffline', session_expired: 'auth.errSessionExpired',
  app_disabled: 'auth.errAppDisabled', wrong_app: 'auth.errWrongApp',
};

function showError(msg: string) {
  $('#error').textContent = msg;
  $('#error').classList.toggle('hidden', !msg);
}

void api.accountState().then((st) => {
  $('#ver').textContent = `v${st.appVersion}`;
  if (st.email) $<HTMLInputElement>('#email').value = st.email;
  const notice = st.notice || (st.devMode ? t('auth.devNotice') : '');
  if (notice) { $('#notice').textContent = notice; $('#notice').classList.remove('hidden'); }
  (st.email ? $('#password') : $('#email')).focus();
});

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $<HTMLInputElement>('#email').value.trim();
  const password = $<HTMLInputElement>('#password').value;
  $('#email').classList.toggle('invalid', !email);
  $('#password').classList.toggle('invalid', !password);
  if (!email || !password) return showError(t('auth.errRequired'));
  showError('');
  const btn = $<HTMLButtonElement>('#submit');
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span>${esc(t('auth.working'))}`;
  const res = await api.login(email, password, $<HTMLInputElement>('#remember').checked);
  if (res.ok) return; // ana süreç bu pencereyi kapatıp ana pencereyi açar
  btn.disabled = false;
  btn.textContent = t('auth.submit');
  showError(res.code && ERRORS[res.code] ? t(ERRORS[res.code]) : t('auth.errServer', { msg: res.message || res.code || '' }));
  if (res.code === 'bad_credentials') $<HTMLInputElement>('#password').select();
});
