// ============================================================
// CARCASH · MÓDULO COBROS  (ruta /cobros)
// ------------------------------------------------------------
// Seguimiento de cobranzas: para cada venta muestra el precio,
// lo cobrado (suma de payments) y el saldo pendiente. Permite
// registrar pagos. Roles: back office / gerente / dueño.
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { state, currentUserId } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles } from '../lib/dom.js';
import { navigate } from '../lib/router.js';

const PAY_METHODS = [
  ['transferencia', 'Transferencia'], ['efectivo', 'Efectivo'],
  ['cheque', 'Cheque'], ['tarjeta', 'Tarjeta'], ['financiacion', 'Financiación'], ['otro', 'Otro'],
];
const local = { sales: [], payments: new Map(), filter: 'pendiente' };

export async function mount() {
  injectStyles('cobros-styles', styles);
  render();
  await load();
  renderUI();
}
export default mount;

async function load() {
  const { data: sales, error } = await supabase
    .from('sales')
    .select('id, sale_code, sale_price, deposit_amount, status, created_at, signed_at, unit:units!unit_id(unit_code, brand, model, year), buyer:contacts!buyer_contact_id(full_name), seller:users_profile!seller_user_id(full_name)')
    .neq('status', 'cancelada')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) { toast('Error cargando ventas', error.message, 'error'); local.sales = []; return; }
  local.sales = sales || [];

  const ids = local.sales.map(s => s.id);
  local.payments = new Map();
  if (ids.length) {
    const { data: pays } = await supabase
      .from('payments')
      .select('id, sale_id, amount, payment_method, reference, paid_at, notes')
      .in('sale_id', ids)
      .order('paid_at', { ascending: false });
    for (const p of pays || []) {
      if (!local.payments.has(p.sale_id)) local.payments.set(p.sale_id, []);
      local.payments.get(p.sale_id).push(p);
    }
  }
}

function paidFor(saleId) {
  return (local.payments.get(saleId) || []).reduce((a, p) => a + (parseFloat(p.amount) || 0), 0);
}
function balanceFor(s) { return (parseFloat(s.sale_price) || 0) - paidFor(s.id); }

function render() {
  $('#view').innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">MÓDULO 11 · OPERACIONES</div>
          <div class="page-title">Cobros &amp; <i>cobranzas</i></div>
          <div class="page-sub" id="cob-meta">Cargando…</div>
        </div>
        <div class="page-actions">
          <div class="seg" id="cob-filter">
            <button data-f="pendiente" class="active">Con saldo</button>
            <button data-f="all">Todas</button>
            <button data-f="completo">Saldadas</button>
          </div>
          <button class="btn btn-ghost" id="cob-refresh">Actualizar</button>
        </div>
      </div>
      <div class="kpi-grid" id="cob-kpis"></div>
    </div>
    <div class="page-body"><div id="cob-list"><div class="empty">Cargando…</div></div></div>
  `;
  $('#cob-refresh').addEventListener('click', () => mount());
  $('#cob-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]'); if (!b) return;
    local.filter = b.dataset.f;
    $$('#cob-filter button').forEach(x => x.classList.toggle('active', x === b));
    renderList();
  });
}

function renderUI() { renderKpis(); renderList(); }

function renderKpis() {
  const totalPrice = local.sales.reduce((a, s) => a + (parseFloat(s.sale_price) || 0), 0);
  const totalPaid = local.sales.reduce((a, s) => a + paidFor(s.id), 0);
  const balance = totalPrice - totalPaid;
  const withBalance = local.sales.filter(s => balanceFor(s) > 0.5).length;
  $('#cob-meta').innerHTML = `<b>${local.sales.length}</b> operaciones activas`;
  $('#cob-kpis').innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Facturado</div><div class="kpi-value">USD ${escapeHtml(fmt.compact(totalPrice))}</div><div class="kpi-sub">total operaciones</div></div>
    <div class="kpi-card ok"><div class="kpi-label">Cobrado</div><div class="kpi-value">USD ${escapeHtml(fmt.compact(totalPaid))}</div><div class="kpi-sub">${totalPrice ? fmt.pct(totalPaid / totalPrice) : '—'} del total</div></div>
    <div class="kpi-card ${balance > 0.5 ? 'danger' : ''}"><div class="kpi-label">Saldo pendiente</div><div class="kpi-value">USD ${escapeHtml(fmt.compact(balance))}</div><div class="kpi-sub">por cobrar</div></div>
    <div class="kpi-card ${withBalance ? 'warn' : ''}"><div class="kpi-label">Con saldo</div><div class="kpi-value">${withBalance}</div><div class="kpi-sub">operaciones</div></div>
  `;
}

