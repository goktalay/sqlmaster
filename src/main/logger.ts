// Günlük dosyası (userData/logs/sqlmaster-YYYY-MM-DD.log). Parola ve bağlantı dizesi asla yazılmaz:
// her satır redact() süzgecinden geçer; çağıranlar zaten parola içeren nesneleri loglamamalıdır.
import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ILogger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

const SECRET_KEYS = /^(password|passphrase|pwd|secret|token|authHash|auth_hash|encKey|privateKey|sshPassword|sshPassphrase)$/i;

/** Metindeki parola kalıplarını maskeler: URI kimlik bilgileri, key=value, SQL PASSWORD '…' */
export function redact(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s]+@/gi, '$1***@')
    .replace(/\b(password|pwd|passphrase|secret|token)\s*[=:]\s*("[^"]*"|'[^']*'|[^;\s,}]+)/gi, '$1=***')
    .replace(/\b(PASSWORD|IDENTIFIED\s+BY)\s+('(?:[^']|'')*'|"[^"]*")/gi, '$1 ***');
}

/** Nesnelerdeki gizli alanları siler (derin) */
export function scrub(v: unknown, depth = 0): unknown {
  if (depth > 6 || v === null || typeof v !== 'object') return typeof v === 'string' ? redact(v) : v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  if (v instanceof Error) return { message: redact(v.message), name: v.name };
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEYS.test(k) ? (x ? '***' : x) : scrub(x, depth + 1);
  return out;
}

export function createLogger(dir: string, minLevel: LogLevel = 'info'): ILogger {
  const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  fs.mkdirSync(dir, { recursive: true });
  // 14 günden eski günlükleri temizle
  try {
    const cutoff = Date.now() - 14 * 864e5;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (f.endsWith('.log') && fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full);
    }
  } catch { /* önemsiz */ }
  const write = (level: LogLevel, msg: string, data?: unknown) => {
    if (order.indexOf(level) < order.indexOf(minLevel)) return;
    const now = new Date();
    const file = path.join(dir, `sqlmaster-${now.toISOString().slice(0, 10)}.log`);
    let line = `${now.toISOString()} ${level.toUpperCase().padEnd(5)} ${redact(msg)}`;
    if (data !== undefined) {
      try { line += ' ' + JSON.stringify(scrub(data)); } catch { /* döngüsel */ }
    }
    try { fs.appendFileSync(file, line + '\n'); } catch { /* disk dolu vb. */ }
    if (process.env.SQLM_LOG_STDOUT) console.log(line);
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
  };
}
