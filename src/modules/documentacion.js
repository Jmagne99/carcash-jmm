// ============================================================
// CARCASH · MÓDULO DOCUMENTACIÓN  (ruta /documentacion)
// ------------------------------------------------------------
// Control de la documentación de cada unidad: título, cédulas,
// 08, VTV, libre deuda, seguro, etc. Resalta vencidos y por
// vencer. Permite actualizar estado y vencimiento.
// Roles: back office / gerente / dueño (noSeller).
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles } from '../lib/dom.js';
import { navigate } from '../lib/router.js';

const DOC_LABELS = {
  titulo: 'Título', cedula_verde: 'Cédula verde', cedula_azul: 'Cédula azul',
  verificacion_policial: 'Verificación policial', libre_deuda_patentes: 'Libre deuda patentes',
  libre_deuda_multas: 'Libre deuda multas', formulario_08: 'Formulario 08',
  informe_dominio: 'Informe de dominio', vtv: 'VTV', seguro: 'Seguro',
  manual: 'Manual', service_history: 'Historial de service', otro: 'Otro',
};
const STATUS_LABELS = { pendiente: 'Pendiente', en_tramite: 'En trámite', ok: 'OK', vencido: 'Vencido' };
const STATUS_CHIP = { pendiente: 'warn', en_tramite: 'info', ok: 'ok', vencido: 'danger' };

const local = { docs: [], filter: 'all' };

export async function mount() {
  injectStyles('documentacion-styles', styles);
  render();
  await load();
  renderUI();
}
export default mount;

async function load() {
  const { data, error } = await supabase
    .from('unit_documents')
    .select('id, doc_type, status, file_url, expiration_date, notes, unit_id, unit:units!unit_id(unit_code, brand, model, year, license_plate, status)')
    .order('expiration_date', { ascending: true, nullsFirst: false });
  if (error) { toast('Error cargando documentación', error.message, 'error'); local.docs = []; return; }
  // Recalcular "vencido" en cliente por las dudas (si expiró y no está marcado)
  const today = new Date(); today.setHours(0, 0, 0, 0);
  local.docs = (data || []).map(d => {
    const expired = d.expiration_date && new Date(d.expiration_date) < today && d.status !== 'ok';
    const soon = d.expiration_date && !expired && (new Date(d.expiration_date) - today) / 86400000 <= 30;
    return { ...d, _expired: expired || d.status === 'vencido', _soon: soon };
  });
}

function render() {
  $('#view').innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">MÓDULO 10 · OPERACIONES</div>
          <div class="page-title">Documentación de <i>stock</i></div>
          <div class="page-sub" id="doc-meta">Cargando…</div>
        </div>
        <div class="page-actions">
          <div class="seg" id="doc-filter">
            <button data-f="all" class="active">Todos</button>
            <button data-f="vencido">Vencidos</button>
            <button data-f="soon">Por vencer</button>
            <button data-f="pendiente">Pendientes</button>
          </div>
          <button class="btn btn-ghost" id="doc-refresh">Actualizar</button>
        </div>
      </div>
      <div class="kpi-grid" id="doc-kpis"></div>
    </div>
    <div class="page-body"><div id="doc-list"><div class="empty">Cargando…</div></div></div>
  `;
  $('#doc-refresh').addEventListener('click', () => mount());
  $('#doc-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]'); if (!b) return;
    local.filter = b.dataset.f;
    $$('#doc-filter button').forEach(x => x.classList.toggle('active', x === b));
    renderList();
  });
}

function renderUI() { renderKpis(); renderList(); }

function renderKpis() {
  const total = local.docs.length;
  const vencidos = local.docs.filter(d => d._expired).length;
  const soon = local.docs.filter(d => d._soon).length;
  const pend = local.docs.filter(d => d.status === 'pendiente' || d.status === 'en_tramite').length;
  $('#doc-meta').innerHTML = `<b>${total}</b> documentos · <b>${new Set(local.docs.map(d => d.unit_id)).size}</b> unidades`;
  $('#doc-kpis').innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Documentos</div><div class="kpi-value">${total}</div><div class="kpi-sub">en el sistema</div></div>
    <div class="kpi-card ${vencidos ? 'danger' : ''}"><div class="kpi-label">Vencidos</div><div class="kpi-value">${vencidos}</div><div class="kpi-sub">${vencidos ? 'regularizar ya' : 'ninguno'}</div></div>
    <div class="kpi-card ${soon ? 'warn' : ''}"><div class="kpi-label">Por vencer (30d)</div><div class="kpi-value">${soon}</div><div class="kpi-sub">próximos a renovar</div></div>
    <div class="kpi-card ${pend ? 'warn' : ''}"><div class="kpi-label">Pendientes / trámite</div><div class="kpi-value">${pend}</div><div class="kpi-sub">sin completar</div></div>
  `;
}

