import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tr } from '../../src/shared/locales/tr';
import { en } from '../../src/shared/locales/en';
import { FILTER_OPS } from '../../src/core/sql/gridQuery';
import { LANGUAGES, STRINGS, resolveLanguage } from '../../src/shared/i18n';

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

  it('all 8 languages have the same keys, placeholders and tags as English', () => {
    expect(Object.keys(LANGUAGES)).toEqual(['tr', 'en', 'fr', 'de', 'es', 'ar', 'zh', 'ru']);
    const sig = (s: string) => [...[...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(), ...[...s.matchAll(/<\/?\w+>/g)].map((m) => m[0]).sort()].join(',');
    for (const lang of Object.keys(LANGUAGES)) {
      const d = STRINGS[lang];
      expect(Object.keys(en).filter((k) => !(k in d)), lang).toEqual([]);
      expect(Object.keys(d).filter((k) => !(k in en)), lang).toEqual([]);
      expect(Object.keys(en).filter((k) => sig(d[k]) !== sig(en[k]) || !d[k].trim()), lang).toEqual([]);
    }
  });

  it('falls back to English for unsupported system languages', () => {
    expect(resolveLanguage('ar-SA')).toBe('ar');
    expect(resolveLanguage('zh-CN')).toBe('zh');
    expect(resolveLanguage('ja-JP')).toBe('en');
  });
});
