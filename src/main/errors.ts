// Sürücü/ağ hatalarını kullanıcı dostu metne çevirir. Veritabanının kendi mesajı (sözdizimi hatası vb.) korunur.
import type { T } from '../shared/i18n';
import { redact } from './logger';

export function friendlyError(err: unknown, t: T): string {
  const e = err as { code?: string; message?: string; errno?: number };
  const msg = redact(String(e?.message ?? err ?? ''));
  const code = String(e?.code ?? '');
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) return t('err.refused');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /ENOTFOUND|getaddrinfo/.test(msg)) return t('err.dns');
  if (code === 'ETIMEDOUT' || code === 'ETIMEOUT' || /timeout|timed out/i.test(msg)) return t('err.timeout') + (msg ? ` (${msg})` : '');
  if (code === 'ECONNRESET' || /ECONNRESET/.test(msg)) return t('err.reset');
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return t('err.unreach');
  if (/All configured authentication methods failed/i.test(msg)) return t('err.sshAuth');
  if (/self[- ]signed certificate|unable to verify|certificate/i.test(msg)) return t('err.tls', { msg });
  if (/Veritabanı süreci sonlandı/.test(msg)) return t('err.hostExit');
  return msg || t('err.unknown');
}
