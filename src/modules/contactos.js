// ============================================================
// CARCASH · MÓDULO CONTACTOS (BASE DE DATOS DEL CLIENTE)
// Rutas:
//   /contactos          → listado
//   /contactos/:id      → ficha individual
//
// Acceso (regulado por RLS):
//   - Admin (dueño/gerente): ve TODOS los contactos
//   - Vendedor: ve solo los contactos de SUS oportunidades
//   - Back office: ve todo lo operativo
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { state, isAdmin, isSupervisorOrAdmin, currentUserId } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { isValidEmail, isValidPhone } from '../lib/validators.js';
import { $, $$, el, toast, injectStyles, confirmDialog, debounce } from '../lib/dom.js';
import { navigate } from '../lib/router.js';

// ============================================================
// CONFIG
// ============================================================
const CONTACT_TYPES = [
  { id: 'persona_fisica', label: 'Persona física' },
  { id: 'empresa', label: 'Empresa' },
];

const COMMON_TAGS = ['VIP', 'recurrente', 'recomienda', 'moroso', 'crédito-aprobado', 'empresa', 'showroom'];

const PROVINCES = [
  'Buenos Aires', 'CABA', 'Catamarca', 'Chaco', 'Chubut', 'Córdoba', 'Corrientes', 'Entre Ríos',
  'Formosa', 'Jujuy', 'La Pampa', 'La Rioja', 'Mendoza', 'Misiones', 'Neuquén', 'Río Negro',
  'Salta', 'San Juan', 'San Luis', 'Santa Cruz', 'Santa Fe', 'Santiago del Estero',
  'Tierra del Fuego', 'Tucumán',
];

const local = {
  contacts: [],
  contact: null,         // ficha individual
  oppsHistory: [],
  salesHistory: [],
  team: [],
  branches: {},          // id → nombre de sucursal
  filters: {
    seller: 'todos',
    tag: 'todos',
    type: 'todos',
    state: 'todos',      // todos | recurrentes | vip | activos | compradores
    branch: 'todos',
    brand: 'todos',
    year: 'todos',       // año de compra
    amount: 'todos',     // todos | 30000 | 50000 | 70000 | 100000
    sort: 'nombre',      // nombre | gasto | compras | recientes
    search: '',
  },
  searchHandler: null,
};

const AMOUNT_TIERS = [30000, 50000, 70000, 100000];

// ============================================================
// MOUNT
// ============================================================
export async function mount(params = {}) {
  injectStyles('contactos-styles', styles);
  if (params.id) {
    await renderDetail(params.id);
  } else {
    await renderList();
    if (params.new) openContactModal(null);
  }
}

export default mount;

// ============================================================
// FETCH
// ============================================================
async function fetchContacts() {
  const { data, error } = await supabase
    .from('contacts')
    .select(`
      id, type, full_name, company_name, dni_cuit, phone, email,
      city, province, profession, is_recurrent, customer_since,
      tags, notes, created_at,
      opportunities:opportunities!contact_id(id, stage, assigned_to, expected_amount, final_amount, unit:units!unit_of_interest_id(brand, year, branch_id)),
      sales:sales!buyer_contact_id(id, sale_price, status, signed_at, created_at, unit:units!unit_id(brand, year, branch_id))
    `)
    .is('deleted_at', null)
    .order('full_name');
  if (error) {
    console.error(error);
    toast('Error cargando contactos', error.message, 'error');
    return [];
  }
  // Sucursales (para el filtro por sucursal)
  const { data: brs } = await supabase.from('branches').select('id, name').order('name');
  local.branches = {};
  (brs || []).forEach(b => { local.branches[b.id] = b.name; });
  return data || [];
}