function filtered() {
  if (local.filter === 'pendiente') return local.sales.filter(s => balanceFor(s) > 0.5);
  if (local.filter === 'completo') return local.sales.filter(s => balanceFor(s) <= 0.5);
  return local.sales;
}

function renderList() {
  const host = $('#cob-list');
  const rows = filtered();
  if (!rows.length) {
    const msg = local.sales.length
      ? 'No hay operaciones para este filtro.'
      : 'Todavía no hay ventas cargadas. Las cobranzas aparecen acá cuando se registra una venta.';
    host.innerHTML = `<div class="empty-rich"><div class="er-icon">$</div><div class="er-title">Sin cobros</div><div class="er-desc">${msg}</div></div>`;
    return;
  }
  host.innerHTML = rows.map(saleCard).join('');
  host.querySelectorAll('[data-pay]').forEach(b => b.addEventListener('click', () => openPaymentModal(b.dataset.pay)));
}

function saleCard(s) {
  const paid = paidFor(s.id);
  const bal = balanceFor(s);
  const price = parseFloat(s.sale_price) || 0;
  const pct = price ? Math.min(100, (paid / price) * 100) : 0;
  const u = s.unit || {};
  const pays = local.payments.get(s.id) || [];
  return `
    <div class="cob-card">
      <div class="cob-hd">
        <div>
          <div class="cob-title">${escapeHtml([u.brand, u.model, u.year].filter(Boolean).join(' ') || 'Unidad')}</div>
          <div class="cob-sub"><span class="mono">${escapeHtml(s.sale_code)}</span> · ${escapeHtml(s.buyer?.full_name || 'Comprador')} ${s.seller?.full_name ? '· vend. ' + escapeHtml(s.seller.full_name) : ''}</div>
        </div>
        <span class="chip ${bal <= 0.5 ? 'ok' : 'warn'}">${bal <= 0.5 ? 'Saldada' : 'Saldo USD ' + fmt.compact(bal)}</span>
      </div>
      <div class="cob-amounts">
        <div><span>Precio</span><b>USD ${escapeHtml(fmt.usd(price))}</b></div>
        <div><span>Cobrado</span><b class="ok">USD ${escapeHtml(fmt.usd(paid))}</b></div>
        <div><span>Saldo</span><b class="${bal > 0.5 ? 'danger' : ''}">USD ${escapeHtml(fmt.usd(bal))}</b></div>
      </div>
      <div class="progress ${bal > 0.5 ? '' : ''}"><div class="progress-fill" style="width:${pct}%"></div></div>
      ${pays.length ? `<div class="cob-pays">${pays.map(p => `
        <div class="cob-pay"><span class="mono">${escapeHtml(fmt.dateShortAR(p.paid_at))}</span><span>${escapeHtml(fmt.humanize(p.payment_method || ''))}</span><b>USD ${escapeHtml(fmt.usd(p.amount))}</b></div>
      `).join('')}</div>` : ''}
      <div class="cob-foot">
        ${bal > 0.5 ? `<button class="btn btn-sm" data-pay="${s.id}">+ Registrar pago</button>` : '<span class="text-muted text-mono" style="font-size:10px">PAGO COMPLETO</span>'}
      </div>
    </div>
  `;
}

