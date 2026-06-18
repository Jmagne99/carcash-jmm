// ============================================================
// CARCASH · MÓDULO CONSIGNACIONES  (ruta /consignaciones)
// ------------------------------------------------------------
// Unidades tomadas en consignación: muestra al consignante, el
// precio acordado a liquidar, la comisión de la agencia, días en
// stock y estado. Roles: back office / gerente / dueño.
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles } from '../lib/dom.js';
import { navigate } from '../lib/router.js';

const STATUS_CHIP = {
  en_preparacion: 'warn', disponible: 'ok', reservado: 'info',
  vendido: 'info', entregado: '', devuelto: 'danger', baja: 'danger',
};
const local = { units: [], filter: 'activas' };

export async function mount() {
  injectStyles('consig-styles', styles);
  render();
  await load();
  renderUI();
}
export default mount;

async function load() {
  const { data, error } = await supabase
    .from('units')
    .select('id, unit_code, brand, model, year, license_plate, status, location, public_price, minimum_price, consignor_agreed_price, consignor_commission_pct, entered_at, main_photo_url, consignor:contacts!consignor_contact_id(id, full_name, phone)')
    .eq('modality', 'consignacion')
    .is('deleted_at', null)
    .order('entered_at', { ascending: false });
  if (error) { toast('Error cargando consignaciones', error.message, 'error'); local.units = []; return; }
  local.units = data || [];
}

function daysInStock(u) {
  if (!u.entered_at) return 0;
  return Math.floor((Date.now() - new Date(u.entered_at)) / 86400000);
}
function commissionFor(u) {
  // Comisión estimada de la agencia = precio público − a liquidar al consignante.
  // Si hay % de comisión cargado, se usa sobre el precio público.
  if (u.consignor_commission_pct) return (parseFloat(u.public_price) || 0) * (parseFloat(u.consignor_commission_pct) / 100);
  const pub = parseFloat(u.public_price) || 0;
  const liq = parseFloat(u.consignor_agreed_price) || 0;
  return Math.max(0, pub - liq);
}

