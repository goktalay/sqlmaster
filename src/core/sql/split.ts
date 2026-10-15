// Betiği çalıştırılabilir ifadelere böler.
//  - PostgreSQL / SQLite / DuckDB / MySQL: ";" ile (tırnak, yorum, $$ gövde ve BEGIN…END blokları hariç)
//  - MySQL: "DELIMITER //" satırları desteklenir
//  - SQL Server: yalnızca "GO" satırlarıyla (her parti tek seferde gönderilir)
import type { SqlDialect } from '../provider';
import { tokenize, type Token } from './lexer';

export interface Statement {
  text: string;
  /** Özgün metindeki konum (hata vurgulama ve "imleçteki ifadeyi çalıştır" için) */
  start: number;
  end: number;
}

export function splitStatements(sql: string, d: SqlDialect): Statement[] {
  return d === 'mssql' ? splitBatches(sql) : splitBySemicolon(sql, d);
}

function pushStatement(out: Statement[], sql: string, start: number, end: number, tokens: Token[], from: number, to: number) {
  // Yalnızca yorum/boşluk içeren parçaları atla
  let has = false;
  for (let k = from; k < to; k++) if (tokens[k].kind !== 'ws' && tokens[k].kind !== 'comment') { has = true; break; }
  if (!has) return;
  // Baş/son boşlukları kırp (yorumlar ifadeye dahil kalır)
  while (start < end && /\s/.test(sql[start])) start++;
  while (end > start && /\s/.test(sql[end - 1])) end--;
  out.push({ text: sql.slice(start, end), start, end });
}

function splitBatches(sql: string): Statement[] {
  const tokens = tokenize(sql, 'mssql');
  const out: Statement[] = [];
  let segStart = 0;
  let segTok = 0;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind !== 'word' || t.upper !== 'GO') continue;
    const lineStart = sql.lastIndexOf('\n', t.start - 1) + 1;
    let lineEnd = sql.indexOf('\n', t.end);
    if (lineEnd < 0) lineEnd = sql.length;
    const before = sql.slice(lineStart, t.start);
    const after = sql.slice(t.end, lineEnd).replace(/--.*$/, '');
    if (!/^\s*$/.test(before) || !/^\s*(\d+)?\s*;?\s*$/.test(after)) continue;
    pushStatement(out, sql, segStart, lineStart, tokens, segTok, k);
    segStart = lineEnd;
    while (k + 1 < tokens.length && tokens[k + 1].start < lineEnd) k++;
    segTok = k + 1;
  }
  pushStatement(out, sql, segStart, sql.length, tokens, segTok, tokens.length);
  return out;
}

const BLOCK_CREATE = new Set(['PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT', 'PACKAGE']);
const NOT_BLOCK_AFTER_BEGIN = new Set(['TRANSACTION', 'WORK', 'DEFERRED', 'IMMEDIATE', 'EXCLUSIVE', 'TRAN', 'DISTRIBUTED']);

function splitBySemicolon(sql: string, d: SqlDialect): Statement[] {
  const tokens = tokenize(sql, d);
  const out: Statement[] = [];
  let delimiter = ';';
  let segStart = 0;
  let segTok = 0;
  // BEGIN…END gövdeli CREATE PROCEDURE/FUNCTION/TRIGGER içinde ";" ifadeyi bitirmez
  let words: string[] = [];
  let blockDepth = 0;
  let isBlockCreate = false;

  const nextWord = (k: number): string | undefined => {
    for (let j = k + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.kind === 'ws' || t.kind === 'comment') continue;
      return t.kind === 'word' ? t.upper : sql.slice(t.start, t.end);
    }
    return undefined;
  };

  const resetSeg = (endPos: number, nextTok: number) => {
    segStart = endPos;
    segTok = nextTok;
    words = [];
    blockDepth = 0;
    isBlockCreate = false;
  };

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind === 'ws' || t.kind === 'comment' || t.kind === 'string' || t.kind === 'qident') continue;

    // MySQL istemci komutu: DELIMITER <ayraç> (satır başında, ifade dışında)
    if (d === 'mysql' && t.kind === 'word' && t.upper === 'DELIMITER' && words.length === 0) {
      const lineStart = sql.lastIndexOf('\n', t.start - 1) + 1;
      if (/^\s*$/.test(sql.slice(lineStart, t.start))) {
        let lineEnd = sql.indexOf('\n', t.end);
        if (lineEnd < 0) lineEnd = sql.length;
        const delim = sql.slice(t.end, lineEnd).trim();
        if (delim) delimiter = delim;
        let j = k;
        while (j + 1 < tokens.length && tokens[j + 1].start < lineEnd) j++;
        resetSeg(lineEnd, j + 1);
        k = j;
        continue;
      }
    }

    if (t.kind === 'word') {
      const w = t.upper!;
      if (words.length < 8) {
        words.push(w);
        if (words[0] === 'CREATE' && BLOCK_CREATE.has(w)) isBlockCreate = true;
      }
      if (isBlockCreate && delimiter === ';') {
        if (w === 'BEGIN') {
          const nw = nextWord(k);
          if (!(nw && (NOT_BLOCK_AFTER_BEGIN.has(nw) || nw === ';'))) blockDepth++;
        } else if (w === 'CASE' && blockDepth > 0) {
          blockDepth++;
        } else if (w === 'END' && blockDepth > 0) {
          const nw = nextWord(k);
          if (!(nw && ['IF', 'LOOP', 'WHILE', 'REPEAT', 'FOR'].includes(nw))) blockDepth--;
        }
      }
      continue;
    }

    // Ayraç kontrolü
    if (delimiter === ';') {
      if (t.kind === 'punct' && sql[t.start] === ';' && blockDepth === 0) {
        pushStatement(out, sql, segStart, t.start, tokens, segTok, k);
        resetSeg(t.end, k + 1);
      }
    } else if (sql.startsWith(delimiter, t.start)) {
      const endPos = t.start + delimiter.length;
      pushStatement(out, sql, segStart, t.start, tokens, segTok, k);
      let j = k;
      while (j + 1 < tokens.length && tokens[j + 1].start < endPos) j++;
      resetSeg(endPos, j + 1);
      k = j;
    }
  }
  pushStatement(out, sql, segStart, sql.length, tokens, segTok, tokens.length);
  return out;
}

/** İmlecin bulunduğu ifade (Ctrl+Enter seçim yoksa) */
export function statementAt(sql: string, d: SqlDialect, pos: number): Statement | null {
  const list = splitStatements(sql, d);
  if (!list.length) return null;
  for (const s of list) if (pos >= s.start && pos <= s.end) return s;
  // İfadeler arasındaysa: bir önceki ifade
  let best: Statement | null = null;
  for (const s of list) if (s.end <= pos) best = s;
  return best ?? list[0];
}