// ----------------------------------------------------------
// MODAL: registrar pago
// ----------------------------------------------------------
function openPaymentModal(saleId) {
  const s = local.sales.find(x => x.id === saleId);
  if (!s) return;
  const bal = balanceFor(s);
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', style: { maxWidth: '440px' } });
  modal.appendChild(el('div', { class: 'modal-hd' },
    el('h3', {}, 'Registrar pago'),
    el('button', { class: 'modal-close', onClick: () => close() }, '×')));
  const methodSel = el('select', { class: 'sel', id: 'pay-method' });
  PAY_METHODS.forEach(([v, l]) => methodSel.appendChild(new Option(l, v)));
  modal.appendChild(el('div', { class: 'modal-body' },
    el('div', { class: 'note', style: { marginBottom: '14px' } }, `Saldo pendiente: USD ${fmt.usd(bal)} · ${s.sale_code}`),
    el('div', { class: 'field' }, el('label', {}, 'Monto (USD)'),
      el('input', { type: 'number', class: 'inp', id: 'pay-amount', value: String(Math.round(bal)), min: '0' })),
    el('div', { class: 'field' }, el('label', {}, 'Medio de pago'), methodSel),
    el('div', { class: 'field' }, el('label', {}, 'Referencia / comprobante'),
      el('input', { type: 'text', class: 'inp', id: 'pay-ref', placeholder: 'Nº de transferencia, recibo…' })),
    el('div', { class: 'field' }, el('label', {}, 'Notas'),
      el('textarea', { class: 'ta', id: 'pay-notes', rows: '2' })),
  ));
  modal.appendChild(el('div', { class: 'modal-actions' },
    el('button', { class: 'btn btn-ghost', onClick: () => close() }, 'Cancelar'),
    el('button', { class: 'btn btn-ok', id: 'pay-save', onClick: () => save() }, 'Registrar pago')));
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  function close() { backdrop.remove(); }

  async function save() {
    const amount = parseFloat($('#pay-amount').value);
    if (!amount || amount <= 0) { toast('Monto inválido', null, 'warn'); return; }
    const btn = $('#pay-save'); btn.disabled = true; btn.textContent = 'Guardando…';
    const { error } = await supabase.from('payments').insert({
      sale_id: saleId,
      amount,
      payment_method: $('#pay-method').value,
      reference: $('#pay-ref').value.trim() || null,
      notes: $('#pay-notes').value.trim() || null,
      created_by: currentUserId(),
    });
    if (error) { toast('Error', error.message, 'error'); btn.disabled = false; btn.textContent = 'Registrar pago'; return; }

    // Si quedó saldado, marcar la venta
    const newBal = bal - amount;
    if (newBal <= 0.5 && s.status !== 'entregada') {
      await supabase.from('sales').update({ payment_completed_at: new Date().toISOString() }).eq('id', saleId).then(() => {}, () => {});
    }
    toast('Pago registrado', `USD ${fmt.usd(amount)}`, 'ok');
    close();
    await load(); renderUI();
  }
}

const styles = `
  #cob-list { display: grid; grid-template-columns: 1fr; gap: 16px; }
  @container app (min-width: 800px) { #cob-list { grid-template-columns: 1fr 1fr; } }
  .cob-card { background: var(--cc-surface); border: 1px solid var(--cc-line); padding: 16px; }
  .cob-hd { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 14px; }
  .cob-title { font-family: var(--cc-font-display); font-weight: 400; font-size: 17px; }
  .cob-sub { font-size: 11px; color: var(--cc-muted); margin-top: 2px; }
  .cob-sub .mono { font-family: var(--cc-font-mono); }
  .cob-amounts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--cc-line); border: 1px solid var(--cc-line); margin-bottom: 10px; }
  .cob-amounts > div { background: var(--cc-bg); padding: 8px 10px; }
  .cob-amounts span { display: block; font-family: var(--cc-font-mono); font-size: 8px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--cc-muted); margin-bottom: 3px; }
  .cob-amounts b { font-family: var(--cc-font-mono); font-size: 13px; }
  .cob-amounts b.ok { color: var(--cc-ok); }
  .cob-amounts b.danger { color: var(--cc-danger); }
  .cob-pays { margin-top: 12px; border-top: 1px solid var(--cc-line-soft); padding-top: 8px; }
  .cob-pay { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; font-size: 11px; padding: 4px 0; color: var(--cc-muted); }
  .cob-pay .mono { font-family: var(--cc-font-mono); }
  .cob-pay b { color: var(--cc-ink); font-family: var(--cc-font-mono); }
  .cob-foot { margin-top: 14px; display: flex; justify-content: flex-end; align-items: center; }
`;