function filtered() {
  switch (local.filter) {
    case 'vencido': return local.docs.filter(d => d._expired);
    case 'soon': return local.docs.filter(d => d._soon);
    case 'pendiente': return local.docs.filter(d => d.status === 'pendiente' || d.status === 'en_tramite');
    default: return local.docs;
  }
}

function renderList() {
  const host = $('#doc-list');
  const rows = filtered();
  if (!rows.length) {
    host.innerHTML = `<div class="empty-rich"><div class="er-icon">▦</div><div class="er-title">Sin documentos</div><div class="er-desc">No hay documentos para este filtro.</div></div>`;
    return;
  }
  // Agrupar por unidad
  const byUnit = new Map();
  for (const d of rows) {
    const k = d.unit_id;
    if (!byUnit.has(k)) byUnit.set(k, { unit: d.unit, docs: [] });
    byUnit.get(k).docs.push(d);
  }
  host.innerHTML = Array.from(byUnit.values()).map(grpCard).join('');
  host.querySelectorAll('[data-unit]').forEach(b => b.addEventListener('click', () => navigate('/unidades/' + b.dataset.unit)));
  host.querySelectorAll('select[data-doc]').forEach(sel => sel.addEventListener('change', () => updateStatus(sel.dataset.doc, sel.value)));
}

function grpCard(g) {
  const u = g.unit || {};
  return `
    <div class="doc-grp">
      <div class="doc-grp-hd">
        <div>
          <div class="doc-grp-title">${escapeHtml([u.brand, u.model, u.year].filter(Boolean).join(' '))}</div>
          <div class="doc-grp-meta"><span class="mono">${escapeHtml(u.unit_code || '—')}</span> · ${escapeHtml(fmt.plate(u.license_plate))}</div>
        </div>
        <button class="btn btn-ghost btn-sm" data-unit="${escapeHtml(u.unit_code || '')}">Ver unidad →</button>
      </div>
      <div class="cc-table-wrap" style="border:none">
        <table class="cc-table">
          <thead><tr><th>Documento</th><th>Estado</th><th>Vencimiento</th><th>Notas</th></tr></thead>
          <tbody>
            ${g.docs.map(docRow).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function docRow(d) {
  const opts = Object.entries(STATUS_LABELS).map(([k, v]) =>
    `<option value="${k}" ${d.status === k ? 'selected' : ''}>${v}</option>`).join('');
  return `
    <tr class="${d._expired ? 'row-danger' : (d._soon ? 'row-warn' : '')}">
      <td class="t-strong">${escapeHtml(DOC_LABELS[d.doc_type] || d.doc_type)}</td>
      <td><select class="sel sel-status ${STATUS_CHIP[d.status] || ''}" data-doc="${d.id}" style="width:auto;padding:5px 8px;font-size:11px">${opts}</select></td>
      <td>${d.expiration_date ? `<span class="mono">${escapeHtml(fmt.dateShortAR(d.expiration_date))}</span>${d._expired ? ' <span class="chip sm danger">vencido</span>' : (d._soon ? ' <span class="chip sm warn">pronto</span>' : '')}` : '<span class="text-muted">—</span>'}</td>
      <td class="text-muted">${escapeHtml(d.notes || '—')}</td>
    </tr>
  `;
}

async function updateStatus(docId, status) {
  const { error } = await supabase.from('unit_documents').update({ status, updated_at: new Date().toISOString() }).eq('id', docId);
  if (error) { toast('Error', error.message, 'error'); return; }
  toast('Estado actualizado', STATUS_LABELS[status], 'ok');
  await load(); renderUI();
}

const styles = `
  .doc-grp { background: var(--cc-surface); border: 1px solid var(--cc-line); margin-bottom: 16px; }
  .doc-grp-hd { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--cc-line); background: var(--cc-bg-alt); }
  .doc-grp-title { font-family: var(--cc-font-display); font-weight: 400; font-size: 17px; }
  .doc-grp-meta { font-size: 11px; color: var(--cc-muted); margin-top: 2px; }
  .doc-grp-meta .mono { font-family: var(--cc-font-mono); }
  .cc-table .row-danger td { background: var(--cc-danger-soft); }
  .cc-table .row-warn td { background: var(--cc-warn-soft); }
  .sel-status.ok { color: var(--cc-ok); }
  .sel-status.danger { color: var(--cc-danger); }
  .sel-status.warn { color: var(--cc-warn); }
  .sel-status.info { color: var(--cc-info); }
`;
