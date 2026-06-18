// ============================================================
// CARCASH · MÓDULO VENTAS Y CIERRE
// Rutas:
//   /ventas              → listado
//   /ventas/nueva        → form de cierre (acepta ?opp=OP-XXXX)
//   /ventas/:id          → detalle (acepta sale_code o uuid)
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { state, isAdmin, currentUserId } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles, confirmDialog, debounce } from '../lib/dom.js';
import { navigate } from '../lib/router.js';

// ============================================================
// CONFIG
// ============================================================
const STATUS_LABELS = {
  reservada: 'Reservada',
  firmada: 'Firmada',
  pagada: 'Pagada',
  entregada: 'Entregada',
  cancelada: 'Cancelada',
};

const STATUS_FLOW = ['reservada', 'firmada', 'pagada', 'entregada'];

const PAYMENT_METHODS = [
  { id: 'transferencia', label: 'Transferencia' },
  { id: 'efectivo', label: 'Efectivo' },
  { id: 'cheque', label: 'Cheque' },
  { id: 'tarjeta', label: 'Tarjeta' },
  { id: 'otro', label: 'Otro' },
];

const local = {
  sales: [],
  sale: null,            // venta activa en detalle
  payments: [],
  filters: {
    status: 'todos',
    seller: 'todos',
    search: '',
  },
  searchHandler: null,
};

// ============================================================
// MOUNT
// ============================================================
export async function mount(params = {}) {
  injectStyles('ventas-styles', styles);
  if (!params.id) {
    await renderList();
  } else if (params.id === 'nueva') {
    await renderCreateForm(params.opp);
  } else {
    await renderDetail(params.id);
  }
}

export default mount;

// ============================================================
// FETCH
// ============================================================
async function fetchSales() {
  const { data, error } = await supabase
    .from('sales')
    .select(`
      id, sale_code, sale_price, gross_margin, margin_pct, status,
      reserved_at, signed_at, payment_completed_at, delivered_at, created_at,
      buyer:contacts!buyer_contact_id(id, full_name),
      unit:units!unit_id(id, unit_code, brand, model, year),
      seller:users_profile!seller_user_id(id, full_name)
    `)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) {
    console.error(error);
    toast('Error cargando ventas', error.message, 'error');
    return [];
  }
  return data || [];
}

async function fetchSale(idOrCode) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(idOrCode);
  let q = supabase
    .from('sales')
    .select(`
      *,
      buyer:contacts!buyer_contact_id(*),
      unit:units!unit_id(*),
      trade_in_unit:units!trade_in_unit_id(id, unit_code, brand, model, year, license_plate),
      seller:users_profile!seller_user_id(id, full_name, role),
      opportunity:opportunities!opportunity_id(id, opp_code, stage)
    `)
    .is('deleted_at', null);
  if (isUuid) q = q.eq('id', idOrCode);
  else q = q.ilike('sale_code', idOrCode.toUpperCase());

  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  return data;
}

async function fetchPayments(saleId) {
  const { data, error } = await supabase
    .from('payments')
    .select('id, sale_id, amount, payment_method, reference, paid_at, receipt_url, notes, created_at, created_by:users_profile!created_by(full_name)')
    .eq('sale_id', saleId)
    .order('paid_at', { ascending: false });
  if (error) {
    console.error('fetchPayments error', error);
    toast('Error cargando cobros', error.message, 'error');
    return [];
  }
  return data || [];
}

