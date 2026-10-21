// Bağlantı penceresinde "Raporlar" bölümü (ağacın üstünde) ve "Rapor ekle" sihirbazı:
// şablon (liste, gruplu döküm, özet, kartlar, boş) + tablo seç → baskıya hazır örnek sorguyla rapor oluşur.
import type { NodePath, TreeNode } from '../../core/provider';
import { emptyReport, type ReportDef } from '../../core/report/model';
import { buildTemplate, TEMPLATE_IDS, type TemplateId } from '../../core/report/templates';
import { LANGUAGES } from '../../shared/i18n';
import type { RenderOptions } from '../../core/report/render';
import { api } from '../lib/api';
import { $, $$, confirmBox, contextMenu, esc, h, icon, LANG, openModal, t, toast, uid } from '../lib/ui';
import type { Ctx } from './context';

const TPL_ICON: Record<TemplateId, string> = { list: 'rows', grouped: 'columns', summary: 'sigma', cards: 'label', blank: 'file2' };

export function renderStrings(): RenderOptions['strings'] {
  return {
    page: t('rep.r.page'), printed: t('rep.r.printed'), total: t('rep.r.total'), subtotal: t('rep.r.subtotal'),
    rows: t('rep.r.rows'), truncated: t('rep.r.truncated'), empty: t('rep.r.empty'), count: t('rep.r.count'),
  };
}

export const renderBase = () => ({ locale: LANG, dir: LANGUAGES[LANG]?.dir ?? 'ltr', strings: renderStrings() });

// --- Panel ------------------------------------------------------------------------------
export class ReportsPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private reports: ReportDef[] = [];

  constructor(private ctx: Ctx) {
    this.el = h(`<div class="rep-panel">
      <div class="panel-head"><span class="panel-ico">${icon('report')}</span><span class="panel-title">${esc(t('rep.reports'))}</span>
        <div class="panel-actions"><button class="icon-btn" data-a="add" title="${esc(t('rep.add'))}">${icon('plus')}</button>
        <button class="icon-btn rep-toggle" data-a="toggle">${icon('chevronDown')}</button></div></div>
      <div class="rep-list"></div>
    </div>`);
    this.list = $('.rep-list', this.el);
    $('[data-a="add"]', this.el).onclick = () => ctx.addReport();
    $('[data-a="toggle"]', this.el).onclick = () => this.el.classList.toggle('collapsed');
  }

  async reload() {
    try { this.reports = await api.reportList(); } catch { this.reports = []; }
    this.render();
  }

  private render() {
    this.list.innerHTML = '';
    $('.panel-title', this.el).textContent = this.reports.length ? `${t('rep.reports')} (${this.reports.length})` : t('rep.reports');
    for (const r of this.reports) {
      const row = h(`<div class="rep-item" title="${esc(r.name)}">${icon('report')}<span>${esc(r.name)}</span><small>${esc(t(`rep.layout.${r.layout}`))}</small></div>`);
      row.onclick = () => this.ctx.openReport(r);
      row.oncontextmenu = (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: t('common.open'), icon: 'open', action: () => this.ctx.openReport(r) },
          '-',
          { label: t('rep.delete'), icon: 'trash', danger: true, action: () => void this.remove(r) },
        ]);
      };
      this.list.appendChild(row);
    }
    const add = h(`<button class="rep-add">${icon('plus')}<span>${esc(t('rep.add'))}</span></button>`);
    add.onclick = () => this.ctx.addReport();
    this.list.appendChild(add);
  }

  async remove(r: ReportDef): Promise<boolean> {
    if (!(await confirmBox(t('rep.delete'), esc(t('rep.deleteMsg', { name: r.name }))))) return false;
    await api.reportDelete(r.id);
    this.ctx.closeTab(`report:${r.id}`);
    await this.reload();
    return true;
  }
}

// --- Sihirbaz ---------------------------------------------------------------------------
interface TableItem { schema: string; name: string }

