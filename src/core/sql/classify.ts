// Salt okunur koruması için ifade sınıflandırıcısı.
//   read    → veri/şema değiştirmez (SELECT, SHOW, EXPLAIN …)
//   session → yalnız oturum durumu (USE, SET, BEGIN/COMMIT …)
//   write   → DML/DDL ya da etkisi bilinmeyen komut (EXEC, CALL …); salt okunur modda onay ister
// Bilinmeyen her şey "write" sayılır: yanlış alarm onay sorar, kaçırılan yazma ise veri bozar.
import type { SqlDialect } from '../provider';
import { tokenize } from './lexer';

export type StatementKind = 'read' | 'session' | 'write';

export interface Classification {
  kind: StatementKind;
  /** Kararı veren anahtar sözcük (örn. "DELETE") — arayüzde gösterilir */
  keyword: string;
}

const READ_FIRST = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'VALUES', 'TABLE', 'SUMMARIZE', 'FROM', 'PRINT', 'HELP', 'CHECKSUM']);
const SESSION_FIRST = new Set(['USE', 'BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'END', 'SAVEPOINT', 'RELEASE', 'DECLARE', 'SET', 'RESET', 'DISCARD', 'FETCH', 'CLOSE', 'DEALLOCATE', 'PREPARE', 'LISTEN', 'UNLISTEN', 'ABORT']);
const DML_IN_CTE = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT']);
// SQL Server partisi içinde (";" zorunlu olmadığından) her yerde aranacak yazma sözcükleri
const MSSQL_STRONG = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'EXEC', 'EXECUTE', 'GRANT', 'REVOKE', 'DENY', 'BACKUP', 'RESTORE', 'DBCC', 'BULK', 'RECONFIGURE', 'SHUTDOWN', 'KILL', 'ENABLE', 'DISABLE']);

interface W { upper: string; depth: number; idx: number }

