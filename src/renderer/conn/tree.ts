// Nesne ağacı: sunucu → veritabanı → şema → klasörler (tablolar, görünümler, fonksiyonlar…) → nesneler → kolonlar.
// Alt düğümler yalnızca genişletilince yüklenir. Çift tıklama: tablo/görünüm → veri, kod nesnesi → editör.
import type { TreeNode, NodeKind } from '../../core/provider';
import { qualified } from '../../core/sql/dialect';
import { api } from '../lib/api';
import { $, contextMenu, esc, h, icon, t, toast } from '../lib/ui';
import type { Ctx } from './context';

export const TABLE_DND = 'application/x-sqlm-table';

const KIND_ICON: Partial<Record<NodeKind, string>> = {
  server: 'server', database: 'database', schema: 'schema', folder: 'folder', table: 'table', view: 'view', matview: 'matview',
  'foreign-table': 'table', function: 'func', procedure: 'proc', trigger: 'trigger', sequence: 'sequence', type: 'type',
  index: 'index', column: 'column', constraint: 'constraint', file: 'file2',
};

const FOLDER_ICON: Record<string, string> = {
  tables: 'table', views: 'view', matviews: 'matview', foreign_tables: 'table', functions: 'func', procedures: 'proc', triggers: 'trigger',
  sequences: 'sequence', types: 'type', columns: 'column', indexes: 'index', constraints: 'constraint', files: 'file2',
};

interface Item {
  node: TreeNode;
  depth: number;
  expanded: boolean;
  loading: boolean;
  children: Item[] | null;
  el: HTMLElement;
  parent: Item | null;
}

export class ObjectTree {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private roots: Item[] = [];
  private selected: Item | null = null;
  private filter = '';

  constructor(private ctx: Ctx) {
    this.el = h(`<div class="tree-panel">
      <div class="panel-head"><span class="panel-ico">${icon('database')}</span><span class="panel-title">${esc(t('cw.objects'))}</span>
        <div class="panel-actions"><button class="icon-btn" data-a="collapse" title="${esc(t('cw.collapseAll'))}">${icon('rows')}</button>
        <button class="icon-btn" data-a="refresh" title="${esc(t('common.refresh'))}">${icon('refresh')}</button></div></div>
      <div class="path-bar"><input class="path-input tree-filter" placeholder="${esc(t('cw.filterPh'))}" spellcheck="false"></div>
      <div class="tree-list" tabindex="0"></div>
    </div>`);
    this.list = $('.tree-list', this.el);
    $('[data-a="refresh"]', this.el).onclick = () => void this.reload();
    $('[data-a="collapse"]', this.el).onclick = () => { for (const r of this.roots) this.collapse(r); };
    $<HTMLInputElement>('.tree-filter', this.el).addEventListener('input', (e) => {
      this.filter = (e.target as HTMLInputElement).value.trim().toLowerCase();
      this.applyFilter();
    });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
  }

  async reload() {
    this.list.innerHTML = `<div class="empty-note"><span class="spin" style="display:inline-block;color:var(--accent)"></span></div>`;
    try {
      const nodes = await api.dbChildren(null);
      this.list.innerHTML = '';
      this.roots = nodes.map((n) => this.makeItem(n, 0, null));
      for (const r of this.roots) this.list.appendChild(r.el);
      // Tek veritabanı ya da varsayılan veritabanı: otomatik aç
      const first = this.roots.find((r) => r.node.name === this.ctx.defaultDatabase) ?? (this.roots.length === 1 ? this.roots[0] : null);
      if (first) {
        await this.expand(first);
        const sch = first.children?.find((c) => c.node.kind === 'schema' && ['public', 'dbo', 'main'].includes(c.node.name)) ?? (first.children?.length === 1 ? first.children[0] : null);
        if (sch) await this.expand(sch);
      }
      this.ctx.databases = nodes.filter((n) => n.kind === 'database').map((n) => n.name);
    } catch (e) {
      this.list.innerHTML = `<div class="empty-note err">${esc((e as Error).message)}</div>`;
    }
  }

