// ============================================================
// CARCASH · MÓDULO STOCK DE UNIDADES (LISTADO)
// Ruta: /unidades
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { state, isAdmin } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles, debounce } from '../lib/dom.js';
import { navigate } from '../lib/router.js';

// ============================================================
// CONFIG
// ============================================================
const STATUS_LABELS = {
  en_preparacion: 'En preparación',
  disponible: 'Disponible',
  reservado: 'Reservado',
  vendido: 'Vendido',
  entregado: 'Entregado',
  devuelto: 'Devuelto',
  baja: 'Baja',
};

const MODALITY_LABELS = {
  propio: 'Propio',
  consignacion: 'Consignación',
  permuta_tomada: 'Permuta',
};

const local = {
  units: [],
  filters: {
    status: 'todos',
    modality: 'todos',
    search: '',
  },
  sort: 'recent',
  searchHandler: null,
};

// ============================================================
// MOUNT
// ============================================================
export async function mount() {
  injectStyles('unidades-styles', styles);
  render();
  local.units = await fetchUnits();
  renderGrid();
}

export default mount;

// ============================================================
// FETCH
// ============================================================
async function fetchUnits() {
  const { data, error } = await supabase
    .from('units')
    .select(`
      id, unit_code, license_plate, year, brand, model, version,
      mileage, color_exterior, modality, public_price,
      status, location, main_photo_url, photos, featured_equipment,
      entered_at, sold_at, created_at
    `)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('units fetch error', error);
    toast('Error cargando stock', error.message, 'error');
    return [];
  }
  return data || [];
}