async function fetchContact(id) {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function fetchOpps(contactId) {
  const { data } = await supabase
    .from('opportunities')
    .select(`
      id, opp_code, stage, origin, expected_amount, ai_score,
      created_at, won_at, lost_at, loss_reason,
      assignee:users_profile!assigned_to(full_name),
      unit:units!unit_of_interest_id(brand, model, year)
    `)
    .eq('contact_id', contactId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  return data || [];
}

async function fetchSales(contactId) {
  const { data } = await supabase
    .from('sales')
    .select(`
      id, sale_code, sale_price, status, created_at,
      unit:units!unit_id(brand, model, year),
      seller:users_profile!seller_user_id(full_name)
    `)
    .eq('buyer_contact_id', contactId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  return data || [];
}

async function fetchTeam() {
  const { data } = await supabase
    .from('users_profile')
    .select('id, full_name')
    .eq('active', true)
    .in('role', ['vendedor', 'gerente', 'dueno'])
    .order('full_name');
  return data || [];
}

// ============================================================
// VISTA: LISTADO
// ============================================================
async function renderList() {
  $('#view').innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">MÓDULO 04 · COMERCIAL</div>
          <div class="page-title">Base de <i>contactos</i></div>
          <div class="page-sub" id="ct-meta">Cargando…</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-ghost" id="btn-refresh">Actualizar</button>
          <button class="btn btn-ghost" id="btn-import">⭱ Importar</button>
          <button class="btn" id="btn-new-contact">+ Nuevo contacto</button>
        </div>
      </div>
      <div class="filters" id="filters"></div>
    </div>
    <div class="contactos-list" id="contactos-list">
      <div class="empty">Cargando contactos…</div>
    </div>
  `;

  // Cargar en paralelo
  [local.contacts, local.team] = await Promise.all([fetchContacts(), fetchTeam()]);
  local.contacts.forEach(enrich);

  renderFilters();
  renderListBody();
  attachListHandlers();
}

/** Calcula estadísticas de compra/interés por contacto (para filtros y orden). */
function enrich(c) {
  const sales = (c.sales || []).filter(s => s.status !== 'cancelada');
  const opps = c.opportunities || [];
  const brands = new Set();
  const years = new Set();
  const branches = new Set();
  let totalSpent = 0, maxPurchase = 0;
  for (const s of sales) {
    const amt = parseFloat(s.sale_price) || 0;
    totalSpent += amt;
    if (amt > maxPurchase) maxPurchase = amt;
    if (s.unit?.brand) brands.add(s.unit.brand);
    if (s.unit?.branch_id) branches.add(s.unit.branch_id);
    const y = new Date(s.signed_at || s.created_at).getFullYear();
    if (!isNaN(y)) years.add(y);
  }
  let maxOppAmount = 0;
  for (const o of opps) {
    if (o.unit?.brand) brands.add(o.unit.brand);
    if (o.unit?.branch_id) branches.add(o.unit.branch_id);
    const a = parseFloat(o.final_amount || o.expected_amount) || 0;
    if (a > maxOppAmount) maxOppAmount = a;
  }
  if (c.customer_since) { const y = new Date(c.customer_since).getFullYear(); if (!isNaN(y)) years.add(y); }
  c._stats = {
    purchaseCount: sales.length,
    totalSpent,
    maxPurchase,
    topAmount: Math.max(maxPurchase, maxOppAmount),
    brands,
    years,
    branches,
    activeOpps: opps.filter(o => !['ganada', 'perdida'].includes(o.stage)).length,
  };
}

function allBrands() {
  const set = new Set();
  local.contacts.forEach(c => c._stats?.brands.forEach(b => set.add(b)));
  return Array.from(set).sort();
}
function allYears() {
  const set = new Set();
  local.contacts.forEach(c => c._stats?.years.forEach(y => set.add(y)));
  return Array.from(set).sort((a, b) => b - a);
}

function renderFilters() {
  const c = $('#filters');
  c.innerHTML = '';

  // Filtro por vendedor (dueño / gerente / supervisor)
  if (isSupervisorOrAdmin() && local.team.length > 0) {
    c.appendChild(el('div', { class: 'filter-group' },
      el('span', { class: 'filter-lbl' }, 'Vendedor'),
      el('select', { class: 'filter-select', id: 'filter-seller' },
        el('option', { value: 'todos', selected: local.filters.seller === 'todos' }, 'Todos'),
        ...local.team.map(t =>
          el('option', { value: t.id, selected: local.filters.seller === t.id }, t.full_name.split(' ')[0])
        )
      )
    ));
  }

  // Marca (de compra o de interés)
  const brands = allBrands();
  if (brands.length) {
    c.appendChild(el('div', { class: 'filter-group' },
      el('span', { class: 'filter-lbl' }, 'Marca'),
      el('select', { class: 'filter-select', id: 'filter-brand' },
        el('option', { value: 'todos', selected: local.filters.brand === 'todos' }, 'Todas'),
        ...brands.map(b => el('option', { value: b, selected: local.filters.brand === b }, b))
      )
    ));
  }

  // Sucursal (de la unidad comprada o de interés)
  const branchEntries = Object.entries(local.branches || {});
  if (branchEntries.length) {
    c.appendChild(el('div', { class: 'filter-group' },
      el('span', { class: 'filter-lbl' }, 'Sucursal'),
      el('select', { class: 'filter-select', id: 'filter-branch' },
        el('option', { value: 'todos', selected: local.filters.branch === 'todos' }, 'Todas'),
        ...branchEntries.map(([id, name]) => el('option', { value: id, selected: local.filters.branch === id }, name))
      )
    ));
  }

  // Año de compra
  const years = allYears();
  if (years.length) {
    c.appendChild(el('div', { class: 'filter-group' },
      el('span', { class: 'filter-lbl' }, 'Año compra'),
      el('select', { class: 'filter-select', id: 'filter-year' },
        el('option', { value: 'todos', selected: local.filters.year === 'todos' }, 'Todos'),
        ...years.map(y => el('option', { value: String(y), selected: local.filters.year === String(y) }, String(y)))
      )
    ));
  }

  // Monto (compra/estimado superior a)
  c.appendChild(el('div', { class: 'filter-group' },
    el('span', { class: 'filter-lbl' }, 'Monto (USD)'),
    el('div', { class: 'filter-chips', id: 'filter-amount' },
      chipEl('todos', 'Todos', local.filters.amount === 'todos'),
      ...AMOUNT_TIERS.map(t => chipEl(String(t), '+' + (t / 1000) + 'k', local.filters.amount === String(t))),
    )
  ));

  // Tipo
  c.appendChild(el('div', { class: 'filter-group' },
    el('span', { class: 'filter-lbl' }, 'Tipo'),
    el('div', { class: 'filter-chips', id: 'filter-type' },
      chipEl('todos', 'Todos', local.filters.type === 'todos'),
      chipEl('persona_fisica', 'Personas', local.filters.type === 'persona_fisica'),
      chipEl('empresa', 'Empresas', local.filters.type === 'empresa'),
    )
  ));

  // Estado
  c.appendChild(el('div', { class: 'filter-group' },
    el('span', { class: 'filter-lbl' }, 'Estado'),
    el('div', { class: 'filter-chips', id: 'filter-state' },
      chipEl('todos', 'Todos', local.filters.state === 'todos'),
      chipEl('compradores', 'Compradores', local.filters.state === 'compradores'),
      chipEl('recurrentes', 'Recurrentes', local.filters.state === 'recurrentes'),
      chipEl('vip', 'VIP', local.filters.state === 'vip'),
      chipEl('activos', 'Con opp activa', local.filters.state === 'activos'),
    )
  ));

  // Orden
  c.appendChild(el('div', { class: 'filter-group' },
    el('span', { class: 'filter-lbl' }, 'Orden'),
    el('select', { class: 'filter-select', id: 'filter-sort' },
      el('option', { value: 'nombre', selected: local.filters.sort === 'nombre' }, 'Nombre A-Z'),
      el('option', { value: 'gasto', selected: local.filters.sort === 'gasto' }, 'Mayor gasto'),
      el('option', { value: 'compras', selected: local.filters.sort === 'compras' }, 'Más compras'),
      el('option', { value: 'recientes', selected: local.filters.sort === 'recientes' }, 'Más recientes'),
    )
  ));
}

function chipEl(value, label, active) {
  return el('div', {
    class: 'filter-chip' + (active ? ' active' : ''),
    dataset: { value },
  }, label);
}

function getFiltered() {
  const f = local.filters;
  const list = local.contacts.filter(c => {
    const st = c._stats || {};
    // Vendedor
    if (f.seller !== 'todos') {
      const hasOppWithSeller = (c.opportunities || []).some(o => o.assigned_to === f.seller);
      if (!hasOppWithSeller) return false;
    }
    // Tipo
    if (f.type !== 'todos' && c.type !== f.type) return false;
    // Marca (compra o interés)
    if (f.brand !== 'todos' && !st.brands?.has(f.brand)) return false;
    // Sucursal (de la unidad comprada o de interés)
    if (f.branch !== 'todos' && !st.branches?.has(f.branch)) return false;
    // Año de compra
    if (f.year !== 'todos' && !st.years?.has(parseInt(f.year, 10))) return false;
    // Monto superior a
    if (f.amount !== 'todos' && (st.topAmount || 0) < parseInt(f.amount, 10)) return false;
    // Estado
    if (f.state === 'compradores' && !(st.purchaseCount > 0)) return false;
    if (f.state === 'recurrentes' && !(c.is_recurrent || st.purchaseCount > 1)) return false;
    if (f.state === 'vip' && !(c.tags || []).includes('VIP')) return false;
    if (f.state === 'activos' && !(st.activeOpps > 0)) return false;
    // Búsqueda
    if (f.search) {
      const q = f.search.toLowerCase();
      const hay = [c.full_name, c.company_name, c.dni_cuit, c.phone, c.email, c.city, c.profession]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Orden
  const by = f.sort;
  list.sort((a, b) => {
    const sa = a._stats || {}, sb = b._stats || {};
    if (by === 'gasto') return (sb.totalSpent || 0) - (sa.totalSpent || 0);
    if (by === 'compras') return (sb.purchaseCount || 0) - (sa.purchaseCount || 0);
    if (by === 'recientes') return new Date(b.created_at) - new Date(a.created_at);
    return (a.full_name || '').localeCompare(b.full_name || '');
  });
  return list;
}

function renderListBody() {
  const list = $('#contactos-list');
  const filtered = getFiltered();
  const meta = $('#ct-meta');

  // Stats (sobre el resultado filtrado)
  const compradores = filtered.filter(c => (c._stats?.purchaseCount || 0) > 0).length;
  const facturado = filtered.reduce((a, c) => a + (c._stats?.totalSpent || 0), 0);
  const vip = filtered.filter(c => (c.tags || []).includes('VIP')).length;

  meta.innerHTML = `
    <b>${filtered.length}</b> de ${local.contacts.length} contactos · <b>${compradores}</b> compradores · <b>${vip}</b> VIP${facturado ? ` · facturado <b>USD ${escapeHtml(fmt.compact(facturado))}</b>` : ''}
  `;

  if (!local.contacts.length) {
    list.innerHTML = `
      <div class="ct-empty">
        <div class="ct-empty-title">Todavía no hay contactos cargados</div>
        <div class="ct-empty-desc">Cargá el primero desde "+ Nuevo contacto" o se crean automáticamente cuando entran leads por los hubs de integraciones.</div>
      </div>
    `;
    return;
  }
  if (!filtered.length) {
    list.innerHTML = `<div class="empty">Ningún resultado con esos filtros</div>`;
    return;
  }

  list.innerHTML = `
    <div class="ct-table">
      <div class="ct-head">
        <div>Nombre</div>
        <div class="ct-col-hide">Contacto</div>
        <div class="ct-col-hide">DNI/CUIT</div>
        <div class="ct-col-hide">Ubicación</div>
        <div>Opps</div>
        <div>Tags</div>
      </div>
      ${filtered.map(contactRow).join('')}
    </div>
  `;
}

function contactRow(c) {
  const opps = c.opportunities || [];
  const active = opps.filter(o => !['ganada', 'perdida'].includes(o.stage)).length;
  const won = opps.filter(o => o.stage === 'ganada').length;
  const initials = fmt.initials(c.full_name);

  return `
    <a class="ct-row" data-route="/contactos/${c.id}">
      <div class="ct-cell-name">
        <div class="ct-avatar">${escapeHtml(initials)}</div>
        <div class="ct-name-block">
          <div class="ct-name">
            ${escapeHtml(c.full_name)}
            ${c.is_recurrent ? '<span class="badge badge-info ct-mini-badge">REC</span>' : ''}
            ${c.type === 'empresa' ? '<span class="badge ct-mini-badge">EMP</span>' : ''}
          </div>
          <div class="ct-name-sub">${escapeHtml(c.profession || c.company_name || (c.type === 'empresa' ? 'Empresa' : 'Persona física'))}</div>
        </div>
      </div>
      <div class="ct-col-hide">
        <div>${escapeHtml(fmt.phone(c.phone))}</div>
        <div class="ct-meta">${escapeHtml(c.email || '—')}</div>
      </div>
      <div class="ct-col-hide ct-mono">${escapeHtml(c.dni_cuit || '—')}</div>
      <div class="ct-col-hide">${escapeHtml([c.city, c.province].filter(Boolean).join(', ') || '—')}</div>
      <div class="ct-opps">
        ${active > 0 ? `<span class="ct-opp-badge active">${active} activa${active > 1 ? 's' : ''}</span>` : ''}
        ${(c._stats?.purchaseCount || 0) > 0 ? `<span class="ct-opp-badge won">${c._stats.purchaseCount} compra${c._stats.purchaseCount > 1 ? 's' : ''} · USD ${escapeHtml(fmt.compact(c._stats.totalSpent))}</span>` : (won > 0 ? `<span class="ct-opp-badge won">${won} ✓</span>` : '')}
        ${active === 0 && won === 0 && !(c._stats?.purchaseCount) ? '<span class="ct-meta">—</span>' : ''}
      </div>
      <div class="ct-tags">
        ${(c.tags || []).slice(0, 3).map(t => `<span class="ct-tag-chip ${t === 'VIP' ? 'vip' : ''}">${escapeHtml(t)}</span>`).join('')}
      </div>
    </a>
  `;
}

function attachListHandlers() {
  $('#btn-refresh').addEventListener('click', () => mount());
  $('#btn-new-contact').addEventListener('click', () => openContactModal(null));
  $('#btn-import').addEventListener('click', () => openImportModal());

  $('#filters').addEventListener('click', (e) => {
    const c = e.target.closest('.filter-chip');
    if (!c) return;
    const parent = c.parentElement;
    if (parent.id === 'filter-type') local.filters.type = c.dataset.value;
    else if (parent.id === 'filter-state') local.filters.state = c.dataset.value;
    else if (parent.id === 'filter-amount') local.filters.amount = c.dataset.value;
    parent.querySelectorAll('.filter-chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    renderListBody();
  });

  $('#filter-seller')?.addEventListener('change', (e) => {
    local.filters.seller = e.target.value;
    renderListBody();
  });
  $('#filter-brand')?.addEventListener('change', (e) => { local.filters.brand = e.target.value; renderListBody(); });
  $('#filter-branch')?.addEventListener('change', (e) => { local.filters.branch = e.target.value; renderListBody(); });
  $('#filter-year')?.addEventListener('change', (e) => { local.filters.year = e.target.value; renderListBody(); });
  $('#filter-sort')?.addEventListener('change', (e) => { local.filters.sort = e.target.value; renderListBody(); });

  // Búsqueda con topbar
  const searchInput = $('#search');
  if (searchInput) {
    if (local.searchHandler) searchInput.removeEventListener('input', local.searchHandler);
    local.searchHandler = debounce((e) => {
      local.filters.search = e.target.value.trim();
      renderListBody();
    }, 200);
    searchInput.addEventListener('input', local.searchHandler);
    searchInput.value = local.filters.search || '';
  }
}

// ============================================================
// VISTA: FICHA INDIVIDUAL
// ============================================================
async function renderDetail(id) {
  $('#view').innerHTML = `<div class="empty">Cargando contacto…</div>`;
  try {
    local.contact = await fetchContact(id);
    if (!local.contact) {
      $('#view').innerHTML = `
        <div class="placeholder">
          <div class="placeholder-content">
            <div class="placeholder-num">404</div>
            <div class="placeholder-title">Contacto no <i>encontrado</i></div>
            <div class="placeholder-status" style="cursor:pointer" onclick="location.hash='#/contactos'">VOLVER</div>
          </div>
        </div>
      `;
      return;
    }
    [local.oppsHistory, local.salesHistory] = await Promise.all([
      fetchOpps(id), fetchSales(id),
    ]);
    renderDetailUI();
  } catch (err) {
    toast('Error', err.message, 'error');
  }
}

function renderDetailUI() {
  const c = local.contact;
  const opps = local.oppsHistory;
  const sales = local.salesHistory;

  const activeOpps = opps.filter(o => !['ganada', 'perdida'].includes(o.stage));
  const wonOpps = opps.filter(o => o.stage === 'ganada');
  const lostOpps = opps.filter(o => o.stage === 'perdida');
  const lifetimeValue = sales.filter(s => s.status !== 'cancelada').reduce((s, x) => s + (parseFloat(x.sale_price) || 0), 0);

  // Mensajes pre-armados para WSP/email
  const wspPhone = c.phone ? String(c.phone).replace(/\D/g, '') : '';
  const wspMsg = `Hola ${c.full_name.split(' ')[0]}, ¿cómo estás? Te escribo desde CarCash.`;
  const wspUrl = wspPhone ? `https://wa.me/${wspPhone}?text=${encodeURIComponent(wspMsg)}` : null;
  const mailUrl = c.email ? `mailto:${c.email}?subject=${encodeURIComponent('CarCash · Consulta')}` : null;
  const callUrl = c.phone ? `tel:${String(c.phone).replace(/\s/g, '')}` : null;

  $('#view').innerHTML = `
    <div class="ct-detail">
      <div class="ct-d-hd">
        <div class="ct-d-hd-row">
          <div>
            <div class="ct-d-back"><a data-route="/contactos">← Contactos</a></div>
            <div class="ct-d-id-row">
              ${c.type === 'empresa' ? 'EMPRESA' : 'PERSONA FÍSICA'}
              ${c.dni_cuit ? ` · ${escapeHtml(c.dni_cuit)}` : ''}
              ${c.is_recurrent ? ' · CLIENTE RECURRENTE' : ''}
              ${c.customer_since ? ` · CLIENTE DESDE ${escapeHtml(fmt.dateAR(c.customer_since).toUpperCase())}` : ''}
            </div>
            <div class="ct-d-name">${escapeHtml(c.full_name)}</div>
            ${c.profession ? `<div class="ct-d-prof">${escapeHtml(c.profession)}</div>` : ''}
            <div class="ct-d-tags">
              ${(c.tags || []).map(t => `<span class="ct-tag-chip ${t === 'VIP' ? 'vip' : ''}">${escapeHtml(t)}</span>`).join('')}
            </div>
          </div>
          <div class="ct-d-actions">
            ${wspUrl ? `<a class="btn btn-ok btn-sm" href="${wspUrl}" target="_blank" rel="noopener">● WhatsApp</a>` : ''}
            ${callUrl ? `<a class="btn btn-ghost btn-sm" href="${callUrl}">☎ Llamar</a>` : ''}
            ${mailUrl ? `<a class="btn btn-ghost btn-sm" href="${mailUrl}">✉ Email</a>` : ''}
            <button class="btn btn-sm" id="btn-new-opp">+ Nueva oportunidad</button>
            <button class="btn btn-ghost btn-sm" id="btn-edit">Editar</button>
          </div>
        </div>
      </div>

      <!-- KPIs del contacto -->
      <div class="ct-d-kpis">
        ${kpi('Oportunidades activas', activeOpps.length)}
        ${kpi('Ventas cerradas', wonOpps.length)}
        ${kpi('Lifetime value', lifetimeValue > 0 ? 'USD ' + fmt.compact(lifetimeValue) : '—')}
        ${kpi('Perdidas', lostOpps.length)}
      </div>

      <div class="ct-d-body">
        <!-- IZQ: histórico opps + ventas -->
        <div class="ct-d-col">
          <div class="ct-d-section">
            <div class="ct-d-section-hd">
              <span>Histórico de oportunidades</span>
              <span class="ct-d-section-meta">${opps.length}</span>
            </div>
            ${renderOppsHistory(opps)}
          </div>

          <div class="ct-d-section">
            <div class="ct-d-section-hd">
              <span>Histórico de ventas</span>
              <span class="ct-d-section-meta">${sales.length}</span>
            </div>
            ${renderSalesHistory(sales)}
          </div>
        </div>

        <!-- DER: datos personales + notas -->
        <div class="ct-d-col-side">
          <div class="ct-d-panel">
            <div class="ct-d-panel-hd">Datos de contacto</div>
            <div class="ct-d-row"><span>Teléfono</span><b>${escapeHtml(fmt.phone(c.phone))}</b></div>
            ${c.phone_secondary ? `<div class="ct-d-row"><span>Tel. alt.</span><b>${escapeHtml(fmt.phone(c.phone_secondary))}</b></div>` : ''}
            <div class="ct-d-row"><span>Email</span><b>${escapeHtml(c.email || '—')}</b></div>
            ${c.whatsapp_id ? `<div class="ct-d-row"><span>WhatsApp ID</span><b class="ct-mono">${escapeHtml(c.whatsapp_id)}</b></div>` : ''}
          </div>

          ${(c.address || c.city || c.province) ? `
            <div class="ct-d-panel">
              <div class="ct-d-panel-hd">Ubicación</div>
              ${c.address ? `<div class="ct-d-row"><span>Dirección</span><b>${escapeHtml(c.address)}</b></div>` : ''}
              ${c.city ? `<div class="ct-d-row"><span>Ciudad</span><b>${escapeHtml(c.city)}</b></div>` : ''}
              ${c.province ? `<div class="ct-d-row"><span>Provincia</span><b>${escapeHtml(c.province)}</b></div>` : ''}
              ${c.postal_code ? `<div class="ct-d-row"><span>CP</span><b>${escapeHtml(c.postal_code)}</b></div>` : ''}
            </div>
          ` : ''}

          ${c.notes ? `
            <div class="ct-d-panel">
              <div class="ct-d-panel-hd">Notas</div>
              <div class="ct-d-notes">${escapeHtml(c.notes)}</div>
            </div>
          ` : ''}

          <div class="ct-d-panel">
            <div class="ct-d-panel-hd">Privacidad</div>
            <div class="ct-d-row"><span>Acepta marketing</span><b>${c.accepts_marketing ? '✓ Sí' : '✗ No'}</b></div>
          </div>
        </div>
      </div>
    </div>
  `;

  attachDetailHandlers();
}

function kpi(label, value) {
  return `
    <div class="ct-d-kpi">
      <div class="ct-d-kpi-label">${escapeHtml(label)}</div>
      <div class="ct-d-kpi-value">${escapeHtml(String(value))}</div>
    </div>
  `;
}

function renderOppsHistory(opps) {
  if (!opps.length) {
    return `<div class="ct-d-empty">Sin oportunidades registradas</div>`;
  }
  return `<div class="ct-d-list">
    ${opps.map(o => `
      <a class="ct-d-row-link" data-route="/pipeline/${o.opp_code.toLowerCase()}">
        <div class="ct-dl-stage stage-${o.stage}"></div>
        <div class="ct-dl-info">
          <div class="ct-dl-title">
            ${escapeHtml(o.opp_code)} · ${escapeHtml(stageName(o.stage))}
            ${o.ai_score != null ? `<span class="ct-dl-score">${o.ai_score}</span>` : ''}
          </div>
          <div class="ct-dl-sub">
            ${escapeHtml([o.unit?.brand, o.unit?.model, o.unit?.year ? `'${String(o.unit.year).slice(2)}` : null].filter(Boolean).join(' ') || 'Sin unidad')}
            · ${escapeHtml(o.assignee?.full_name || '—')}
          </div>
        </div>
        <div class="ct-dl-meta">
          <div>USD ${escapeHtml(fmt.compact(o.expected_amount))}</div>
          <div class="ct-dl-time">${escapeHtml(fmt.relative(o.created_at))}</div>
        </div>
      </a>
    `).join('')}
  </div>`;
}

function renderSalesHistory(sales) {
  if (!sales.length) {
    return `<div class="ct-d-empty">Aún no compró nada</div>`;
  }
  return `<div class="ct-d-list">
    ${sales.map(s => `
      <a class="ct-d-row-link" data-route="/ventas/${s.sale_code.toLowerCase()}">
        <div class="ct-dl-stage stage-ganada"></div>
        <div class="ct-dl-info">
          <div class="ct-dl-title">${escapeHtml(s.sale_code)} · ${escapeHtml(s.status.toUpperCase())}</div>
          <div class="ct-dl-sub">
            ${escapeHtml([s.unit?.brand, s.unit?.model, s.unit?.year ? `'${String(s.unit.year).slice(2)}` : null].filter(Boolean).join(' '))}
            · ${escapeHtml(s.seller?.full_name || '—')}
          </div>
        </div>
        <div class="ct-dl-meta">
          <div><b>USD ${escapeHtml(fmt.usd(s.sale_price))}</b></div>
          <div class="ct-dl-time">${escapeHtml(fmt.dateAR(s.created_at))}</div>
        </div>
      </a>
    `).join('')}
  </div>`;
}

function stageName(s) {
  const m = {
    nuevo: 'Nuevo', contactado: 'Contactado', visita_test: 'Visita',
    presupuesto: 'Presupuesto', negociacion: 'Negociación',
    reserva: 'Reserva', ganada: 'Ganada', perdida: 'Perdida',
  };
  return m[s] || s;
}

function attachDetailHandlers() {
  $('#btn-edit').addEventListener('click', () => openContactModal(local.contact));
  $('#btn-new-opp').addEventListener('click', () => navigate(`/pipeline/nueva?contact=${local.contact.id}`));
  $('#view').addEventListener('click', (e) => {
    const link = e.target.closest('[data-route]');
    if (link) {
      e.preventDefault();
      navigate(link.dataset.route);
    }
  });
}

// ============================================================
// MODAL: ALTA / EDICIÓN DE CONTACTO
// ============================================================
function openContactModal(existing) {
  const isEdit = !!existing;
  const c = existing || {};

  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', style: { maxWidth: '640px' } });

  modal.appendChild(el('div', { class: 'modal-hd' },
    el('h3', {}, isEdit ? `Editar ${c.full_name}` : 'Nuevo contacto'),
    el('button', { class: 'modal-close', onClick: () => close() }, '×')
  ));

  modal.appendChild(el('div', { class: 'modal-body' },
    el('div', { class: 'cm-form' },
      // Tipo
      el('div', { class: 'field-row' },
        field('Tipo', el('select', { id: 'cm-type', class: 'loss-select' },
          ...CONTACT_TYPES.map(t => el('option', { value: t.id, selected: (c.type || 'persona_fisica') === t.id }, t.label))
        )),
        field('DNI / CUIT', el('input', { type: 'text', id: 'cm-dni', class: 'loss-select', value: c.dni_cuit || '' })),
      ),
      // Nombre
      field('Nombre completo *', el('input', { type: 'text', id: 'cm-name', class: 'loss-select', value: c.full_name || '', required: true })),
      // Empresa (si aplica)
      field('Razón social (si es empresa)', el('input', { type: 'text', id: 'cm-company', class: 'loss-select', value: c.company_name || '' })),
      // Contacto
      el('div', { class: 'field-row' },
        field('Teléfono', el('input', { type: 'text', id: 'cm-phone', class: 'loss-select', placeholder: '+54 9 11 ...', value: c.phone || '' })),
        field('Teléfono alt.', el('input', { type: 'text', id: 'cm-phone2', class: 'loss-select', value: c.phone_secondary || '' })),
      ),
      el('div', { class: 'field-row' },
        field('Email', el('input', { type: 'email', id: 'cm-email', class: 'loss-select', value: c.email || '' })),
        field('Profesión', el('input', { type: 'text', id: 'cm-profession', class: 'loss-select', value: c.profession || '' })),
      ),
      // Ubicación
      field('Dirección', el('input', { type: 'text', id: 'cm-address', class: 'loss-select', value: c.address || '' })),
      el('div', { class: 'field-row' },
        field('Ciudad', el('input', { type: 'text', id: 'cm-city', class: 'loss-select', value: c.city || '' })),
        field('Provincia', el('select', { id: 'cm-province', class: 'loss-select' },
          el('option', { value: '' }, '—'),
          ...PROVINCES.map(p => el('option', { value: p, selected: c.province === p }, p))
        )),
        field('CP', el('input', { type: 'text', id: 'cm-cp', class: 'loss-select', value: c.postal_code || '' })),
      ),
      // Tags
      el('div', { class: 'field' },
        el('label', { class: 'loss-label' }, 'Tags'),
        el('input', { type: 'text', id: 'cm-tags', class: 'loss-select', value: (c.tags || []).join(', '), placeholder: 'VIP, recurrente, recomienda…' }),
        el('div', { class: 'cm-tag-suggest' },
          ...COMMON_TAGS.map(t => el('button', {
            type: 'button', class: 'cm-tag-suggest-btn',
            onClick: () => {
              const inp = $('#cm-tags');
              const current = inp.value.split(',').map(x => x.trim()).filter(Boolean);
              if (!current.includes(t)) {
                current.push(t);
                inp.value = current.join(', ');
              }
            },
          }, '+ ' + t))
        )
      ),
      // Notas
      field('Notas', el('textarea', { id: 'cm-notes', class: 'loss-notes', rows: '3', placeholder: 'Cualquier detalle relevante del cliente' }, c.notes || '')),
      // Marketing
      el('label', { class: 'cm-cb' },
        el('input', { type: 'checkbox', id: 'cm-marketing', checked: !!c.accepts_marketing }),
        el('span', {}, 'Acepta recibir comunicaciones de marketing (Ley 25.326)')
      ),
    )
  ));

  modal.appendChild(el('div', { class: 'modal-actions' },
    isEdit ? el('button', { class: 'btn btn-danger btn-sm', onClick: async () => {
      const ok = await confirmDialog(`¿Eliminar a ${c.full_name}? Soft delete · se mantiene el historial.`, { okText: 'Eliminar' });
      if (!ok) return;
      const { error } = await supabase
        .from('contacts')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', c.id);
      if (error) { toast('Error', error.message, 'error'); return; }
      toast('Contacto eliminado', null, 'warn');
      close();
      navigate('/contactos');
    } }, 'Eliminar') : null,
    el('div', { style: { flex: '1' } }),
    el('button', { class: 'btn btn-ghost', onClick: () => close() }, 'Cancelar'),
    el('button', { class: 'btn btn-ok', onClick: () => saveContact(existing, close) }, isEdit ? 'Guardar' : 'Crear contacto'),
  ));

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  function close() { backdrop.remove(); }
  setTimeout(() => $('#cm-name')?.focus(), 100);
}

async function saveContact(existing, closeFn) {
  const tagsRaw = $('#cm-tags').value;
  const tags = tagsRaw ? tagsRaw.split(',').map(s => s.trim()).filter(Boolean) : null;

  const payload = {
    type: $('#cm-type').value,
    full_name: $('#cm-name').value.trim(),
    company_name: $('#cm-company').value.trim() || null,
    dni_cuit: $('#cm-dni').value.trim() || null,
    phone: $('#cm-phone').value.trim() || null,
    phone_secondary: $('#cm-phone2').value.trim() || null,
    email: $('#cm-email').value.trim() || null,
    profession: $('#cm-profession').value.trim() || null,
    address: $('#cm-address').value.trim() || null,
    city: $('#cm-city').value.trim() || null,
    province: $('#cm-province').value || null,
    postal_code: $('#cm-cp').value.trim() || null,
    tags,
    notes: $('#cm-notes').value.trim() || null,
    accepts_marketing: $('#cm-marketing').checked,
  };

  if (!payload.full_name) {
    toast('Falta el nombre', null, 'warn');
    return;
  }
  if (payload.email && !isValidEmail(payload.email)) {
    toast('Email inválido', null, 'warn');
    return;
  }
  if (payload.phone && !isValidPhone(payload.phone)) {
    toast('Teléfono inválido', null, 'warn');
    return;
  }

  try {
    if (existing) {
      const { error } = await supabase.from('contacts').update(payload).eq('id', existing.id);
      if (error) throw error;
      toast('Contacto actualizado', payload.full_name, 'ok');
      closeFn();
      // Refrescar ficha
      if (local.contact?.id === existing.id) await renderDetail(existing.id);
      else await renderList();
    } else {
      payload.created_by = currentUserId();
      const { data, error } = await supabase.from('contacts').insert(payload).select('id').single();
      if (error) throw error;
      toast('Contacto creado', payload.full_name, 'ok');
      closeFn();
      navigate(`/contactos/${data.id}`);
    }
  } catch (err) {
    toast('Error guardando', err.message, 'error');
  }
}

function field(label, input) {
  return el('div', { class: 'field' },
    el('label', { class: 'loss-label' }, label),
    input,
  );
}

// ============================================================
// IMPORTAR CONTACTOS  (vCard de iPhone/Android, CSV, Excel)
// Cada contacto entra como lead del vendedor que importa.
// Dedup global por teléfono lo hace el RPC import_contacts_as_leads.
// ============================================================
function openImportModal() {
  let rows = [];
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', style: { maxWidth: '560px' } });
  modal.appendChild(el('div', { class: 'modal-hd' },
    el('h3', {}, 'Importar mis contactos'),
    el('button', { class: 'modal-close', onClick: () => close() }, '×')));
  const body = el('div', { class: 'modal-body' });
  body.innerHTML = `
    <div class="note" style="margin-bottom:14px">Cada contacto entra como <b>lead tuyo</b> en el pipeline. Los teléfonos repetidos se saltan solos.</div>
    <div class="imp-sources">
      <div><b>iPhone:</b> Contactos → seleccionar → Compartir → exportar <b>.vcf</b></div>
      <div><b>Android:</b> Contactos → Ajustes → Exportar a archivo <b>.vcf</b></div>
      <div><b>Excel:</b> archivo <b>.xlsx</b> o <b>.csv</b> con columnas nombre / teléfono / email</div>
    </div>
    <div class="imp-drop" id="imp-drop">
      <input type="file" id="imp-file" accept=".vcf,.csv,.xlsx,.xls,text/vcard,text/csv" hidden>
      <div class="imp-drop-ico">⭱</div>
      <div id="imp-drop-txt">Tocá para elegir el archivo (.vcf, .csv, .xlsx)</div>
    </div>
    <div id="imp-preview"></div>
  `;
  modal.appendChild(body);
  const actions = el('div', { class: 'modal-actions' },
    el('button', { class: 'btn btn-ghost', onClick: () => close() }, 'Cancelar'),
    el('button', { class: 'btn btn-ok', id: 'imp-go', onClick: () => doImport() }, 'Importar'));
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  actions.querySelector('#imp-go').disabled = true;
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  function close() { backdrop.remove(); }

  const fileInput = body.querySelector('#imp-file');
  body.querySelector('#imp-drop').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    body.querySelector('#imp-drop-txt').textContent = 'Leyendo ' + f.name + '…';
    try { rows = await parseContactsFile(f); }
    catch (err) { toast('No se pudo leer el archivo', err.message, 'danger'); rows = []; }
    renderPreview();
  });

  function renderPreview() {
    const valid = rows.filter(r => (r.phone && r.phone.replace(/\D/g, '').length >= 8) || r.email);
    const prev = body.querySelector('#imp-preview');
    const goBtn = actions.querySelector('#imp-go');
    if (!valid.length) {
      prev.innerHTML = `<div class="imp-empty">No se encontraron contactos con teléfono o email en el archivo.</div>`;
      body.querySelector('#imp-drop-txt').textContent = 'Tocá para elegir otro archivo';
      goBtn.disabled = true;
      return;
    }
    rows = valid;
    body.querySelector('#imp-drop-txt').textContent = '✓ ' + valid.length + ' contactos detectados — cambiar archivo';
    prev.innerHTML = `
      <div class="imp-count">${valid.length} contactos para importar</div>
      <div class="imp-sample">${valid.slice(0, 5).map(r =>
        `<div>${escapeHtml(r.name || '(sin nombre)')} · <span class="text-muted">${escapeHtml(r.phone || r.email || '')}</span></div>`).join('')}
        ${valid.length > 5 ? `<div class="text-muted">…y ${valid.length - 5} más</div>` : ''}</div>`;
    goBtn.disabled = false;
  }

  async function doImport() {
    const goBtn = actions.querySelector('#imp-go');
    goBtn.disabled = true; goBtn.textContent = 'Importando…';
    try {
      let imported = 0, skipped = 0;
      const CHUNK = 200;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK).map(r => ({
          name: r.name || null, phone: r.phone || null, email: r.email || null,
        }));
        const { data, error } = await supabase.rpc('import_contacts_as_leads', { p_rows: slice });
        if (error) throw error;
        imported += data.imported || 0; skipped += data.skipped || 0;
      }
      toast(`Importados ${imported}`, skipped ? `${skipped} repetidos saltados` : 'Sin repetidos', 'ok');
      close();
      mount();
    } catch (err) {
      toast('Error al importar', err.message, 'danger');
      goBtn.disabled = false; goBtn.textContent = 'Importar';
    }
  }
}

