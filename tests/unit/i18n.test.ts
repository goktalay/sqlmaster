import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tr } from '../../src/shared/locales/tr';
import { en } from '../../src/shared/locales/en';
import { FILTER_OPS } from '../../src/core/sql/gridQuery';

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
}

describe('i18n', () => {
  const used = new Set<string>();
  for (const f of sourceFiles(path.join(__dirname, '../../src'))) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/'((?:auth|res|data)\.[a-zA-Z]+)'/g)) used.add(m[1]);
  }
  for (const f of ['tables', 'views', 'matviews', 'foreign_tables', 'functions', 'procedures', 'triggers', 'sequences', 'types', 'columns', 'indexes', 'constraints']) used.add(`tree.${f}`);
  for (const op of FILTER_OPS) used.add(`op.${op}`);

  it('every key used in code exists in Turkish and English', () => {
    expect([...used].filter((k) => !(k in tr))).toEqual([]);
    expect([...used].filter((k) => !(k in en))).toEqual([]);
  });

  it('Turkish and English have the same keys and placeholders', () => {
    expect(Object.keys(tr).filter((k) => !(k in en))).toEqual([]);
    expect(Object.keys(en).filter((k) => !(k in tr))).toEqual([]);
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    expect(Object.keys(tr).filter((k) => ph(tr[k]) !== ph(en[k]))).toEqual([]);
  });
});
