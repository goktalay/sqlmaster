// CodeMirror 6 tabanlı SQL editörü: sözdizimi renklendirme, lehçeye göre anahtar sözcükler,
// şema/tablo/kolon otomatik tamamlama, Ctrl+Enter ile çalıştırma. Renkler CSS değişkenlerinden: gece/gündüz uyumlu.
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder as cmPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { sql, PostgreSQL, MSSQL, MySQL, SQLite, StandardSQL, type SQLDialect } from '@codemirror/lang-sql';
import { tags } from '@lezer/highlight';
import type { CompletionSchema, SqlDialect } from '../../core/provider';
import { statementAt } from '../../core/sql/split';

const DIALECTS: Record<SqlDialect, SQLDialect> = { postgres: PostgreSQL, mssql: MSSQL, mysql: MySQL, sqlite: SQLite, duckdb: PostgreSQL };

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--editor-bg)', color: 'var(--syn-name)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '6px 0' },
  '.cm-gutters': { backgroundColor: 'var(--editor-gutter)', color: 'var(--text-3)', border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'var(--editor-active)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--editor-active)', color: 'var(--text-2)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--editor-sel) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-matchingBracket': { backgroundColor: 'rgba(34, 211, 238, .18)', outline: '1px solid rgba(34, 211, 238, .4)' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(251, 191, 36, .15)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface-2)', border: '1px solid var(--border-strong)', borderRadius: '8px', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px !important', fontFamily: 'var(--mono)', fontSize: '12.5px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--surface-3)', color: 'var(--text)' },
  '.cm-completionDetail': { color: 'var(--text-3)', fontStyle: 'normal', marginLeft: '10px' },
  '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--text)', borderTop: '1px solid var(--border)' },
  '.cm-panel input, .cm-panel button': { fontSize: '12px' },
  '.cm-placeholder': { color: 'var(--text-3)' },
  '.cm-errorLine': { backgroundColor: 'rgba(248, 113, 113, .12)' },
});

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--syn-keyword)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syn-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syn-number)' },
  { tag: [tags.lineComment, tags.blockComment, tags.comment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--syn-type)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.name)], color: 'var(--syn-func)' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: 'var(--syn-op)' },
  { tag: [tags.special(tags.name), tags.quote, tags.labelName], color: 'var(--syn-special)' },
  { tag: tags.name, color: 'var(--syn-name)' },
]);

export interface SqlEditor {
  view: EditorView;
  getText(): string;
  setText(text: string): void;
  /** Seçim varsa seçili metin, yoksa tüm metin (Ctrl+Enter) */
  selectionOrAll(): { text: string; offset: number };
  /** İmlecin bulunduğu ifade (Ctrl+Shift+Enter) */
  currentStatement(): { text: string; offset: number } | null;
  setSchema(schema: CompletionSchema | null): void;
  setFontSize(px: number): void;
  markError(from: number, to: number): void;
  focus(): void;
  destroy(): void;
}

export interface EditorOptions {
  doc?: string;
  dialect: SqlDialect;
  readOnly?: boolean;
  fontSize?: number;
  placeholder?: string;
  lineNumbers?: boolean;
  onRun?: (mode: 'auto' | 'statement' | 'all') => void;
  onChange?: (text: string) => void;
}

export function createSqlEditor(parent: HTMLElement, o: EditorOptions): SqlEditor {
  const lang = new Compartment();
  const fontSize = new Compartment();
  const ro = new Compartment();
  const langExt = (schema: CompletionSchema | null): Extension =>
    sql({ dialect: DIALECTS[o.dialect] ?? StandardSQL, upperCaseKeywords: false, schema: schema?.tables as never, defaultSchema: schema?.defaultSchema });
  const fontExt = (px: number) => EditorView.theme({ '.cm-scroller': { fontSize: `${px}px` } });

  const runKeys = o.onRun
    ? keymap.of([
        { key: 'Mod-Enter', run: () => { o.onRun!('auto'); return true; } },
        { key: 'Shift-Mod-Enter', run: () => { o.onRun!('statement'); return true; } },
        { key: 'F5', run: () => { o.onRun!('all'); return true; } },
      ])
    : [];

  const state = EditorState.create({
    doc: o.doc ?? '',
    extensions: [
      runKeys,
      o.lineNumbers === false ? [] : [lineNumbers(), highlightActiveLineGutter()],
      highlightActiveLine(),
      drawSelection(),
      history(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ activateOnTyping: true, icons: false }),
      highlightSelectionMatches(),
      search({ top: true }),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
      lang.of(langExt(null)),
      fontSize.of(fontExt(o.fontSize ?? 13)),
      ro.of(EditorState.readOnly.of(!!o.readOnly)),
      o.placeholder ? cmPlaceholder(o.placeholder) : [],
      theme,
      syntaxHighlighting(highlight),
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => { if (u.docChanged) o.onChange?.(u.state.doc.toString()); }),
    ],
  });
  const view = new EditorView({ state, parent });

  return {
    view,
    getText: () => view.state.doc.toString(),
    setText(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    selectionOrAll() {
      const sel = view.state.selection.main;
      if (!sel.empty) return { text: view.state.sliceDoc(sel.from, sel.to), offset: sel.from };
      return { text: view.state.doc.toString(), offset: 0 };
    },
    currentStatement() {
      const sel = view.state.selection.main;
      if (!sel.empty) return { text: view.state.sliceDoc(sel.from, sel.to), offset: sel.from };
      const st = statementAt(view.state.doc.toString(), o.dialect, sel.head);
      return st ? { text: st.text, offset: st.start } : null;
    },
    setSchema(schema) {
      view.dispatch({ effects: lang.reconfigure(langExt(schema)) });
    },
    setFontSize(px) {
      view.dispatch({ effects: fontSize.reconfigure(fontExt(px)) });
    },
    markError(from, to) {
      const len = view.state.doc.length;
      const a = Math.max(0, Math.min(from, len));
      const b = Math.max(a, Math.min(to, len));
      view.dispatch({ selection: { anchor: a, head: b }, scrollIntoView: true });
      view.focus();
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