function render() {
  $('#view').innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">MÓDULO 08 · STOCK</div>
          <div class="page-title">Unidades en <i>consignación</i></div>
          <div class="page-sub" id="con-meta">Cargando…</div>
        </div>
        <div class="page-actions">
          <div class="seg" id="con-filter">
            <button data-f="activas" class="active">Activas</button>
            <button data-f="all">Todas</button>
            <button data-f="vendidas">Vendidas</button>
          </div>
          <button class="btn btn-ghost" id="con-refresh">Actualizar</button>
        </div>
      </div>
      <div class="kpi-grid" id="con-kpis"></div>
    </div>
    <div class="page-body"><div id="con-list"><div class="empty">Cargando…</div></div></div>
  `;
  $('#con-refresh').addEventListener('click', () => mount());
  $('#con-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]'); if (!b) return;
    local.filter = b.dataset.f;
    $$('#con-filter button').forEach(x => x.classList.toggle('active', x === b));
    renderList();
  });
}

function renderUI() { renderKpis(); renderList(); }

function renderKpis() {
  const activas = local.units.filter(u => ['en_preparacion', 'disponible', 'reservado'].includes(u.status));
  const valor = activas.reduce((a, u) => a + (parseFloat(u.public_price) || 0), 0);
  const aLiquidar = activas.reduce((a, u) => a + (parseFloat(u.consignor_agreed_price) || 0), 0);
  const comision = activas.reduce((a, u) => a + commissionFor(u), 0);
  $('#con-meta').innerHTML = `<b>${activas.length}</b> en consignación activa · ${local.units.length} históricas`;
  $('#con-kpis').innerHTML = `
    <div class="kpi-card"><div class="kpi-label">En consignación</div><div class="kpi-value">${activas.length}</div><div class="kpi-sub">unidades activas</div></div>
    <div class="kpi-card"><div class="kpi-label">Valor publicado</div><div class="kpi-value">USD ${escapeHtml(fmt.compact(valor))}</div><div class="kpi-sub">precio de venta</div></div>
    <div class="kpi-card"><div class="kpi-label">A liquidar</div><div class="kpi-value">USD ${escapeHtml(fmt.compact(aLiquidar))}</div><div class="kpi-sub">a consignantes</div></div>
    <div class="kpi-card ok"><div class="kpi-label">Comisión estimada</div><div class="kpi-value">USD ${escapeHtml(fmt.compact(comision))}</div><div class="kpi-sub">margen agencia</div></div>
  `;
}

function filtered() {
  if (local.filter === 'activas') return local.units.filter(u => ['en_preparacion', 'disponible', 'reservado'].includes(u.status));
  if (local.filter === 'vendidas') return local.units.filter(u => ['vendido', 'entregado'].includes(u.status));
  return local.units;
}

function renderList() {
  const host = $('#con-list');
  const rows = filtered();
  if (!rows.length) {
    host.innerHTML = `<div class="empty-rich"><div class="er-icon">⇄</div><div class="er-title">Sin consignaciones</div><div class="er-desc">No hay unidades en consignación para este filtro. Cargá una unidad con modalidad "Consignación" desde Stock.</div></div>`;
    return;
  }
  host.innerHTML = `<div class="con-grid">${rows.map(card).join('')}</div>`;
  host.querySelectorAll('[data-unit]').forEach(c => c.addEventListener('click', () => navigate('/unidades/' + c.dataset.unit)));
}

function card(u) {
  const days = daysInStock(u);
  const stale = days > 30 && ['en_preparacion', 'disponible'].includes(u.status);
  const com = commissionFor(u);
  return `
    <div class="con-card cc-card hoverable" data-unit="${escapeHtml(u.unit_code)}">
      <div class="con-card-hd">
        <div>
          <div class="con-title">${escapeHtml([u.brand, u.model, u.year].filter(Boolean).join(' '))}</div>
          <div class="con-meta"><span class="mono">${escapeHtml(u.unit_code)}</span> · ${escapeHtml(fmt.plate(u.license_plate))}</div>
        </div>
        <span class="chip ${STATUS_CHIP[u.status] || ''}">${escapeHtml(fmt.humanize(u.status))}</span>
      </div>
      <div class="con-consignor">
        <span class="con-lbl">Consignante</span>
        <span class="con-val">${escapeHtml(u.consignor?.full_name || '— sin asignar —')}</span>
        ${u.consignor?.phone ? `<span class="con-phone">${escapeHtml(fmt.phone(u.consignor.phone))}</span>` : ''}
      </div>
      <div class="con-nums">
        <div><span>Precio público</span><b>USD ${escapeHtml(fmt.usd(u.public_price))}</b></div>
        <div><span>A liquidar</span><b>USD ${escapeHtml(fmt.usd(u.consignor_agreed_price))}</b></div>
        <div><span>Comisión est.</span><b class="ok">USD ${escapeHtml(fmt.usd(com))}</b></div>
      </div>
      <div class="con-foot">
        <span class="con-days ${stale ? 'stale' : ''}">${days} días en stock${stale ? ' · rotación lenta' : ''}</span>
        ${u.consignor_commission_pct ? `<span class="chip sm">${escapeHtml(fmt.pct(u.consignor_commission_pct))} comisión</span>` : ''}
      </div>
    </div>
  `;
}

const styles = `
  .con-grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
  @container app (min-width: 760px) { .con-grid { grid-template-columns: 1fr 1fr; } }
  @container app (min-width: 1200px) { .con-grid { grid-template-columns: 1fr 1fr 1fr; } }
  .con-card-hd { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 12px; }
  .con-title { font-family: var(--cc-font-display); font-weight: 400; font-size: 17px; line-height: 1.1; }
  .con-meta { font-size: 11px; color: var(--cc-muted); margin-top: 2px; }
  .con-meta .mono { font-family: var(--cc-font-mono); }
  .con-consignor { background: var(--cc-bg-alt); border-left: 2px solid var(--cc-champagne); padding: 8px 10px; margin-bottom: 12px; }
  .con-lbl { display: block; font-family: var(--cc-font-mono); font-size: 8px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--cc-muted); }
  .con-val { font-weight: 600; font-size: 13px; }
  .con-phone { display: block; font-family: var(--cc-font-mono); font-size: 11px; color: var(--cc-muted); margin-top: 1px; }
  .con-nums { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--cc-line); border: 1px solid var(--cc-line); margin-bottom: 12px; }
  .con-nums > div { background: var(--cc-bg); padding: 8px 8px; }
  .con-nums span { display: block; font-family: var(--cc-font-mono); font-size: 8px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--cc-muted); margin-bottom: 3px; }
  .con-nums b { font-family: var(--cc-font-mono); font-size: 12px; }
  .con-nums b.ok { color: var(--cc-ok); }
  .con-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .con-days { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); letter-spacing: 0.05em; }
  .con-days.stale { color: var(--cc-danger); }
`;