export function classify(sql: string, d: SqlDialect): Classification {
  const tokens = tokenize(sql, d).filter((t) => t.kind !== 'ws' && t.kind !== 'comment');
  // Parantez derinliği ile birlikte sözcük listesi
  const ws: W[] = [];
  let depth = 0;
  const puncts: { ch: string; depth: number; idx: number }[] = [];
  tokens.forEach((t, idx) => {
    if (t.kind === 'punct') {
      const ch = sql[t.start];
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      puncts.push({ ch, depth, idx });
    } else if (t.kind === 'word') ws.push({ upper: t.upper!, depth, idx });
  });
  if (!ws.length) return { kind: 'read', keyword: '' };

  const first = ws[0].upper;
  const has = (w: string, maxDepth = Infinity) => ws.some((x) => x.upper === w && x.depth <= maxDepth);
  const hasSeq = (a: string, b: string) => ws.some((x, i) => x.upper === a && ws[i + 1]?.upper === b);

  // SQL Server: partinin herhangi bir yerinde yazma sözcüğü
  if (d === 'mssql') {
    const strong = ws.find((x) => MSSQL_STRONG.has(x.upper) && !(x.upper === 'UPDATE' && ws[ws.indexOf(x) - 1]?.upper === 'FOR'));
    if (strong) return { kind: 'write', keyword: strong.upper };
    const into = selectInto(ws, d);
    if (into) return { kind: 'write', keyword: 'INTO' };
  }

  if (first === 'WITH') {
    const dml = ws.find((x) => DML_IN_CTE.has(x.upper));
    if (dml) return { kind: 'write', keyword: dml.upper };
    return selectLike(ws, d, 'WITH');
  }
  if (first === 'SELECT' || first === 'FROM' || first === 'TABLE' || first === 'VALUES') return selectLike(ws, d, first);

  if (first === 'EXPLAIN') {
    const analyze = has('ANALYZE') || has('ANALYSE');
    if (!analyze) return { kind: 'read', keyword: 'EXPLAIN' };
    // EXPLAIN ANALYZE ifadeyi gerçekten çalıştırır: iç ifadeye bak
    const inner = ws.find((x, i) => i > 0 && !['ANALYZE', 'ANALYSE', 'VERBOSE', 'COSTS', 'BUFFERS', 'FORMAT', 'TIMING', 'SUMMARY', 'SETTINGS', 'WAL', 'JSON', 'TEXT', 'XML', 'YAML', 'TRUE', 'FALSE', 'ON', 'OFF', 'QUERY', 'PLAN', 'GENERIC_PLAN', 'MEMORY', 'SERIALIZE'].includes(x.upper));
    if (inner && (inner.upper === 'SELECT' || inner.upper === 'WITH' || inner.upper === 'VALUES' || inner.upper === 'TABLE')) {
      if (inner.upper === 'WITH' && ws.some((x) => DML_IN_CTE.has(x.upper))) return { kind: 'write', keyword: 'EXPLAIN ANALYZE' };
      return { kind: 'read', keyword: 'EXPLAIN' };
    }
    return { kind: 'write', keyword: 'EXPLAIN ANALYZE' };
  }

  if (first === 'PRAGMA') {
    // PRAGMA ad = değer ya da bilinen yazan pragmalar
    const writes = puncts.some((p) => p.ch === '=') || ['OPTIMIZE', 'INCREMENTAL_VACUUM', 'WAL_CHECKPOINT', 'SHRINK_MEMORY'].includes(ws[1]?.upper ?? '');
    return writes ? { kind: 'write', keyword: 'PRAGMA' } : { kind: 'read', keyword: 'PRAGMA' };
  }

  if (first === 'COPY') {
    return hasSeq('TO', 'STDOUT') ? { kind: 'read', keyword: 'COPY' } : { kind: 'write', keyword: 'COPY' };
  }

  if (READ_FIRST.has(first)) return { kind: 'read', keyword: first };

  if (SESSION_FIRST.has(first)) {
    // Salt okunur kipi kapatmaya çalışan oturum komutları yazma sayılır
    if (has('WRITE') || has('DEFAULT_TRANSACTION_READ_ONLY') || has('TRANSACTION_READ_ONLY')) return { kind: 'write', keyword: `${first} … READ WRITE` };
    if (first === 'SET' && (has('GLOBAL') || has('PERSIST') || has('PERSIST_ONLY') || (d === 'mysql' && has('PASSWORD')))) return { kind: 'write', keyword: 'SET GLOBAL' };
    // MSSQL: SET @x = (SELECT …) okumadır; DECLARE @t TABLE yerel değişkendir
    return { kind: 'session', keyword: first };
  }

  return { kind: 'write', keyword: first };
}

function selectInto(ws: W[], d: SqlDialect): boolean {
  // SELECT … INTO yeni_tablo (PG/MSSQL tablo oluşturur); MySQL'de INTO @değişken okumadır, INTO OUTFILE yazmadır
  const i = ws.findIndex((x) => x.upper === 'INTO' && x.depth === 0);
  if (i < 0) return false;
  if (!ws.slice(0, i).some((x) => x.upper === 'SELECT')) return false;
  if (d === 'mysql') return ['OUTFILE', 'DUMPFILE'].includes(ws[i + 1]?.upper ?? '');
  return true;
}

function selectLike(ws: W[], d: SqlDialect, keyword: string): Classification {
  if (selectInto(ws, d)) return { kind: 'write', keyword: 'SELECT INTO' };
  // FOR UPDATE / FOR SHARE kilit alır (PostgreSQL salt okunur işlemde reddeder)
  const lock = ws.findIndex((x, i) => x.upper === 'FOR' && ['UPDATE', 'SHARE', 'NO', 'KEY'].includes(ws[i + 1]?.upper ?? ''));
  if (lock >= 0) return { kind: 'write', keyword: 'FOR UPDATE' };
  if (d === 'mysql' && ws.some((x, i) => x.upper === 'LOCK' && ws[i + 1]?.upper === 'IN')) return { kind: 'write', keyword: 'LOCK IN SHARE MODE' };
  return { kind: 'read', keyword };
}