  private makeItem(node: TreeNode, depth: number, parent: Item | null): Item {
    const ic = node.kind === 'folder' ? FOLDER_ICON[node.path.folder ?? ''] ?? 'folder' : KIND_ICON[node.kind] ?? 'file2';
    const el = h(`<div class="tnode">
      <div class="trow k-${node.kind}" style="padding-inline-start:${6 + depth * 14}px" draggable="${['table', 'view', 'matview', 'foreign-table'].includes(node.kind)}">
        <span class="tchev">${node.hasChildren ? icon('chevronRight') : ''}</span>
        <span class="tico">${icon(ic)}</span>
        <span class="tname">${esc(node.kind === 'folder' ? t(`tree.${node.path.folder}`) : node.name)}</span>
        ${node.count !== undefined ? `<span class="tcount">${node.count}</span>` : ''}
        ${node.detail ? `<span class="tdetail">${esc(node.detail)}</span>` : ''}
      </div>
      <div class="tkids"></div>
    </div>`);
    const item: Item = { node, depth, expanded: false, loading: false, children: null, el, parent };
    const row = $('.trow', el);
    row.title = node.detail ? `${node.name} — ${node.detail}` : node.name;
    row.addEventListener('click', (e) => {
      this.select(item);
      if ((e.target as HTMLElement).closest('.tchev')) void this.toggle(item);
    });
    row.addEventListener('dblclick', () => this.activate(item));
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.select(item); this.menu(item, e.clientX, e.clientY); });
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer!.setData(TABLE_DND, JSON.stringify(node));
      e.dataTransfer!.setData('text/plain', this.qualifiedName(node));
      e.dataTransfer!.effectAllowed = 'copy';
    });
    return item;
  }

  private select(item: Item) {
    this.selected?.el.firstElementChild!.classList.remove('sel');
    this.selected = item;
    item.el.firstElementChild!.classList.add('sel');
  }

  private async toggle(item: Item) {
    if (item.expanded) this.collapse(item);
    else await this.expand(item);
  }

  private collapse(item: Item) {
    item.expanded = false;
    item.el.classList.remove('open');
    item.children?.forEach((c) => c.expanded && this.collapse(c));
  }

  async expand(item: Item, force = false) {
    if (!item.node.hasChildren || item.loading) return;
    item.expanded = true;
    item.el.classList.add('open');
    if (item.children && !force) return;
    item.loading = true;
    const kids = $('.tkids', item.el);
    kids.innerHTML = `<div class="tloading" style="padding-inline-start:${26 + (item.depth + 1) * 14}px"><span class="spin"></span></div>`;
    try {
      const nodes = await api.dbChildren(item.node);
      item.children = nodes.map((n) => this.makeItem(n, item.depth + 1, item));
      kids.innerHTML = '';
      if (!nodes.length) kids.appendChild(h(`<div class="tempty" style="padding-inline-start:${26 + (item.depth + 1) * 14}px">${esc(t('cw.empty'))}</div>`));
      for (const c of item.children) kids.appendChild(c.el);
      this.applyFilter();
    } catch (e) {
      kids.innerHTML = `<div class="tempty err" style="padding-inline-start:${26 + (item.depth + 1) * 14}px">${esc((e as Error).message)}</div>`;
      item.children = null;
    } finally {
      item.loading = false;
    }
  }

  private activate(item: Item) {
    const n = item.node;
    if (n.openAs === 'data') this.ctx.openData(n);
    else if (n.openAs === 'code') this.ctx.openCode(n);
    else void this.toggle(item);
  }

  qualifiedName(n: TreeNode) {
    return qualified({ database: this.ctx.dialect === 'mssql' && n.path.database !== this.ctx.defaultDatabase ? n.path.database : undefined, schema: n.path.schema, name: n.path.name ?? n.name }, this.ctx.dialect);
  }

  private menu(item: Item, x: number, y: number) {
    const n = item.node;
    const isRel = ['table', 'view', 'matview', 'foreign-table'].includes(n.kind);
    const hasDdl = n.openAs === 'code' || isRel;
    contextMenu(x, y, [
      isRel && { label: t('cw.openData'), icon: 'table', action: () => this.ctx.openData(n) },
      hasDdl && { label: isRel ? t('cw.showDdl') : t('cw.openCode'), icon: 'code', action: () => this.ctx.openCode(n) },
      isRel && { label: t('cw.selectSql'), icon: 'sql', action: () => this.ctx.openSql(`SELECT *\nFROM ${this.qualifiedName(n)}`, n.path.database) },
      isRel && { label: t('cw.addToBuilder'), icon: 'builder', action: () => this.ctx.openBuilder(n) },
      isRel && { label: t('rep.fromTable'), icon: 'report', action: () => this.ctx.addReport(n) },
      (n.kind === 'database' || n.kind === 'schema') && { label: t('cw.newSqlHere'), icon: 'sql', action: () => this.ctx.openSql('', n.path.database) },
      '-',
      { label: t('cw.copyName'), icon: 'copy', action: () => { void api.clipboardWrite(isRel || n.openAs ? this.qualifiedName(n) : n.name); toast(t('cw.copied'), { type: 'ok' }); } },
      n.hasChildren && { label: t('common.refresh'), icon: 'refresh', action: () => void this.expand(item, true) },
    ]);
  }

  private onKey(e: KeyboardEvent) {
    const s = this.selected;
    if (!s) return;
    if (e.key === 'Enter') this.activate(s);
    if (e.key === 'ArrowRight') void this.expand(s);
    if (e.key === 'ArrowLeft') { if (s.expanded) this.collapse(s); else if (s.parent) this.select(s.parent); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const rows = [...this.list.querySelectorAll<HTMLElement>('.trow')].filter((r) => r.offsetParent !== null);
      const i = rows.indexOf(s.el.firstElementChild as HTMLElement);
      const next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) (next as HTMLElement).click();
    }
  }

  /** Yüklenmiş düğümlerde ada göre süz (eşleşenin ataları görünür kalır) */
  private applyFilter() {
    const f = this.filter;
    const walk = (items: Item[]): boolean => {
      let any = false;
      for (const it of items) {
        const self = !f || it.node.name.toLowerCase().includes(f);
        const kids = it.children ? walk(it.children) : false;
        const show = self || kids;
        it.el.classList.toggle('hidden', !show);
        if (f && kids && !it.expanded) it.el.classList.add('open');
        else if (!f) it.el.classList.toggle('open', it.expanded);
        any ||= show;
      }
      return any;
    };
    walk(this.roots);
  }
}
