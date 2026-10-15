// Çeviri motoru (ana süreç ve pencerelerde ortak). SSH Master / FTP Masters ile aynı yapı:
// yeni metin eklerken "tr" ve "en"e ekleyin; eksik anahtar İngilizceye, o da yoksa anahtarın kendisine düşer.
import { tr } from './locales/tr';
import { en } from './locales/en';

export const LANGUAGES: Record<string, { name: string; dir: 'ltr' | 'rtl' }> = {
  tr: { name: 'Türkçe', dir: 'ltr' },
  en: { name: 'English', dir: 'ltr' },
};

export const STRINGS: Record<string, Record<string, string>> = { tr, en };

export type T = (key: string, vars?: Record<string, string | number>) => string;

export function resolveLanguage(code: string | null | undefined): string {
  const c = String(code || '').toLowerCase().split(/[-_]/)[0];
  return LANGUAGES[c] ? c : 'en';
}

export function createT(lang: string): T {
  const dict = STRINGS[lang] || STRINGS.en;
  return (key, vars) => {
    let s = dict[key] ?? STRINGS.en[key] ?? key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
    return s;
  };
}
