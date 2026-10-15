// Çeviri motoru (ana süreç ve pencerelerde ortak). SSH Master / FTP Masters ile aynı yapı:
// yeni metin eklerken "tr" ve "en"e ekleyin; eksik anahtar İngilizceye, o da yoksa anahtarın kendisine düşer.
import { tr } from './locales/tr';
import { en } from './locales/en';
import { fr } from './locales/fr';
import { de } from './locales/de';
import { es } from './locales/es';
import { ar } from './locales/ar';
import { zh } from './locales/zh';
import { ru } from './locales/ru';

// Mastertool ortak standardı: 8 dil, bu sırayla ve kendi adlarıyla
export const LANGUAGES: Record<string, { name: string; dir: 'ltr' | 'rtl' }> = {
  tr: { name: 'Türkçe', dir: 'ltr' },
  en: { name: 'English', dir: 'ltr' },
  fr: { name: 'Français', dir: 'ltr' },
  de: { name: 'Deutsch', dir: 'ltr' },
  es: { name: 'Español', dir: 'ltr' },
  ar: { name: 'العربية', dir: 'rtl' },
  zh: { name: '中文', dir: 'ltr' },
  ru: { name: 'Русский', dir: 'ltr' },
};

export const STRINGS: Record<string, Record<string, string>> = { tr, en, fr, de, es, ar, zh, ru };

export type T = (key: string, vars?: Record<string, string | number>) => string;

export function resolveLanguage(code: string | null | undefined): string {
  const c = String(code || '').toLowerCase().split(/[-_]/)[0];
  return LANGUAGES[c] ? c : 'en';
}

export function createT(lang: string): T {
  const dict = STRINGS[lang] || STRINGS.en;
  return (key, vars) => {
    // Tekil biçim: dilde "<anahtar>_one" varsa ve n = 1 ise o kullanılır (ör. en: "1 connection")
    let s = (vars?.n === 1 ? dict[`${key}_one`] : undefined) ?? dict[key] ?? STRINGS.en[key] ?? key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
    return s;
  };
}