async function parseContactsFile(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const XLSX = await loadXLSX();
    const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return rowsFromTable(XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }));
  }
  const txt = await file.text();
  if (name.endsWith('.vcf') || /BEGIN:VCARD/i.test(txt)) return parseVCard(txt);
  return parseCSV(txt);
}

function parseVCard(text) {
  const out = [];
  for (const card of text.split(/END:VCARD/i)) {
    if (!/BEGIN:VCARD/i.test(card)) continue;
    let name = '', phone = '', email = '';
    for (let line of card.split(/\r?\n/)) {
      line = line.trim();
      const up = line.toUpperCase();
      const val = line.split(':').slice(1).join(':').trim();
      if (up.startsWith('FN')) name = val;
      else if (!name && up.startsWith('N:')) name = val.split(';').filter(Boolean).reverse().join(' ').trim();
      else if (up.startsWith('TEL') && !phone) phone = val;
      else if (up.startsWith('EMAIL') && !email) email = val;
    }
    if (name || phone || email) out.push({ name, phone, email });
  }
  return out;
}

function parseCSV(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const cells = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',' || ch === ';' || ch === '\t') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rowsFromTable(rows);
}

function rowsFromTable(rows) {
  if (!rows || !rows.length) return [];
  const norm = (s) => String(s == null ? '' : s).toLowerCase().trim();
  const header = rows[0].map(norm);
  const looksHeader = header.some(h => /nombre|name|contacto|apellido|tel|phone|cel|whatsapp|m[oó]vil|movil|email|correo|mail/.test(h));
  let nameIdx = -1, phoneIdx = -1, emailIdx = -1;
  if (looksHeader) {
    header.forEach((h, i) => {
      if (nameIdx < 0 && /nombre|name|contacto|apellido/.test(h)) nameIdx = i;
      if (phoneIdx < 0 && /tel|phone|cel|whatsapp|m[oó]vil|movil|n[uú]mero|numero/.test(h)) phoneIdx = i;
      if (emailIdx < 0 && /email|correo|mail|e-mail/.test(h)) emailIdx = i;
    });
  }
  const dataRows = looksHeader ? rows.slice(1) : rows;
  if (nameIdx < 0 && phoneIdx < 0 && emailIdx < 0) { nameIdx = 0; phoneIdx = 1; emailIdx = 2; }
  const out = [];
  for (const r of dataRows) {
    const name = nameIdx >= 0 ? String(r[nameIdx] == null ? '' : r[nameIdx]).trim() : '';
    const phone = phoneIdx >= 0 ? String(r[phoneIdx] == null ? '' : r[phoneIdx]).trim() : '';
    const email = emailIdx >= 0 ? String(r[emailIdx] == null ? '' : r[emailIdx]).trim() : '';
    if (name || phone || email) out.push({ name, phone, email });
  }
  return out;
}