async function fetchOpportunityForSale(oppCode) {
  const { data, error } = await supabase
    .from('opportunities')
    .select(`
      id, opp_code, expected_amount, has_trade_in, trade_in_estimated_value,
      needs_financing, financing_amount,
      contact:contacts!contact_id(id, full_name, phone, email, dni_cuit),
      unit:units!unit_of_interest_id(id, unit_code, brand, model, year, public_price, minimum_price, acquisition_cost),
      assignee:users_profile!assigned_to(id, full_name)
    `)
    .ilike('opp_code', oppCode.toUpperCase())
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ============================================================
// VISTA: LISTADO
// ============================================================
async function renderList() {
  const view = $('#view');
  view.innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">MÓDULO 09 · OPERACIONES</div>
          <div class="page-title">Ventas y <i>cierres</i></div>
          <div class="page-sub" id="ventas-meta-sub">Cargando…</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-ghost" id="btn-refresh">Actualizar</button>
          <button class="btn" id="btn-new-sale">+ Nueva venta</button>
        </div>
      </div>
      <div class="filters">
        <div class="filter-group">
          <span class="filter-lbl">Estado</span>
          <div class="filter-chips" id="filter-status">
            <div class="filter-chip active" data-value="todos">Todas</div>
            <div class="filter-chip" data-value="reservada">Reservadas</div>
            <div class="filter-chip" data-value="firmada">Firmadas</div>
            <div class="filter-chip" data-value="pagada">Pagadas</div>
            <div class="filter-chip" data-value="entregada">Entregadas</div>
            <div class="filter-chip" data-value="cancelada">Canceladas</div>
          </div>
        </div>
      </div>
    </div>

    <div class="ventas-list" id="ventas-list">
      <div class="empty">Cargando ventas…</div>
    </div>
  `;

  attachListHandlers();
  local.sales = await fetchSales();
  renderSalesList();
}

function renderSalesList() {
  const list = $('#ventas-list');
  const filtered = getFilteredSales();
  const meta = $('#ventas-meta-sub');

  const totalSales = filtered.length;
  const totalRevenue = filtered.reduce((s, v) => s + (parseFloat(v.sale_price) || 0), 0);
  const totalMargin = filtered.reduce((s, v) => s + (parseFloat(v.gross_margin) || 0), 0);
  const avgMarginPct = totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : 0;

  meta.innerHTML = `
    <b>${totalSales}</b> ventas · INGRESOS <b>USD ${fmt.compact(totalRevenue)}</b>
    ${isAdmin() ? ` · MARGEN <b>USD ${fmt.compact(totalMargin)}</b> (${avgMarginPct.toFixed(1)}%)` : ''}
  `;

  if (!local.sales.length) {
    list.innerHTML = `
      <div class="ventas-empty">
        <div class="ventas-empty-title">Todavía no hay ventas registradas</div>
        <div class="ventas-empty-desc">Cuando una oportunidad se cierra, generala desde la Ficha 360 o tocá "+ Nueva venta" arriba.</div>
      </div>
    `;
    return;
  }
  if (!filtered.length) {
    list.innerHTML = `<div class="empty">Ningún resultado</div>`;
    return;
  }

  list.innerHTML = `
    <div class="ventas-table">
      <div class="vt-head">
        <div class="vt-col vt-col-code">Código</div>
        <div class="vt-col vt-col-buyer">Comprador</div>
        <div class="vt-col vt-col-unit">Unidad</div>
        <div class="vt-col vt-col-seller">Vendedor</div>
        <div class="vt-col vt-col-amount">Monto</div>
        ${isAdmin() ? '<div class="vt-col vt-col-margin">Margen</div>' : ''}
        <div class="vt-col vt-col-status">Estado</div>
        <div class="vt-col vt-col-date">Fecha</div>
      </div>
      ${filtered.map(saleRow).join('')}
    </div>
  `;
}

function saleRow(s) {
  const unit = s.unit ? `${s.unit.brand} ${s.unit.model} '${String(s.unit.year).slice(2)}` : '—';
  return `
    <a class="vt-row" data-route="/ventas/${escapeHtml(s.sale_code.toLowerCase())}">
      <div class="vt-col vt-col-code">${escapeHtml(s.sale_code)}</div>
      <div class="vt-col vt-col-buyer">${escapeHtml(s.buyer?.full_name || '—')}</div>
      <div class="vt-col vt-col-unit">${escapeHtml(unit)}</div>
      <div class="vt-col vt-col-seller">${escapeHtml(s.seller?.full_name || '—')}</div>
      <div class="vt-col vt-col-amount">USD ${escapeHtml(fmt.usd(s.sale_price))}</div>
      ${isAdmin() ? `
        <div class="vt-col vt-col-margin">
          ${s.gross_margin != null ? 'USD ' + fmt.compact(s.gross_margin) : '—'}
          ${s.margin_pct != null ? ` <span class="vt-pct">${parseFloat(s.margin_pct).toFixed(1)}%</span>` : ''}
        </div>
      ` : ''}
      <div class="vt-col vt-col-status">
        <span class="status-pill status-${s.status}">${escapeHtml(STATUS_LABELS[s.status] || s.status)}</span>
      </div>
      <div class="vt-col vt-col-date">${escapeHtml(fmt.dateAR(s.created_at))}</div>
    </a>
  `;
}

function getFilteredSales() {
  return local.sales.filter(s => {
    if (local.filters.status !== 'todos' && s.status !== local.filters.status) return false;
    if (local.filters.search) {
      const q = local.filters.search.toLowerCase();
      const hay = [
        s.sale_code, s.buyer?.full_name, s.unit?.brand, s.unit?.model, s.seller?.full_name,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function attachListHandlers() {
  $('#btn-refresh').addEventListener('click', () => mount());
  $('#btn-new-sale').addEventListener('click', () => navigate('/ventas/nueva'));

  $('#filter-status').addEventListener('click', (e) => {
    const c = e.target.closest('.filter-chip');
    if (!c) return;
    local.filters.status = c.dataset.value;
    $$('#filter-status .filter-chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    renderSalesList();
  });

  // Búsqueda con topbar
  const searchInput = $('#search');
  if (searchInput) {
    if (local.searchHandler) searchInput.removeEventListener('input', local.searchHandler);
    local.searchHandler = debounce((e) => {
      local.filters.search = e.target.value.trim();
      renderSalesList();
    }, 200);
    searchInput.addEventListener('input', local.searchHandler);
  }
}

// ============================================================
// VISTA: FORM DE CREACIÓN (CIERRE)
// ============================================================
async function renderCreateForm(oppCode) {
  const view = $('#view');
  view.innerHTML = `<div class="empty">Cargando…</div>`;

  let opp = null;
  if (oppCode) {
    try {
      opp = await fetchOpportunityForSale(oppCode);
    } catch (err) {
      toast('Error', err.message, 'error');
    }
  }

  const todayISO = new Date().toISOString().slice(0, 10);

  const expectedAmount = opp?.expected_amount || opp?.unit?.public_price || 0;
  const acquisitionCost = opp?.unit?.acquisition_cost || 0;
  const tradeInValue = opp?.trade_in_estimated_value || 0;
  const financingAmount = opp?.financing_amount || 0;

  view.innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">MÓDULO 09 · CIERRE</div>
          <div class="page-title">Nueva <i>venta</i></div>
          <div class="page-sub">${opp ? `Cerrando <b>${escapeHtml(opp.opp_code)}</b> · ${escapeHtml(opp.contact?.full_name || '')}` : 'Cargá los datos del cierre'}</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-ghost" id="btn-cancel">Cancelar</button>
          <button class="btn btn-ok" id="btn-save">Crear venta</button>
        </div>
      </div>
    </div>

    <form class="venta-form" id="venta-form" autocomplete="off">
      <div class="form-section">
        <div class="form-section-hd">Operación</div>
        <div class="form-section-body">
          ${opp ? `
            <div class="venta-summary">
              <div class="vs-block">
                <div class="vs-label">Comprador</div>
                <div class="vs-value">${escapeHtml(opp.contact?.full_name)}</div>
              </div>
              <div class="vs-block">
                <div class="vs-label">Unidad</div>
                <div class="vs-value">${escapeHtml(opp.unit?.brand + ' ' + opp.unit?.model + ' ' + opp.unit?.year)}</div>
              </div>
              <div class="vs-block">
                <div class="vs-label">Vendedor</div>
                <div class="vs-value">${escapeHtml(opp.assignee?.full_name || state.profile.full_name)}</div>
              </div>
            </div>
          ` : `
            <div class="empty">Para crear una venta tenés que vincularla a una oportunidad. Volvé al pipeline, abrí la oportunidad ganada y tocá "Generar venta".</div>
            <button class="btn btn-ghost btn-sm" type="button" id="btn-pick-opp">Buscar oportunidad ganada</button>
          `}
        </div>
      </div>

      ${opp ? `
      <div class="form-section">
        <div class="form-section-hd">Composición financiera</div>
        <div class="form-section-body">
          <div class="field-row">
            <div class="field">
              <label>Precio final (USD)</label>
              <input type="number" id="f-sale-price" min="0" step="500" value="${expectedAmount}" required>
            </div>
            <div class="field">
              <label>Fecha de reserva</label>
              <input type="date" id="f-reserved-at" value="${todayISO}">
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label>Permuta (USD)</label>
              <input type="number" id="f-trade-in" min="0" step="500" value="${tradeInValue}">
            </div>
            <div class="field">
              <label>Seña (USD)</label>
              <input type="number" id="f-deposit" min="0" step="500" value="0">
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label>Financiación (USD)</label>
              <input type="number" id="f-financing" min="0" step="500" value="${financingAmount}">
            </div>
            <div class="field">
              <label>Institución financiera</label>
              <input type="text" id="f-fin-inst" placeholder="Banco / financiera">
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label>Tasa anual (%)</label>
              <input type="number" id="f-fin-rate" min="0" max="200" step="0.1">
            </div>
            <div class="field">
              <label>A completar en efectivo (USD)</label>
              <input type="number" id="f-cash" min="0" step="500" readonly tabindex="-1">
              <div class="field-hint">Se calcula automáticamente</div>
            </div>
          </div>
        </div>
      </div>

      ${isAdmin() ? `
      <div class="form-section">
        <div class="form-section-hd">Costos y rentabilidad <span class="form-section-tag">SOLO ADMIN</span></div>
        <div class="form-section-body">
          <div class="field-row">
            <div class="field">
              <label>Costo de la unidad (USD)</label>
              <input type="number" id="f-unit-cost" min="0" step="500" value="${acquisitionCost}">
            </div>
            <div class="field">
              <label>Gastos asociados (USD)</label>
              <input type="number" id="f-expenses" min="0" step="100" value="0">
              <div class="field-hint">Patentes, gestoría, preparación, etc.</div>
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label>Margen bruto estimado</label>
              <div class="field-readout" id="f-margin-readout">USD —</div>
            </div>
            <div class="field">
              <label>Margen %</label>
              <div class="field-readout" id="f-margin-pct-readout">—</div>
            </div>
          </div>
        </div>
      </div>
      ` : ''}

      <div class="form-section">
        <div class="form-section-hd">Notas y documentación</div>
        <div class="form-section-body">
          <div class="field">
            <label>Notas internas</label>
            <textarea id="f-notes" rows="3" placeholder="Cualquier detalle relevante del cierre"></textarea>
          </div>
        </div>
      </div>
      ` : ''}
    </form>
  `;

  attachCreateHandlers(opp);
}

function attachCreateHandlers(opp) {
  $('#btn-cancel').addEventListener('click', () => {
    if (opp) navigate(`/pipeline/${opp.opp_code.toLowerCase()}`);
    else navigate('/ventas');
  });

  $('#btn-pick-opp')?.addEventListener('click', () => {
    toast('Próximamente', 'Selector de oportunidades ganadas — abrir desde Ficha 360', 'info');
  });

  if (!opp) return;

  // Cálculo automático de cash y margen
  const recompute = () => {
    const price = parseFloat($('#f-sale-price').value) || 0;
    const trade = parseFloat($('#f-trade-in').value) || 0;
    const deposit = parseFloat($('#f-deposit').value) || 0;
    const financing = parseFloat($('#f-financing').value) || 0;
    const cash = Math.max(0, price - trade - deposit - financing);
    $('#f-cash').value = cash;

    if (isAdmin()) {
      const cost = parseFloat($('#f-unit-cost').value) || 0;
      const exp = parseFloat($('#f-expenses').value) || 0;
      const margin = price - cost - exp;
      const pct = price > 0 ? (margin / price) * 100 : 0;
      const mr = $('#f-margin-readout');
      const pr = $('#f-margin-pct-readout');
      if (mr) {
        mr.textContent = 'USD ' + fmt.usd(margin);
        mr.style.color = margin > 0 ? 'var(--cc-ok)' : 'var(--cc-danger)';
      }
      if (pr) {
        pr.textContent = pct.toFixed(1) + '%';
        pr.style.color = margin > 0 ? 'var(--cc-ok)' : 'var(--cc-danger)';
      }
    }
  };
  ['f-sale-price', 'f-trade-in', 'f-deposit', 'f-financing', 'f-unit-cost', 'f-expenses'].forEach(id => {
    $('#' + id)?.addEventListener('input', recompute);
  });
  recompute();

  $('#btn-save').addEventListener('click', () => submitSale(opp));
}

async function submitSale(opp) {
  const btn = $('#btn-save');
  btn.disabled = true;
  btn.textContent = 'Creando…';

  try {
    const payload = {
      opportunity_id: opp.id,
      unit_id: opp.unit?.id,
      buyer_contact_id: opp.contact?.id,
      seller_user_id: opp.assignee?.id || currentUserId(),
      sale_price: parseFloat($('#f-sale-price').value),
      trade_in_value: parseFloat($('#f-trade-in').value) || 0,
      deposit_amount: parseFloat($('#f-deposit').value) || 0,
      financing_amount: parseFloat($('#f-financing').value) || 0,
      financing_institution: $('#f-fin-inst').value.trim() || null,
      financing_rate_pct: parseFloat($('#f-fin-rate').value) || null,
      cash_amount: parseFloat($('#f-cash').value) || 0,
      reserved_at: $('#f-reserved-at').value ? new Date($('#f-reserved-at').value).toISOString() : null,
      status: 'reservada',
      notes: $('#f-notes').value.trim() || null,
      created_by: currentUserId(),
    };

    if (isAdmin()) {
      payload.unit_cost = parseFloat($('#f-unit-cost').value) || 0;
      payload.total_expenses = parseFloat($('#f-expenses').value) || 0;
    }

    if (!payload.unit_id || !payload.buyer_contact_id) {
      throw new Error('La oportunidad no tiene unidad o contacto asignados');
    }
    if (!payload.sale_price || payload.sale_price <= 0) {
      throw new Error('El precio final no puede ser cero');
    }

    const { data, error } = await supabase
      .from('sales')
      .insert(payload)
      .select('id, sale_code')
      .single();
    if (error) throw error;

    // Actualizar la unidad → reservado
    await supabase
      .from('units')
      .update({ status: 'reservado' })
      .eq('id', payload.unit_id);

    // Actualizar la oportunidad → ganada + final_amount
    await supabase
      .from('opportunities')
      .update({
        stage: 'ganada',
        final_amount: payload.sale_price,
      })
      .eq('id', opp.id);

    // Registrar en timeline
    await supabase.from('timeline_events').insert({
      opportunity_id: opp.id,
      event_type: 'venta',
      title: `Venta ${data.sale_code} creada`,
      body: `Cierre por USD ${fmt.usd(payload.sale_price)}`,
      user_id: currentUserId(),
      is_system: false,
    });

    toast(`Venta ${data.sale_code} creada`, 'Operación abierta como reservada', 'ok');
    navigate(`/ventas/${data.sale_code.toLowerCase()}`);
  } catch (err) {
    console.error(err);
    toast('Error al crear venta', err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Crear venta';
  }
}

// ============================================================
// VISTA: DETALLE DE VENTA
// ============================================================
async function renderDetail(idOrCode) {
  const view = $('#view');
  view.innerHTML = `<div class="empty">Cargando venta…</div>`;

  try {
    local.sale = await fetchSale(idOrCode);
    if (!local.sale) {
      view.innerHTML = `
        <div class="placeholder">
          <div class="placeholder-content">
            <div class="placeholder-num">404</div>
            <div class="placeholder-title">Venta no <i>encontrada</i></div>
            <div class="placeholder-desc">No existe una venta con código "${escapeHtml(idOrCode.toUpperCase())}".</div>
            <div class="placeholder-status" style="cursor:pointer" onclick="location.hash='#/ventas'">VOLVER</div>
          </div>
        </div>
      `;
      return;
    }
    local.payments = await fetchPayments(local.sale.id);
    renderDetailUI();
  } catch (err) {
    console.error(err);
    toast('Error', err.message, 'error');
  }
}

function renderDetailUI() {
  const s = local.sale;
  const view = $('#view');
  const totalPaid = local.payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
  const balanceLeft = (parseFloat(s.sale_price) || 0) - (parseFloat(s.trade_in_value) || 0) - (parseFloat(s.financing_amount) || 0) - totalPaid;

  view.innerHTML = `
    <div class="venta-detail">
      <!-- HEADER -->
      <div class="vd-hd">
        <div class="vd-hd-row">
          <div>
            <div class="vd-back"><a data-route="/ventas">← Ventas</a></div>
            <div class="vd-id">${escapeHtml(s.sale_code)} · CREADA ${escapeHtml(fmt.dateAR(s.created_at).toUpperCase())}</div>
            <div class="vd-name">${escapeHtml(s.buyer?.full_name || '—')}</div>
            <div class="vd-sub">${escapeHtml((s.unit?.brand || '') + ' ' + (s.unit?.model || '') + ' ' + (s.unit?.year || ''))}${s.unit?.unit_code ? ` · ${escapeHtml(s.unit.unit_code)}` : ''}</div>
            <div class="vd-tags">
              <span class="status-pill status-${s.status}">${escapeHtml(STATUS_LABELS[s.status] || s.status)}</span>
              <span class="badge">USD ${escapeHtml(fmt.usd(s.sale_price))}</span>
              ${s.opportunity ? `<span class="badge">${escapeHtml(s.opportunity.opp_code)}</span>` : ''}
            </div>
          </div>
          <div class="vd-actions">
            ${renderStatusActions(s)}
            ${s.status !== 'cancelada' && s.status !== 'entregada' ? `<button class="btn btn-ghost btn-sm" id="btn-cancel-sale">Cancelar venta</button>` : ''}
          </div>
        </div>
      </div>

      <!-- PROGRESS -->
      <div class="vd-progress">
        ${STATUS_FLOW.map((st, i) => {
          const reached = STATUS_FLOW.indexOf(s.status) >= i;
          const isCurrent = s.status === st;
          const dateField = { reservada: s.reserved_at, firmada: s.signed_at, pagada: s.payment_completed_at, entregada: s.delivered_at }[st];
          return `
            <div class="vd-progress-step ${reached ? 'reached' : ''} ${isCurrent ? 'current' : ''}">
              <div class="vd-progress-dot"></div>
              <div class="vd-progress-label">${escapeHtml(STATUS_LABELS[st])}</div>
              <div class="vd-progress-date">${dateField ? escapeHtml(fmt.dateAR(dateField)) : '—'}</div>
            </div>
          `;
        }).join('')}
      </div>

      <div class="vd-body">
        <!-- COMPOSICIÓN FINANCIERA -->
        <div class="vd-col-main">
          <div class="vd-block">
            <div class="vd-block-hd">Composición financiera</div>
            <div class="vd-comp">
              <div class="vd-comp-row"><span>Precio final</span><b>USD ${escapeHtml(fmt.usd(s.sale_price))}</b></div>
              ${s.trade_in_value > 0 ? `
                <div class="vd-comp-row sub"><span>− Permuta${s.trade_in_unit ? ` (${escapeHtml(s.trade_in_unit.brand + ' ' + s.trade_in_unit.model)})` : ''}</span><b>USD ${escapeHtml(fmt.usd(s.trade_in_value))}</b></div>
              ` : ''}
              ${s.financing_amount > 0 ? `
                <div class="vd-comp-row sub">
                  <span>− Financiación${s.financing_institution ? ` · ${escapeHtml(s.financing_institution)}` : ''}${s.financing_rate_pct ? ` · ${parseFloat(s.financing_rate_pct).toFixed(1)}%` : ''}</span>
                  <b>USD ${escapeHtml(fmt.usd(s.financing_amount))}</b>
                </div>
              ` : ''}
              ${s.deposit_amount > 0 ? `
                <div class="vd-comp-row sub"><span>− Seña</span><b>USD ${escapeHtml(fmt.usd(s.deposit_amount))}</b></div>
              ` : ''}
              <div class="vd-comp-row total">
                <span>A completar en efectivo</span>
                <b>USD ${escapeHtml(fmt.usd(s.cash_amount))}</b>
              </div>
            </div>
          </div>

          ${isAdmin() ? `
          <div class="vd-block">
            <div class="vd-block-hd">Rentabilidad <span class="vd-block-tag">SOLO ADMIN</span></div>
            <div class="vd-comp">
              <div class="vd-comp-row"><span>Costo unidad</span><b>USD ${escapeHtml(fmt.usd(s.unit_cost))}</b></div>
              <div class="vd-comp-row"><span>Gastos asociados</span><b>USD ${escapeHtml(fmt.usd(s.total_expenses))}</b></div>
              <div class="vd-comp-row total ${s.gross_margin >= 0 ? 'ok' : 'danger'}">
                <span>Margen bruto</span>
                <b>USD ${escapeHtml(fmt.usd(s.gross_margin))} ${s.margin_pct != null ? `(${parseFloat(s.margin_pct).toFixed(1)}%)` : ''}</b>
              </div>
            </div>
          </div>
          ` : ''}

          <!-- COBROS -->
          <div class="vd-block">
            <div class="vd-block-hd">
              Cobros recibidos
              <span class="vd-block-meta">${local.payments.length} pago${local.payments.length !== 1 ? 's' : ''} · USD ${fmt.usd(totalPaid)}</span>
            </div>
            <div class="vd-payments">
              ${local.payments.length === 0 ? `<div class="vd-empty">Sin cobros registrados todavía</div>` : ''}
              ${local.payments.map(p => `
                <div class="vd-payment">
                  <div class="vd-payment-amount">USD ${escapeHtml(fmt.usd(p.amount))}</div>
                  <div class="vd-payment-meta">
                    <span>${escapeHtml(fmt.humanize(p.payment_method))}</span>
                    ${p.reference ? `<span>· ${escapeHtml(p.reference)}</span>` : ''}
                    <span>· ${escapeHtml(fmt.dateAR(p.paid_at))}</span>
                  </div>
                  ${p.notes ? `<div class="vd-payment-notes">${escapeHtml(p.notes)}</div>` : ''}
                </div>
              `).join('')}
              <div class="vd-payment-balance ${balanceLeft <= 0 ? 'paid' : ''}">
                <span>${balanceLeft <= 0 ? '✓ COMPLETO' : 'Saldo restante'}</span>
                <b>USD ${escapeHtml(fmt.usd(Math.max(0, balanceLeft)))}</b>
              </div>
            </div>
            <div style="padding: 12px 16px; border-top: 1px solid var(--cc-line-soft);">
              <button class="btn btn-sm" id="btn-add-payment">+ Registrar cobro</button>
            </div>
          </div>

          ${s.notes ? `
            <div class="vd-block">
              <div class="vd-block-hd">Notas</div>
              <div class="vd-notes">${escapeHtml(s.notes)}</div>
            </div>
          ` : ''}
        </div>

        <!-- LATERAL -->
        <div class="vd-col-side">
          <div class="vd-panel">
            <div class="vd-panel-hd">Comprador</div>
            <div class="vd-row"><span>Nombre</span><b>${escapeHtml(s.buyer?.full_name || '—')}</b></div>
            <div class="vd-row"><span>Teléfono</span><b>${escapeHtml(fmt.phone(s.buyer?.phone))}</b></div>
            <div class="vd-row"><span>Email</span><b>${escapeHtml(s.buyer?.email || '—')}</b></div>
            <div class="vd-row"><span>DNI/CUIT</span><b>${escapeHtml(s.buyer?.dni_cuit || '—')}</b></div>
          </div>

          <div class="vd-panel">
            <div class="vd-panel-hd">Unidad</div>
            ${s.unit?.main_photo_url ? `<img class="vd-photo" src="${escapeHtml(s.unit.main_photo_url)}" alt="">` : ''}
            <div class="vd-row"><span>Modelo</span><b>${escapeHtml((s.unit?.brand || '') + ' ' + (s.unit?.model || ''))}</b></div>
            <div class="vd-row"><span>Año</span><b>${s.unit?.year || '—'}</b></div>
            <div class="vd-row"><span>Patente</span><b>${escapeHtml(fmt.plate(s.unit?.license_plate))}</b></div>
            ${s.unit?.unit_code ? `<div class="vd-row"><a class="vd-link" data-route="/unidades/${escapeHtml(s.unit.unit_code.toLowerCase())}">Ver ficha completa →</a></div>` : ''}
          </div>

          <div class="vd-panel">
            <div class="vd-panel-hd">Vendedor</div>
            <div class="vd-row"><span>Nombre</span><b>${escapeHtml(s.seller?.full_name || '—')}</b></div>
            <div class="vd-row"><span>Rol</span><b>${escapeHtml((s.seller?.role || '').toUpperCase())}</b></div>
          </div>

          <div class="vd-panel">
            <div class="vd-panel-hd">Documentos</div>
            <div class="vd-row">
              <span>Boleto</span>
              <b>${s.boleto_url ? `<a href="${escapeHtml(s.boleto_url)}" target="_blank">Ver →</a>` : 'Pendiente'}</b>
            </div>
            <div class="vd-row">
              <span>Factura</span>
              <b>${s.invoice_url ? `<a href="${escapeHtml(s.invoice_url)}" target="_blank">Ver →</a>` : 'Pendiente'}</b>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  attachDetailHandlers();
}

function renderStatusActions(s) {
  const idx = STATUS_FLOW.indexOf(s.status);
  if (idx < 0 || idx >= STATUS_FLOW.length - 1) return '';
  const next = STATUS_FLOW[idx + 1];
  const labels = {
    firmada: 'Marcar como Firmada',
    pagada: 'Marcar como Pagada',
    entregada: 'Marcar como Entregada',
  };
  return `<button class="btn btn-ok btn-sm" id="btn-advance" data-next="${next}">✓ ${escapeHtml(labels[next])}</button>`;
}

function attachDetailHandlers() {
  $('#btn-advance')?.addEventListener('click', async (e) => {
    const next = e.currentTarget.dataset.next;
    const ok = await confirmDialog(`¿Marcar la venta como ${STATUS_LABELS[next]}?`);
    if (!ok) return;
    const update = { status: next };
    const now = new Date().toISOString();
    if (next === 'firmada') update.signed_at = now;
    if (next === 'pagada') update.payment_completed_at = now;
    if (next === 'entregada') {
      update.delivered_at = now;
      // Marcar la unidad como entregada
      await supabase.from('units').update({ status: 'entregado', delivered_at: now }).eq('id', local.sale.unit_id);
    }
    const { error } = await supabase.from('sales').update(update).eq('id', local.sale.id);
    if (error) { toast('Error', error.message, 'error'); return; }
    toast(`Venta ${STATUS_LABELS[next]}`, null, 'ok');
    Object.assign(local.sale, update);
    renderDetailUI();
  });

  $('#btn-cancel-sale')?.addEventListener('click', async () => {
    const ok = await confirmDialog('¿Cancelar esta venta? La unidad vuelve a disponible.', { okText: 'Cancelar venta' });
    if (!ok) return;
    await supabase.from('sales').update({ status: 'cancelada' }).eq('id', local.sale.id);
    await supabase.from('units').update({ status: 'disponible' }).eq('id', local.sale.unit_id);
    toast('Venta cancelada', null, 'warn');
    local.sale.status = 'cancelada';
    renderDetailUI();
  });

  $('#btn-add-payment')?.addEventListener('click', () => openPaymentModal());
}

function openPaymentModal() {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', style: { maxWidth: '440px' } });

  const amountInput = el('input', { type: 'number', class: 'loss-select', placeholder: '0', step: '500', min: '0' });
  const methodSelect = el('select', { class: 'loss-select' },
    ...PAYMENT_METHODS.map(m => el('option', { value: m.id }, m.label))
  );
  const refInput = el('input', { class: 'loss-select', placeholder: 'Nro. de operación / cheque (opcional)' });
  const dateInput = el('input', { type: 'date', class: 'loss-select', value: new Date().toISOString().slice(0, 10) });
  const notesArea = el('textarea', { class: 'loss-notes', rows: '2', placeholder: 'Notas (opcional)' });

  modal.appendChild(el('div', { class: 'modal-hd' },
    el('h3', {}, 'Registrar cobro'),
    el('button', { class: 'modal-close', onClick: () => close() }, '×')
  ));
  modal.appendChild(el('div', { class: 'modal-body' },
    el('label', { class: 'loss-label' }, 'Monto (USD)'),
    amountInput,
    el('label', { class: 'loss-label', style: { marginTop: '12px' } }, 'Método de pago'),
    methodSelect,
    el('label', { class: 'loss-label', style: { marginTop: '12px' } }, 'Referencia'),
    refInput,
    el('label', { class: 'loss-label', style: { marginTop: '12px' } }, 'Fecha'),
    dateInput,
    el('label', { class: 'loss-label', style: { marginTop: '12px' } }, 'Notas'),
    notesArea,
  ));
  modal.appendChild(el('div', { class: 'modal-actions' },
    el('button', { class: 'btn btn-ghost', onClick: () => close() }, 'Cancelar'),
    el('button', { class: 'btn btn-ok', onClick: async () => {
      const amount = parseFloat(amountInput.value);
      if (!amount || amount <= 0) {
        amountInput.style.borderColor = 'var(--cc-danger)';
        return;
      }
      const { error } = await supabase.from('payments').insert({
        sale_id: local.sale.id,
        amount,
        payment_method: methodSelect.value,
        reference: refInput.value.trim() || null,
        paid_at: dateInput.value ? new Date(dateInput.value).toISOString() : new Date().toISOString(),
        notes: notesArea.value.trim() || null,
        created_by: currentUserId(),
      });
      if (error) { toast('Error', error.message, 'error'); return; }
      toast('Cobro registrado', `USD ${fmt.usd(amount)}`, 'ok');
      close();
      local.payments = await fetchPayments(local.sale.id);
      renderDetailUI();
    } }, 'Guardar cobro'),
  ));

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  function close() { backdrop.remove(); }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
}

// ============================================================
// STYLES
// ============================================================
const styles = `
  .page-hd { padding: 22px 20px 16px; border-bottom: 1px solid var(--cc-line); }
  @container app (min-width: 900px) { .page-hd { padding: 28px 32px 20px; } }
  .page-hd-top { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; flex-wrap: wrap; margin-bottom: 16px; }
  .page-num { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.22em; color: var(--cc-champagne); font-weight: 600; margin-bottom: 4px; }
  .page-title { font-family: var(--cc-font-display); font-weight: 300; font-size: 30px; letter-spacing: -0.025em; line-height: 1; }
  @container app (min-width: 700px) { .page-title { font-size: 36px; } }
  .page-title i { font-style: italic; font-weight: 500; }
  .page-sub { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.12em; color: var(--cc-muted); margin-top: 6px; }
  .page-sub b { color: var(--cc-ink); font-weight: 600; }
  .page-actions { display: flex; gap: 8px; flex-wrap: wrap; }

  .filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .filter-group { display: flex; align-items: center; gap: 6px; }
  .filter-lbl { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--cc-muted); font-weight: 500; }
  .filter-chips { display: flex; gap: 0; border: 1px solid var(--cc-line); background: var(--cc-surface); }
  .filter-chip { padding: 6px 12px; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--cc-muted); cursor: pointer; font-weight: 500; border-right: 1px solid var(--cc-line); }
  .filter-chip:last-child { border-right: none; }
  .filter-chip.active { background: var(--cc-ink); color: var(--cc-bg); }

  /* TABLA DE VENTAS */
  .ventas-list { padding: 18px 20px; }
  @container app (min-width: 900px) { .ventas-list { padding: 22px 32px; } }
  .ventas-empty { padding: 60px 24px; text-align: center; max-width: 480px; margin: 0 auto; }
  .ventas-empty-title { font-family: var(--cc-font-display); font-weight: 400; font-size: 22px; margin-bottom: 8px; }
  .ventas-empty-desc { font-size: 13px; color: var(--cc-muted); line-height: 1.5; }

  .ventas-table { background: var(--cc-surface); border: 1px solid var(--cc-line); }
  .vt-head, .vt-row {
    display: grid;
    grid-template-columns: 100px 1fr 1.4fr 1fr 110px 110px 100px;
    gap: 12px;
    padding: 10px 14px;
    align-items: center;
    font-size: 12px;
  }
  body.is-admin .vt-head, body.is-admin .vt-row {
    grid-template-columns: 100px 1fr 1.4fr 1fr 110px 130px 110px 100px;
  }
  .vt-head {
    font-family: var(--cc-font-mono);
    font-size: 9px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--cc-muted);
    background: var(--cc-bg-alt);
    border-bottom: 1px solid var(--cc-line);
    font-weight: 600;
  }
  .vt-row { border-bottom: 1px solid var(--cc-line-soft); cursor: pointer; text-decoration: none; color: inherit; }
  .vt-row:last-child { border-bottom: none; }
  .vt-row:hover { background: var(--cc-bg-alt); }
  .vt-col-code { font-family: var(--cc-font-mono); font-weight: 600; }
  .vt-col-amount { font-family: var(--cc-font-mono); font-weight: 600; }
  .vt-col-margin { font-family: var(--cc-font-mono); font-size: 11px; }
  .vt-col-margin .vt-pct { color: var(--cc-muted); margin-left: 4px; }
  .vt-col-date { font-family: var(--cc-font-mono); color: var(--cc-muted); }
  @container app (max-width: 900px) {
    .vt-head { display: none; }
    .vt-row { grid-template-columns: 1fr 1fr; gap: 4px; padding: 12px 14px; border-bottom: 1px solid var(--cc-line); }
    body.is-admin .vt-row { grid-template-columns: 1fr 1fr; }
    .vt-col-code, .vt-col-buyer, .vt-col-amount, .vt-col-status { display: block; }
    .vt-col-unit, .vt-col-seller, .vt-col-margin, .vt-col-date { font-size: 10px; color: var(--cc-muted); }
  }

  .status-pill {
    display: inline-block;
    padding: 2px 8px;
    font-family: var(--cc-font-mono);
    font-size: 9px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    background: var(--cc-bg-alt);
    border: 1px solid var(--cc-line);
    font-weight: 600;
  }
  .status-reservada { background: var(--cc-warn-soft); color: var(--cc-warn); border-color: var(--cc-warn); }
  .status-firmada { background: var(--cc-info-soft); color: var(--cc-info); border-color: var(--cc-info); }
  .status-pagada { background: var(--cc-champagne); color: var(--cc-ink); border-color: var(--cc-champagne); }
  .status-entregada { background: var(--cc-ok-soft); color: var(--cc-ok); border-color: var(--cc-ok); }
  .status-cancelada { background: var(--cc-bg-alt); color: var(--cc-muted); border-color: var(--cc-line); }

  /* FORM */
  .venta-form { padding: 0 20px 30px; }
  @container app (min-width: 900px) { .venta-form { padding: 0 32px 40px; max-width: 800px; } }
  .form-section { background: var(--cc-surface); border: 1px solid var(--cc-line); margin-bottom: 16px; }
  .form-section-hd { padding: 12px 16px; border-bottom: 1px solid var(--cc-line-soft); font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; font-weight: 600; color: var(--cc-ink); display: flex; justify-content: space-between; align-items: center; }
  .form-section-tag { font-family: var(--cc-font-mono); font-size: 9px; padding: 2px 6px; background: var(--cc-champagne); color: var(--cc-ink); letter-spacing: 0.15em; }
  .form-section-body { padding: 16px; }
  .field-hint { font-size: 10px; color: var(--cc-muted); margin-top: 4px; }
  .field-readout { padding: 10px 12px; background: var(--cc-bg-alt); border: 1px solid var(--cc-line); font-family: var(--cc-font-mono); font-weight: 600; font-size: 14px; }

  .venta-summary { display: grid; grid-template-columns: 1fr; gap: 12px; }
  @container app (min-width: 700px) { .venta-summary { grid-template-columns: repeat(3, 1fr); } }
  .vs-block {}
  .vs-label { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cc-muted); margin-bottom: 4px; }
  .vs-value { font-size: 14px; font-weight: 500; }

  /* DETAIL */
  .vd-hd { padding: 22px 20px 14px; border-bottom: 1px solid var(--cc-line); background: var(--cc-surface); }
  @container app (min-width: 900px) { .vd-hd { padding: 28px 32px 18px; } }
  .vd-hd-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
  .vd-back { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.18em; color: var(--cc-muted); margin-bottom: 8px; }
  .vd-back a { color: var(--cc-muted); text-decoration: none; cursor: pointer; }
  .vd-back a:hover { color: var(--cc-ink); }
  .vd-id { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.16em; color: var(--cc-muted); margin-bottom: 6px; }
  .vd-name { font-family: var(--cc-font-display); font-weight: 300; font-size: 32px; letter-spacing: -0.02em; line-height: 1.05; }
  @container app (min-width: 700px) { .vd-name { font-size: 38px; } }
  .vd-sub { font-family: var(--cc-font-display); font-style: italic; font-size: 14px; color: var(--cc-muted); margin-top: 4px; }
  .vd-tags { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
  .vd-actions { display: flex; gap: 8px; flex-wrap: wrap; }

  /* PROGRESS */
  .vd-progress { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--cc-line); border-bottom: 1px solid var(--cc-line); }
  .vd-progress-step { background: var(--cc-bg); padding: 14px 16px; text-align: center; opacity: 0.5; }
  .vd-progress-step.reached { opacity: 1; background: var(--cc-surface); }
  .vd-progress-step.current { background: var(--cc-ok-soft); border-bottom: 2px solid var(--cc-ok); }
  .vd-progress-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--cc-line); margin: 0 auto 6px; }
  .vd-progress-step.reached .vd-progress-dot { background: var(--cc-ok); }
  .vd-progress-label { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; font-weight: 600; }
  .vd-progress-date { font-family: var(--cc-font-mono); font-size: 9px; color: var(--cc-muted); margin-top: 2px; letter-spacing: 0.05em; }

  /* BODY */
  .vd-body { display: grid; grid-template-columns: 1fr; gap: 1px; background: var(--cc-line); }
  @container app (min-width: 900px) { .vd-body { grid-template-columns: 1.6fr 1fr; } }
  .vd-col-main, .vd-col-side { background: var(--cc-bg); padding: 18px 20px; min-width: 0; }
  @container app (min-width: 900px) { .vd-col-main { padding: 24px 28px; } }
  .vd-col-side { display: flex; flex-direction: column; gap: 16px; }

  .vd-block { background: var(--cc-surface); border: 1px solid var(--cc-line); margin-bottom: 18px; }
  .vd-block-hd { padding: 12px 16px; border-bottom: 1px solid var(--cc-line-soft); font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; font-weight: 600; color: var(--cc-ink); display: flex; justify-content: space-between; align-items: center; }
  .vd-block-tag { font-family: var(--cc-font-mono); font-size: 9px; padding: 2px 6px; background: var(--cc-champagne); color: var(--cc-ink); letter-spacing: 0.15em; }
  .vd-block-meta { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); letter-spacing: 0.05em; text-transform: none; font-weight: 400; }

  .vd-comp { padding: 4px 0; }
  .vd-comp-row { display: flex; justify-content: space-between; padding: 9px 16px; font-size: 13px; border-bottom: 1px solid var(--cc-line-soft); }
  .vd-comp-row:last-child { border-bottom: none; }
  .vd-comp-row.sub { font-size: 12px; color: var(--cc-muted); padding-left: 28px; }
  .vd-comp-row.sub b { color: var(--cc-ink); }
  .vd-comp-row.total { background: var(--cc-bg-alt); font-weight: 600; }
  .vd-comp-row.total.ok { background: var(--cc-ok-soft); color: var(--cc-ok); }
  .vd-comp-row.total.danger { background: var(--cc-danger-soft); color: var(--cc-danger); }

  .vd-payments { padding: 6px 0; }
  .vd-payment { padding: 10px 16px; border-bottom: 1px solid var(--cc-line-soft); }
  .vd-payment:last-of-type { border-bottom: none; }
  .vd-payment-amount { font-family: var(--cc-font-mono); font-weight: 600; font-size: 14px; }
  .vd-payment-meta { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); letter-spacing: 0.05em; margin-top: 2px; }
  .vd-payment-notes { font-size: 11px; color: var(--cc-muted); margin-top: 4px; }
  .vd-payment-balance { display: flex; justify-content: space-between; padding: 12px 16px; background: var(--cc-bg-alt); border-top: 1px solid var(--cc-line-soft); font-weight: 600; }
  .vd-payment-balance.paid { background: var(--cc-ok-soft); color: var(--cc-ok); }
  .vd-empty { padding: 14px 16px; color: var(--cc-muted); font-style: italic; font-size: 12px; text-align: center; }
  .vd-notes { padding: 14px 16px; font-size: 13px; line-height: 1.6; color: var(--cc-ink-soft); }

  .vd-panel { background: var(--cc-surface); border: 1px solid var(--cc-line); padding: 14px; }
  .vd-panel-hd { font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cc-muted); font-weight: 600; margin-bottom: 10px; }
  .vd-row { display: flex; justify-content: space-between; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--cc-line-soft); font-size: 12px; }
  .vd-row:last-child { border-bottom: none; }
  .vd-row span { color: var(--cc-muted); }
  .vd-row b { font-weight: 500; text-align: right; }
  .vd-link { color: var(--cc-ink); text-decoration: underline; cursor: pointer; font-size: 11px; }
  .vd-photo { width: 100%; aspect-ratio: 16/10; object-fit: cover; margin-bottom: 8px; border: 1px solid var(--cc-line-soft); }
  .loss-select, .loss-notes { width: 100%; padding: 10px 12px; border: 1px solid var(--cc-line); background: var(--cc-bg); font-family: inherit; font-size: 13px; color: var(--cc-ink); }
  .loss-label { display: block; font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cc-muted); font-weight: 500; margin-bottom: 6px; }
  .loss-notes { resize: vertical; min-height: 50px; }
`;