export async function openReportWizard(ctx: Ctx, preset?: TreeNode): Promise<ReportDef | null> {
  const schema = await ctx.completion(ctx.defaultDatabase);
  const tables: TableItem[] = Object.entries(schema?.tables ?? {}).flatMap(([s, ts]) => Object.keys(ts).map((name) => ({ schema: s, name })));
  const presetItem: TableItem | null = preset ? { schema: (ctx.dialect === 'mysql' ? preset.path.database : preset.path.schema) ?? '', name: preset.path.name ?? preset.name } : null;
  let tpl = (presetItem ? 'grouped' : 'list') as TemplateId;
  let chosen: TableItem | null = presetItem ?? null;

  const body = h(`<div class="rw">
    <div class="field"><label>${esc(t('rep.chooseTemplate'))}</label><div class="rw-tpls">${TEMPLATE_IDS.map((id) => `
      <button class="rw-tpl" data-t="${id}">${icon(TPL_ICON[id])}<b>${esc(t(`rep.tpl.${id}`))}</b><span>${esc(t(`rep.tpl.${id}Desc`))}</span></button>`).join('')}</div></div>
    <div class="field rw-table"><label>${esc(t('rep.chooseTable'))}</label>
      <input class="input" id="rwq" placeholder="${esc(t('cw.filterPh'))}" spellcheck="false"><div class="pick-list rw-list"></div></div>
    <div class="field"><label>${esc(t('rep.name'))}</label><input class="input" id="rwName" maxlength="200"></div>
  </div>`);
  const list = $('.rw-list', body);
  const nameInput = $<HTMLInputElement>('#rwName', body);
  let nameTouched = false;
  nameInput.oninput = () => (nameTouched = true);
  const autoName = () => {
    if (nameTouched) return;
    nameInput.value = chosen && tpl !== 'blank' ? `${t(`rep.tpl.${tpl}`)} — ${chosen.name}` : t(`rep.tpl.${tpl}`);
  };
  const paintTpl = () => $$('.rw-tpl', body).forEach((b) => b.classList.toggle('on', b.dataset.t === tpl));
  const draw = (q: string) => {
    list.innerHTML = '';
    for (const it of tables.filter((x) => `${x.schema}.${x.name}`.toLowerCase().includes(q)).slice(0, 400)) {
      const on = chosen && chosen.schema === it.schema && chosen.name === it.name;
      const row = h(`<div class="pick-item ${on ? 'on' : ''}">${icon('table')}<span>${esc(it.name)}</span><small>${esc(it.schema)}</small></div>`);
      row.onclick = () => { chosen = it; $$('.pick-item', list).forEach((x) => x.classList.toggle('on', x === row)); autoName(); };
      list.appendChild(row);
    }
    if (!list.children.length) list.innerHTML = `<div class="empty-note">${esc(t('rep.noTables'))}</div>`;
  };
  $$('.rw-tpl', body).forEach((b) => (b.onclick = () => { tpl = b.dataset.t as TemplateId; paintTpl(); autoName(); }));
  $<HTMLInputElement>('#rwq', body).addEventListener('input', (e) => draw((e.target as HTMLInputElement).value.toLowerCase()));
  paintTpl();
  draw('');
  autoName();

  const ok = await openModal<boolean>({
    title: t('rep.wizardTitle'), iconName: 'report', body, width: 720,
    buttons: [{ label: t('common.cancel'), value: false }, { label: t('rep.create'), cls: 'primary', icon: 'check', value: true }],
    onMount: () => setTimeout(() => list.querySelector('.pick-item.on')?.scrollIntoView({ block: 'center' }), 0),
  });
  if (!ok) return null;
  if (tpl !== 'blank' && !chosen) { toast(t('rep.needTable'), { type: 'err' }); return openReportWizard(ctx, preset); }

  const isMy = ctx.dialect === 'mysql';
  const path: NodePath | null = chosen ? (isMy ? { database: chosen.schema, name: chosen.name } : { database: ctx.defaultDatabase, schema: chosen.schema || undefined, name: chosen.name }) : null;
  let columns: Awaited<ReturnType<typeof api.dbColumns>> = [];
  if (path && tpl !== 'blank') {
    try { columns = await api.dbColumns(path); } catch (e) { toast((e as Error).message, { type: 'err' }); return null; }
  }
  const tableRef = chosen ? (isMy ? { database: chosen.schema, name: chosen.name } : { schema: chosen.schema || undefined, name: chosen.name }) : null;
  const built = buildTemplate(tpl, { dialect: ctx.dialect, table: tableRef, columns, t });
  const name = nameInput.value.trim() || t(`rep.tpl.${tpl}`);
  const def: ReportDef = {
    ...emptyReport({ id: uid(), connectionId: ctx.conn.id, name }),
    ...built,
    database: isMy ? undefined : ctx.defaultDatabase,
    title: name,
    subtitle: ctx.conn.name,
    template: tpl,
  };
  return api.reportSave({ ...def, id: undefined });
}