let _xlsxPromise = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (_xlsxPromise) return _xlsxPromise;
  _xlsxPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('No se pudo cargar el lector de Excel'));
    document.head.appendChild(s);
  });
  return _xlsxPromise;
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

  /* IMPORTAR */
  .imp-sources { font-size: 11.5px; line-height: 1.7; color: var(--cc-muted); background: var(--cc-bg-alt); border: 1px solid var(--cc-line); padding: 10px 12px; margin-bottom: 14px; }
  .imp-sources b { color: var(--cc-ink); }
  .imp-drop { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 26px 16px; border: 1.5px dashed var(--cc-line); background: var(--cc-surface); cursor: pointer; text-align: center; transition: border-color .15s, background .15s; }
  .imp-drop:hover { border-color: var(--cc-champagne); background: var(--cc-bg-alt); }
  .imp-drop-ico { font-size: 26px; color: var(--cc-champagne); }
  #imp-drop-txt { font-size: 12.5px; color: var(--cc-muted); }
  .imp-count { font-family: var(--cc-font-mono); font-size: 11px; letter-spacing: 0.1em; color: var(--cc-ok); font-weight: 600; margin: 14px 0 6px; }
  .imp-sample { font-size: 12px; line-height: 1.7; }
  .imp-sample .text-muted { color: var(--cc-muted); }
  .imp-empty { font-size: 12.5px; color: var(--cc-warn); margin-top: 12px; }

  .filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .filter-group { display: flex; align-items: center; gap: 6px; }
  .filter-lbl { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--cc-muted); font-weight: 500; }
  .filter-chips { display: flex; gap: 0; border: 1px solid var(--cc-line); background: var(--cc-surface); }
  .filter-chip { padding: 6px 12px; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--cc-muted); cursor: pointer; font-weight: 500; border-right: 1px solid var(--cc-line); }
  .filter-chip:last-child { border-right: none; }
  .filter-chip.active { background: var(--cc-ink); color: var(--cc-bg); }
  .filter-select { padding: 6px 10px; border: 1px solid var(--cc-line); background: var(--cc-surface); font-family: inherit; font-size: 11px; }

  /* TABLA */
  .contactos-list { padding: 18px 20px 32px; }
  @container app (min-width: 900px) { .contactos-list { padding: 22px 32px 40px; } }
  .ct-empty { padding: 60px 24px; text-align: center; max-width: 480px; margin: 0 auto; }
  .ct-empty-title { font-family: var(--cc-font-display); font-weight: 400; font-size: 22px; margin-bottom: 8px; }
  .ct-empty-desc { font-size: 13px; color: var(--cc-muted); line-height: 1.5; }

  .ct-table { background: var(--cc-surface); border: 1px solid var(--cc-line); }
  .ct-head, .ct-row {
    display: grid;
    grid-template-columns: 2fr 1.4fr 1fr 1.2fr 110px 140px;
    gap: 12px;
    padding: 12px 16px;
    align-items: center;
    font-size: 12px;
  }
  .ct-head {
    font-family: var(--cc-font-mono);
    font-size: 9px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--cc-muted);
    background: var(--cc-bg-alt);
    border-bottom: 1px solid var(--cc-line);
    font-weight: 600;
  }
  .ct-row { border-bottom: 1px solid var(--cc-line-soft); cursor: pointer; text-decoration: none; color: inherit; }
  .ct-row:last-child { border-bottom: none; }
  .ct-row:hover { background: var(--cc-bg-alt); }
  @container app (max-width: 900px) {
    .ct-head { display: none; }
    .ct-row { grid-template-columns: 1fr; gap: 4px; padding: 14px 16px; }
    .ct-col-hide { display: none; }
  }

  .ct-cell-name { display: flex; gap: 10px; align-items: center; min-width: 0; }
  .ct-avatar {
    width: 32px; height: 32px; border-radius: 50%;
    background: linear-gradient(135deg, var(--cc-graphite), var(--cc-steel));
    color: var(--cc-bg);
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 600;
    flex-shrink: 0;
  }
  .ct-name-block { min-width: 0; flex: 1; }
  .ct-name { font-weight: 500; font-size: 13px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .ct-name-sub { font-size: 11px; color: var(--cc-muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ct-mini-badge { font-size: 8px; padding: 1px 5px; letter-spacing: 0.15em; }
  .ct-meta { font-size: 11px; color: var(--cc-muted); }
  .ct-mono { font-family: var(--cc-font-mono); font-size: 11px; }
  .ct-opps { display: flex; gap: 4px; flex-wrap: wrap; }
  .ct-opp-badge { font-family: var(--cc-font-mono); font-size: 9px; padding: 2px 6px; letter-spacing: 0.1em; }
  .ct-opp-badge.active { background: var(--cc-info-soft); color: var(--cc-info); border: 1px solid var(--cc-info); }
  .ct-opp-badge.won { background: var(--cc-ok-soft); color: var(--cc-ok); border: 1px solid var(--cc-ok); }
  .ct-tags { display: flex; gap: 4px; flex-wrap: wrap; }
  .ct-tag-chip { font-family: var(--cc-font-mono); font-size: 9px; padding: 2px 6px; background: var(--cc-bg-alt); border: 1px solid var(--cc-line); color: var(--cc-ink); letter-spacing: 0.05em; text-transform: uppercase; }
  .ct-tag-chip.vip { background: var(--cc-champagne); color: var(--cc-ink); border-color: var(--cc-champagne); font-weight: 600; }

  /* DETAIL */
  .ct-d-hd { padding: 22px 20px 14px; border-bottom: 1px solid var(--cc-line); background: var(--cc-surface); }
  @container app (min-width: 900px) { .ct-d-hd { padding: 28px 32px 18px; } }
  .ct-d-hd-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
  .ct-d-back { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.18em; color: var(--cc-muted); margin-bottom: 8px; }
  .ct-d-back a { color: var(--cc-muted); text-decoration: none; cursor: pointer; }
  .ct-d-back a:hover { color: var(--cc-ink); }
  .ct-d-id-row { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.16em; color: var(--cc-muted); margin-bottom: 6px; }
  .ct-d-name { font-family: var(--cc-font-display); font-weight: 300; font-size: 32px; letter-spacing: -0.02em; line-height: 1.05; }
  @container app (min-width: 700px) { .ct-d-name { font-size: 38px; } }
  .ct-d-prof { font-family: var(--cc-font-display); font-style: italic; font-size: 14px; color: var(--cc-muted); margin-top: 4px; }
  .ct-d-tags { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
  .ct-d-actions { display: flex; gap: 6px; flex-wrap: wrap; }

  .ct-d-kpis { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1px; background: var(--cc-line); border-bottom: 1px solid var(--cc-line); }
  @container app (min-width: 700px) { .ct-d-kpis { grid-template-columns: repeat(4, 1fr); } }
  .ct-d-kpi { background: var(--cc-surface); padding: 14px 16px; }
  .ct-d-kpi-label { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cc-muted); margin-bottom: 4px; }
  .ct-d-kpi-value { font-family: var(--cc-font-display); font-weight: 400; font-size: 22px; line-height: 1; }

  .ct-d-body { display: grid; grid-template-columns: 1fr; gap: 1px; background: var(--cc-line); }
  @container app (min-width: 900px) { .ct-d-body { grid-template-columns: 1.5fr 1fr; } }
  .ct-d-col, .ct-d-col-side { background: var(--cc-bg); padding: 18px 20px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
  @container app (min-width: 900px) { .ct-d-col { padding: 22px 28px; } }

  .ct-d-section, .ct-d-panel { background: var(--cc-surface); border: 1px solid var(--cc-line); }
  .ct-d-section-hd, .ct-d-panel-hd { padding: 12px 16px; border-bottom: 1px solid var(--cc-line-soft); display: flex; justify-content: space-between; font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; font-weight: 600; }
  .ct-d-section-meta { color: var(--cc-muted); font-weight: 400; letter-spacing: 0.1em; }

  .ct-d-list { display: flex; flex-direction: column; }
  .ct-d-row-link { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--cc-line-soft); text-decoration: none; color: inherit; cursor: pointer; }
  .ct-d-row-link:last-child { border-bottom: none; }
  .ct-d-row-link:hover { background: var(--cc-bg-alt); }
  .ct-dl-stage { width: 4px; height: 32px; background: var(--cc-line); flex-shrink: 0; }
  .ct-dl-stage.stage-nuevo { background: var(--cc-info); }
  .ct-dl-stage.stage-contactado { background: var(--cc-info); }
  .ct-dl-stage.stage-presupuesto { background: var(--cc-warn); }
  .ct-dl-stage.stage-negociacion { background: var(--cc-warn); }
  .ct-dl-stage.stage-reserva { background: var(--cc-champagne); }
  .ct-dl-stage.stage-ganada { background: var(--cc-ok); }
  .ct-dl-stage.stage-perdida { background: var(--cc-muted); }
  .ct-dl-info { flex: 1; min-width: 0; }
  .ct-dl-title { font-weight: 500; font-size: 13px; display: flex; gap: 8px; align-items: center; }
  .ct-dl-score { font-family: var(--cc-font-mono); font-size: 10px; padding: 1px 5px; background: var(--cc-bg-alt); border: 1px solid var(--cc-line); }
  .ct-dl-sub { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); margin-top: 2px; letter-spacing: 0.05em; }
  .ct-dl-meta { text-align: right; font-family: var(--cc-font-mono); font-size: 11px; color: var(--cc-muted); flex-shrink: 0; }
  .ct-dl-meta b { color: var(--cc-ink); }
  .ct-dl-time { font-size: 9px; margin-top: 2px; }
  .ct-d-empty { padding: 18px; text-align: center; color: var(--cc-muted); font-style: italic; font-size: 12px; }

  .ct-d-row { display: flex; justify-content: space-between; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--cc-line-soft); font-size: 12px; }
  .ct-d-row:last-child { border-bottom: none; }
  .ct-d-row span { color: var(--cc-muted); }
  .ct-d-row b { font-weight: 500; text-align: right; word-break: break-all; }
  .ct-d-notes { padding: 14px 16px; font-size: 13px; line-height: 1.6; color: var(--cc-ink-soft); }

  /* MODAL */
  .cm-form { display: flex; flex-direction: column; gap: 12px; }
  .cm-tag-suggest { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
  .cm-tag-suggest-btn { font-family: var(--cc-font-mono); font-size: 9px; padding: 3px 8px; background: var(--cc-bg-alt); border: 1px solid var(--cc-line); color: var(--cc-muted); cursor: pointer; letter-spacing: 0.1em; text-transform: uppercase; }
  .cm-tag-suggest-btn:hover { border-color: var(--cc-ink); color: var(--cc-ink); background: var(--cc-surface); }
  .cm-cb { display: flex; gap: 8px; align-items: center; cursor: pointer; font-size: 12px; padding: 6px 0; }
  .cm-cb input { margin: 0; }
  .field { display: flex; flex-direction: column; }
  .field-row { display: flex; gap: 10px; flex-wrap: wrap; }
  .field-row .field { flex: 1; min-width: 140px; }
  .badge-info { background: var(--cc-info-soft); color: var(--cc-info); border-color: var(--cc-info); }
  .loss-select, .loss-notes { width: 100%; padding: 10px 12px; border: 1px solid var(--cc-line); background: var(--cc-bg); font-family: inherit; font-size: 13px; color: var(--cc-ink); }
  .loss-label { display: block; font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cc-muted); font-weight: 500; margin-bottom: 6px; }
  .loss-notes { resize: vertical; min-height: 60px; }
`;
