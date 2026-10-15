// Lehçeye duyarlı, hafif SQL tarayıcısı. Ayrıştırıcı değildir: yalnızca metin/tanımlayıcı/yorum sınırlarını
// doğru bulur ki ifade bölme ve salt okunur sınıflandırması tırnak içindeki ";" ya da "DELETE"e aldanmasın.
import type { SqlDialect } from '../provider';

export type TokenKind = 'ws' | 'comment' | 'string' | 'qident' | 'word' | 'number' | 'punct' | 'param';

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
  /** word için büyük harfe çevrilmiş metin */
  upper?: string;
}

const isWordStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c);
const isWordChar = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c);

export function tokenize(sql: string, d: SqlDialect): Token[] {
  const out: Token[] = [];
  const n = sql.length;
  let i = 0;
  const push = (kind: TokenKind, start: number, end: number) => {
    const t: Token = { kind, start, end };
    if (kind === 'word') t.upper = sql.slice(start, end).toUpperCase();
    out.push(t);
  };

  // Tırnaklı bölge: kapanış karakterine kadar; çift kapanış kaçış sayılır, backslash isteğe bağlı
  const quoted = (start: number, close: string, backslash: boolean) => {
    let j = start + 1;
    while (j < n) {
      const c = sql[j];
      if (backslash && c === '\\') { j += 2; continue; }
      if (c === close) {
        if (sql[j + 1] === close) { j += 2; continue; }
        return j + 1;
      }
      j++;
    }
    return n;
  };

  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      let j = i + 1;
      while (j < n && /\s/.test(sql[j])) j++;
      push('ws', i, j); i = j; continue;
    }
    // -- satır yorumu (MySQL'de ayrıca #)
    if ((c === '-' && c2 === '-') || (c === '#' && d === 'mysql')) {
      let j = i + 1;
      while (j < n && sql[j] !== '\n') j++;
      push('comment', i, j); i = j; continue;
    }
    // /* blok yorumu */ (PostgreSQL ve DuckDB iç içe yorumlara izin verir)
    if (c === '/' && c2 === '*') {
      const nested = d === 'postgres' || d === 'duckdb';
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; continue; }
        if (nested && sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; continue; }
        j++;
      }
      push('comment', i, j); i = j; continue;
    }
    // E'...' (PostgreSQL backslash kaçışlı metin)
    if ((c === 'E' || c === 'e') && c2 === "'" && (d === 'postgres' || d === 'duckdb')) {
      const j = quoted(i + 1, "'", true);
      push('string', i, j); i = j; continue;
    }
    // N'...' (SQL Server Unicode metin)
    if ((c === 'N' || c === 'n') && c2 === "'" && d === 'mssql') {
      const j = quoted(i + 1, "'", false);
      push('string', i, j); i = j; continue;
    }
    if (c === "'") {
      const j = quoted(i, "'", d === 'mysql');
      push('string', i, j); i = j; continue;
    }
    if (c === '"') {
      const j = quoted(i, '"', d === 'mysql');
      push(d === 'mysql' ? 'string' : 'qident', i, j); i = j; continue;
    }
    if (c === '`' && (d === 'mysql' || d === 'sqlite')) {
      const j = quoted(i, '`', false);
      push('qident', i, j); i = j; continue;
    }
    if (c === '[' && (d === 'mssql' || d === 'sqlite')) {
      const j = quoted(i, ']', false);
      push('qident', i, j); i = j; continue;
    }
    // $etiket$ ... $etiket$ (PostgreSQL / DuckDB); $1 parametre
    if (c === '$' && (d === 'postgres' || d === 'duckdb')) {
      if (/[0-9]/.test(c2 ?? '')) {
        let j = i + 1;
        while (j < n && /[0-9]/.test(sql[j])) j++;
        push('param', i, j); i = j; continue;
      }
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const j = close < 0 ? n : close + tag.length;
        push('string', i, j); i = j; continue;
      }
    }
    if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWordChar(sql[j])) j++;
      push('word', i, j); i = j; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(c2 ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9.eE_xXa-fA-F]/.test(sql[j])) j++;
      push('number', i, j); i = j; continue;
    }
    if ((c === '@' && (d === 'mssql' || d === 'mysql')) || ((c === ':' || c === '?') && d === 'sqlite')) {
      // @değişken (MSSQL/MySQL), :ad / ? parametre
      let j = i + 1;
      while (j < n && (isWordChar(sql[j]) || sql[j] === '@')) j++;
      push('param', i, j); i = j; continue;
    }
    push('punct', i, i + 1);
    i++;
  }
  return out;
}

/** Yorum ve boşluk dışındaki belirteçler */
export const significant = (tokens: Token[]) => tokens.filter((t) => t.kind !== 'ws' && t.kind !== 'comment');