// ============================================================
// RENDER
// ============================================================
function render() {
  const view = $('#view');
  view.innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">MÓDULO 06 · STOCK</div>
          <div class="page-title">Stock de <i>unidades</i></div>
          <div class="page-sub" id="units-meta-sub">Cargando…</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-ghost" id="btn-refresh">Actualizar</button>
          ${isAdmin() ? '<button class="btn" id="btn-new-unit">+ Nueva unidad</button>' : ''}
        </div>
      </div>
      <div class="filters" id="filters">
        <div class="filter-group">
          <span class="filter-lbl">Estado</span>
          <div class="filter-chips" id="filter-status">
            ${chip('todos', 'Todos', true)}
            ${chip('disponible', 'Disponible')}
            ${chip('reservado', 'Reservado')}
            ${chip('vendido', 'Vendido')}
            ${chip('en_preparacion', 'En prep.')}
          </div>
        </div>
        <div class="filter-group">
          <span class="filter-lbl">Modalidad</span>
          <div class="filter-chips" id="filter-modality">
            ${chip('todos', 'Todas', true)}
            ${chip('propio', 'Propio')}
            ${chip('consignacion', 'Consignación')}
            ${chip('permuta_tomada', 'Permuta')}
          </div>
        </div>
        <div class="filter-group sort-group">
          <span class="filter-lbl">Orden</span>
          <select class="sort-select" id="sort-select">
            <option value="recent">Más recientes</option>
            <option value="price_desc">Precio · mayor a menor</option>
            <option value="price_asc">Precio · menor a mayor</option>
            <option value="age">Antigüedad en stock</option>
          </select>
        </div>
      </div>
    </div>

    <div class="units-grid" id="units-grid">
      <div class="empty">Cargando unidades…</div>
    </div>
  `;

  attachHandlers();
}

function chip(value, label, active = false) {
  return `<div class="filter-chip ${active ? 'active' : ''}" data-value="${value}">${escapeHtml(label)}</div>`;
}

function getFiltered() {
  let result = local.units.filter(u => {
    if (local.filters.status !== 'todos' && u.status !== local.filters.status) return false;
    if (local.filters.modality !== 'todos' && u.modality !== local.filters.modality) return false;
    if (local.filters.search) {
      const q = local.filters.search.toLowerCase();
      const haystack = [
        u.brand, u.model, u.version, u.unit_code, u.license_plate,
        u.color_exterior, String(u.year),
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  // Sort
  const sortFns = {
    recent: (a, b) => new Date(b.created_at) - new Date(a.created_at),
    price_desc: (a, b) => (b.public_price || 0) - (a.public_price || 0),
    price_asc: (a, b) => (a.public_price || 0) - (b.public_price || 0),
    age: (a, b) => new Date(a.entered_at) - new Date(b.entered_at),
  };
  result.sort(sortFns[local.sort] || sortFns.recent);
  return result;
}

function renderGrid() {
  const grid = $('#units-grid');
  const filtered = getFiltered();

  if (!local.units.length) {
    grid.innerHTML = `<div class="empty">No hay unidades cargadas todavía</div>`;
  } else if (!filtered.length) {
    grid.innerHTML = `<div class="empty">Ningún resultado con esos filtros</div>`;
  } else {
    grid.innerHTML = filtered.map(unitCard).join('');
  }

  // Meta
  const totalValue = filtered.reduce((s, u) => s + (u.public_price || 0), 0);
  const avgPrice = filtered.length > 0 ? totalValue / filtered.length : 0;
  $('#units-meta-sub').innerHTML = `
    <b>${filtered.length}</b> de ${local.units.length} unidades · VALOR TOTAL <b>USD ${fmt.compact(totalValue)}</b> · TICKET PROM. <b>USD ${fmt.compact(avgPrice)}</b>
  `;
}

function unitCard(u) {
  const photo = u.main_photo_url || u.photos?.[0] || '';
  const ageDays = Math.floor((Date.now() - new Date(u.entered_at).getTime()) / 86400000);
  const ageLabel = ageDays === 0 ? 'Hoy' : (ageDays === 1 ? '1 día' : `${ageDays} días`);
  const stale = ageDays >= 30 && u.status === 'disponible';

  return `
    <a class="unit-card" data-route="/unidades/${escapeHtml(u.unit_code.toLowerCase())}">
      <div class="uc-photo" style="${photo ? `background-image: url('${escapeHtml(photo)}')` : ''}">
        ${!photo ? '<div class="uc-no-photo">Sin foto</div>' : ''}
        <div class="uc-status uc-status-${u.status}">${escapeHtml(STATUS_LABELS[u.status] || u.status)}</div>
        ${stale ? '<div class="uc-stale">+30 días</div>' : ''}
      </div>
      <div class="uc-body">
        <div class="uc-row">
          <div class="uc-name">${escapeHtml(u.brand)} <i>${escapeHtml(u.model)}</i></div>
          <div class="uc-year">'${String(u.year).slice(2)}</div>
        </div>
        ${u.version ? `<div class="uc-version">${escapeHtml(u.version)}</div>` : ''}
        <div class="uc-meta">
          <span>${escapeHtml(fmt.km(u.mileage))}</span>
          ${u.color_exterior ? `<span>·</span><span>${escapeHtml(u.color_exterior)}</span>` : ''}
        </div>
        <div class="uc-bottom">
          <div class="uc-price">USD ${escapeHtml(fmt.usd(u.public_price))}</div>
          <div class="uc-meta-bottom">
            <span class="uc-mod">${escapeHtml(MODALITY_LABELS[u.modality] || u.modality)}</span>
            <span class="uc-code">${escapeHtml(u.unit_code)}</span>
          </div>
        </div>
        <div class="uc-foot">
          <span>En stock: ${escapeHtml(ageLabel)}</span>
        </div>
      </div>
    </a>
  `;
}

// ============================================================
// HANDLERS
// ============================================================
function attachHandlers() {
  $('#btn-refresh').addEventListener('click', () => mount());
  $('#btn-new-unit')?.addEventListener('click', () => {
    navigate('/unidades/nueva');
  });

  // Filtros chips
  $('#filters').addEventListener('click', (e) => {
    const c = e.target.closest('.filter-chip');
    if (!c) return;
    const parent = c.parentElement;
    const value = c.dataset.value;
    if (parent.id === 'filter-status') local.filters.status = value;
    else if (parent.id === 'filter-modality') local.filters.modality = value;
    parent.querySelectorAll('.filter-chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    renderGrid();
  });

  // Sort
  $('#sort-select').addEventListener('change', (e) => {
    local.sort = e.target.value;
    renderGrid();
  });

  // Búsqueda con topbar
  const searchInput = $('#search');
  if (searchInput) {
    if (local.searchHandler) searchInput.removeEventListener('input', local.searchHandler);
    local.searchHandler = debounce((e) => {
      local.filters.search = e.target.value.trim();
      renderGrid();
    }, 200);
    searchInput.addEventListener('input', local.searchHandler);
  }
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
  .sort-group { margin-left: auto; }
  .sort-select { padding: 6px 10px; border: 1px solid var(--cc-line); background: var(--cc-surface); font-family: inherit; font-size: 11px; }

  /* GRID */
  .units-grid { padding: 18px 20px; display: grid; grid-template-columns: 1fr; gap: 16px; }
  @container app (min-width: 700px) { .units-grid { grid-template-columns: repeat(2, 1fr); } }
  @container app (min-width: 1100px) { .units-grid { grid-template-columns: repeat(3, 1fr); padding: 22px 32px; gap: 20px; } }
  @container app (min-width: 1500px) { .units-grid { grid-template-columns: repeat(4, 1fr); } }

  .unit-card { display: flex; flex-direction: column; background: var(--cc-surface); border: 1px solid var(--cc-line); text-decoration: none; color: inherit; cursor: pointer; transition: all .15s ease; }
  .unit-card:hover { border-color: var(--cc-ink); transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.06); }

  .uc-photo { aspect-ratio: 16/10; background-size: cover; background-position: center; background-color: var(--cc-bg-alt); position: relative; border-bottom: 1px solid var(--cc-line); }
  .uc-no-photo { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-family: var(--cc-font-mono); font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--cc-muted); }
  .uc-status { position: absolute; top: 8px; left: 8px; padding: 3px 8px; font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase; font-weight: 600; background: var(--cc-surface); border: 1px solid var(--cc-line); }
  .uc-status-disponible { background: var(--cc-ok); color: white; border-color: var(--cc-ok); }
  .uc-status-reservado { background: var(--cc-champagne); color: var(--cc-ink); border-color: var(--cc-champagne); }
  .uc-status-vendido { background: var(--cc-ink); color: var(--cc-bg); border-color: var(--cc-ink); }
  .uc-status-en_preparacion { background: var(--cc-warn); color: white; border-color: var(--cc-warn); }
  .uc-stale { position: absolute; top: 8px; right: 8px; padding: 3px 8px; font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.15em; text-transform: uppercase; font-weight: 600; background: var(--cc-danger); color: white; }

  .uc-body { padding: 14px 16px; flex: 1; display: flex; flex-direction: column; gap: 4px; }
  .uc-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .uc-name { font-family: var(--cc-font-display); font-weight: 400; font-size: 19px; letter-spacing: -0.01em; line-height: 1.1; }
  .uc-name i { font-style: italic; font-weight: 500; }
  .uc-year { font-family: var(--cc-font-mono); font-size: 13px; color: var(--cc-muted); }
  .uc-version { font-size: 12px; color: var(--cc-muted); }
  .uc-meta { display: flex; gap: 6px; align-items: center; font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); letter-spacing: 0.05em; margin-top: 4px; flex-wrap: wrap; }
  .uc-bottom { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--cc-line-soft); gap: 8px; }
  .uc-price { font-family: var(--cc-font-mono); font-weight: 600; font-size: 16px; color: var(--cc-ink); }
  .uc-meta-bottom { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
  .uc-mod { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--cc-muted); }
  .uc-code { font-family: var(--cc-font-mono); font-size: 9px; color: var(--cc-steel); letter-spacing: 0.05em; }
  .uc-foot { font-family: var(--cc-font-mono); font-size: 9px; color: var(--cc-muted); margin-top: 6px; letter-spacing: 0.05em; }
`;
