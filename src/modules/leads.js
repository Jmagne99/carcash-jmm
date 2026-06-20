// ============================================================
// CARCASH · MÓDULO LEADS
// Gestión de leads derivados por el bot de WhatsApp/Chatwoot.
// Ruta: /leads
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { state, isAdmin, isSupervisorOrAdmin, currentUserId } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles, debounce } from '../lib/dom.js';

const CHATWOOT_BASE = 'https://financiera-sp-carcash-chatwoot.nwnae8.easypanel.host';

const STATUS_LABELS = {
  nuevo:       'Nuevo',
  contactado:  'Contactado',
  calificado:  'Calificado',
  negociacion: 'Negociación',
  ganado:      'Ganado',
  perdido:     'Perdido',
};

const CANAL_LABELS = {
  whatsapp:  'WhatsApp',
  instagram: 'Instagram',
  web:       'Web',
  llamada:   'Llamada',
  otro:      'Otro',
};

const local = {
  leads: [],
  sellers: [],
  filters: { status: 'all', canal: 'all', search: '' },
  realtimeSub: null,
};

// ============================================================
// DATA
// ============================================================
async function fetchLeads() {
  const { data, error } = await supabase
    .from('leads')
    .select('*, seller:assigned_to(id, full_name, avatar_initials)')
    .order('created_at', { ascending: false });
  if (error) { toast('Error cargando leads', error.message, 'error'); return []; }
  return data || [];
}

async function fetchSellers() {
  const { data, error } = await supabase
    .from('users_profile')
    .select('id, full_name, avatar_initials')
    .eq('active', true)
    .in('role', ['vendedor', 'gerente', 'dueno'])
    .order('full_name');
  if (error) return [];
  return data || [];
}

async function updateLead(id, fields) {
  const { error } = await supabase.from('leads').update(fields).eq('id', id);
  if (error) { toast('Error actualizando lead', error.message, 'error'); return false; }
  return true;
}

async function deleteLead(id) {
  const { error } = await supabase.from('leads').delete().eq('id', id);
  if (error) { toast('Error eliminando lead', error.message, 'error'); return false; }
  return true;
}

async function createLead(fields) {
  const { data, error } = await supabase.from('leads').insert(fields).select().single();
  if (error) { toast('Error creando lead', error.message, 'error'); return null; }
  return data;
}

// ============================================================
// FILTROS
// ============================================================
function getFiltered() {
  return local.leads.filter(l => {
    if (local.filters.status !== 'all' && l.status !== local.filters.status) return false;
    if (local.filters.canal !== 'all' && l.canal !== local.filters.canal) return false;
    if (local.filters.search) {
      const q = local.filters.search.toLowerCase();
      const haystack = [l.nombre, l.email, l.telefono, l.consulta, l.unidad_interes]
        .filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

// ============================================================
// RENDER PRINCIPAL
// ============================================================
function render() {
  $('#view').innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">LEADS · BOT</div>
          <div class="page-title">Leads <i>derivados</i></div>
          <div class="page-sub" id="leads-sub">Cargando…</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-ghost" id="btn-leads-refresh">Actualizar</button>
          <button class="btn" id="btn-leads-new">+ Nuevo lead</button>
        </div>
      </div>
      <div class="leads-filters" id="leads-filters"></div>
    </div>
    <div class="leads-grid" id="leads-grid"></div>
  `;
  renderFilters();
  renderGrid();
  attachHandlers();
}

function renderFilters() {
  const c = $('#leads-filters');
  if (!c) return;
  c.innerHTML = '';

  // Status
  const sg = el('div', { class: 'filter-group' });
  sg.appendChild(el('span', { class: 'filter-lbl' }, 'Estado'));
  const sc = el('div', { class: 'filter-chips' });
  sc.appendChild(chip('all', 'Todos', local.filters.status === 'all', 'status'));
  Object.entries(STATUS_LABELS).forEach(([k, v]) =>
    sc.appendChild(chip(k, v, local.filters.status === k, 'status'))
  );
  sg.appendChild(sc);
  c.appendChild(sg);

  // Canal
  const cg = el('div', { class: 'filter-group' });
  cg.appendChild(el('span', { class: 'filter-lbl' }, 'Canal'));
  const cc = el('div', { class: 'filter-chips' });
  cc.appendChild(chip('all', 'Todos', local.filters.canal === 'all', 'canal'));
  Object.entries(CANAL_LABELS).forEach(([k, v]) =>
    cc.appendChild(chip(k, v, local.filters.canal === k, 'canal'))
  );
  cg.appendChild(cc);
  c.appendChild(cg);

  c.appendChild(el('button', {
    class: 'filter-reset',
    onClick: () => { local.filters = { status: 'all', canal: 'all', search: '' }; render(); }
  }, 'Limpiar'));
}

function chip(value, label, active, group) {
  return el('div', {
    class: 'filter-chip' + (active ? ' active' : ''),
    dataset: { value, group },
  }, label);
}

function renderGrid() {
  const grid = $('#leads-grid');
  if (!grid) return;
  const filtered = getFiltered();

  $('#leads-sub').innerHTML = `<b>${filtered.length}</b> DE ${local.leads.length} LEADS`;

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="leads-empty">Sin leads${local.filters.status !== 'all' || local.filters.canal !== 'all' || local.filters.search ? ' para los filtros aplicados' : ' todavía'}</div>`;
    return;
  }

  grid.innerHTML = '';
  filtered.forEach(lead => grid.appendChild(renderCard(lead)));
}

function renderCard(lead) {
  const seller = lead.seller;
  const chatwootUrl = lead.chatwoot_account_id && lead.chatwoot_conversation_id
    ? `${CHATWOOT_BASE}/app/accounts/${lead.chatwoot_account_id}/conversations/${lead.chatwoot_conversation_id}`
    : null;

  const sellerOptions = `<option value="">Sin asignar</option>` +
    local.sellers.map(s =>
      `<option value="${s.id}" ${lead.assigned_to === s.id ? 'selected' : ''}>${escapeHtml(s.full_name)}</option>`
    ).join('');

  const card = el('div', { class: `lead-card status-${lead.status}`, dataset: { id: lead.id } });
  card.innerHTML = `
    <div class="lc-top">
      <div class="lc-name">${escapeHtml(lead.nombre || '—')}</div>
      <span class="lc-status status-badge-${lead.status}">${STATUS_LABELS[lead.status] || lead.status}</span>
    </div>
    <div class="lc-meta">
      <span class="lc-canal">${CANAL_LABELS[lead.canal] || lead.canal || '—'}</span>
      ${lead.telefono ? `<span class="lc-phone">📱 ${escapeHtml(lead.telefono)}</span>` : ''}
      ${lead.email ? `<span class="lc-email">✉ ${escapeHtml(lead.email)}</span>` : ''}
    </div>
    ${lead.unidad_interes ? `<div class="lc-unidad">${escapeHtml(lead.unidad_interes)}</div>` : ''}
    ${lead.consulta ? `<div class="lc-consulta">${escapeHtml(lead.consulta.slice(0, 120))}${lead.consulta.length > 120 ? '…' : ''}</div>` : ''}
    <div class="lc-assign">
      <label class="lc-assign-lbl">Vendedor</label>
      <div class="lc-assign-row">
        ${seller ? `<span class="lc-avatar">${escapeHtml(seller.avatar_initials || seller.full_name.slice(0,2))}</span>` : '<span class="lc-avatar lc-avatar-empty">—</span>'}
        <select class="lc-seller-select" data-id="${lead.id}">
          ${sellerOptions}
        </select>
      </div>
    </div>
    <div class="lc-bottom">
      <div class="lc-actions">
        ${chatwootUrl ? `<a class="btn btn-ghost btn-xs lc-chat" href="${chatwootUrl}" target="_blank">Abrir chat</a>` : ''}
        <button class="btn btn-ghost btn-xs lc-edit" data-id="${lead.id}">Editar</button>
        <button class="btn btn-ghost btn-xs lc-del" data-id="${lead.id}">Borrar</button>
      </div>
      <div class="lc-date">${fmt.date ? fmt.date(lead.created_at) : new Date(lead.created_at).toLocaleDateString('es-AR')}</div>
    </div>
  `;

  card.querySelector('.lc-edit')?.addEventListener('click', () => openModal(lead));
  card.querySelector('.lc-del')?.addEventListener('click', () => confirmDelete(lead));

  card.querySelector('.lc-seller-select')?.addEventListener('change', async e => {
    const sellerId = e.target.value || null;
    const ok = await updateLead(lead.id, { assigned_to: sellerId });
    if (ok) {
      lead.assigned_to = sellerId;
      lead.seller = local.sellers.find(s => s.id === sellerId) || null;
      // Actualizar avatar inline
      const avatar = card.querySelector('.lc-avatar');
      if (avatar) {
        avatar.textContent = lead.seller
          ? (lead.seller.avatar_initials || lead.seller.full_name.slice(0, 2))
          : '—';
        avatar.classList.toggle('lc-avatar-empty', !lead.seller);
      }
      toast('Vendedor asignado', lead.seller?.full_name || 'Sin asignar', 'ok');
    } else {
      e.target.value = lead.assigned_to || '';
    }
  });

  return card;
}

// ============================================================
// MODAL ABM
// ============================================================
function openModal(lead = null) {
  const isEdit = !!lead;
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal modal-leads' });

  const sellerOptions = local.sellers.map(s =>
    `<option value="${s.id}" ${lead?.assigned_to === s.id ? 'selected' : ''}>${escapeHtml(s.full_name)}</option>`
  ).join('');

  modal.innerHTML = `
    <div class="modal-hd">
      <h3>${isEdit ? 'Editar lead' : 'Nuevo lead'}</h3>
      <button class="modal-close" id="modal-close">×</button>
    </div>
    <div class="modal-body">
      <div class="field-row">
        <div class="field">
          <label>Nombre *</label>
          <input id="lf-nombre" value="${escapeHtml(lead?.nombre || '')}" placeholder="Nombre del lead">
        </div>
        <div class="field">
          <label>Teléfono</label>
          <input id="lf-telefono" value="${escapeHtml(lead?.telefono || '')}" placeholder="+54911...">
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Email</label>
          <input id="lf-email" type="email" value="${escapeHtml(lead?.email || '')}" placeholder="email@ejemplo.com">
        </div>
        <div class="field">
          <label>Canal</label>
          <select id="lf-canal">
            ${Object.entries(CANAL_LABELS).map(([k, v]) =>
              `<option value="${k}" ${(lead?.canal || 'whatsapp') === k ? 'selected' : ''}>${v}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      <div class="field">
        <label>Unidad de interés</label>
        <input id="lf-unidad" value="${escapeHtml(lead?.unidad_interes || '')}" placeholder="Ej: Toyota Hilux 2024">
      </div>
      <div class="field">
        <label>Consulta</label>
        <textarea id="lf-consulta" rows="3" placeholder="Descripción de la consulta">${escapeHtml(lead?.consulta || '')}</textarea>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Estado</label>
          <select id="lf-status">
            ${Object.entries(STATUS_LABELS).map(([k, v]) =>
              `<option value="${k}" ${(lead?.status || 'nuevo') === k ? 'selected' : ''}>${v}</option>`
            ).join('')}
          </select>
        </div>
        <div class="field">
          <label>Vendedor asignado</label>
          <select id="lf-seller">
            <option value="">Sin asignar</option>
            ${sellerOptions}
          </select>
        </div>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="modal-cancel">Cancelar</button>
      <button class="btn" id="modal-save">${isEdit ? 'Guardar cambios' : 'Crear lead'}</button>
    </div>
  `;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  modal.querySelector('#modal-close').addEventListener('click', close);
  modal.querySelector('#modal-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  modal.querySelector('#modal-save').addEventListener('click', async () => {
    const nombre = modal.querySelector('#lf-nombre').value.trim();
    if (!nombre) { toast('Nombre requerido', null, 'error'); return; }

    const fields = {
      nombre,
      telefono: modal.querySelector('#lf-telefono').value.trim() || null,
      email: modal.querySelector('#lf-email').value.trim() || null,
      canal: modal.querySelector('#lf-canal').value,
      unidad_interes: modal.querySelector('#lf-unidad').value.trim() || null,
      consulta: modal.querySelector('#lf-consulta').value.trim() || null,
      status: modal.querySelector('#lf-status').value,
      assigned_to: modal.querySelector('#lf-seller').value || null,
    };

    const btn = modal.querySelector('#modal-save');
    btn.disabled = true;
    btn.textContent = 'Guardando…';

    if (isEdit) {
      const ok = await updateLead(lead.id, fields);
      if (ok) {
        toast('Lead actualizado', null, 'ok');
        close();
        await reload();
      }
    } else {
      const created = await createLead(fields);
      if (created) {
        toast('Lead creado', null, 'ok');
        close();
        await reload();
      }
    }
    btn.disabled = false;
  });
}

async function confirmDelete(lead) {
  if (!confirm(`¿Borrar el lead de ${lead.nombre}? Esta acción no se puede deshacer.`)) return;
  const ok = await deleteLead(lead.id);
  if (ok) {
    toast('Lead eliminado', null, 'ok');
    await reload();
  }
}

// ============================================================
// HANDLERS
// ============================================================
function attachHandlers() {
  $('#btn-leads-refresh')?.addEventListener('click', reload);
  $('#btn-leads-new')?.addEventListener('click', () => openModal());

  $('#leads-filters')?.addEventListener('click', e => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    const { value, group } = chip.dataset;
    local.filters[group] = value;
    chip.closest('.filter-chips').querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    renderGrid();
  });

  const searchInput = $('#search');
  if (searchInput) {
    searchInput.addEventListener('input', debounce(e => {
      local.filters.search = e.target.value.trim();
      renderGrid();
    }, 200));
    searchInput.value = local.filters.search || '';
  }
}

// ============================================================
// REALTIME
// ============================================================
function subscribeRealtime() {
  if (local.realtimeSub) supabase.removeChannel(local.realtimeSub);
  local.realtimeSub = supabase
    .channel('leads-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, async () => {
      await reload(false);
    })
    .subscribe();
}

async function reload(showToast = false) {
  local.leads = await fetchLeads();
  renderGrid();
  if (showToast) toast('Leads actualizados', null, 'ok');
}

// ============================================================
// MOUNT
// ============================================================
export async function mount() {
  injectStyles('leads-styles', styles);
  render();
  [local.leads, local.sellers] = await Promise.all([fetchLeads(), fetchSellers()]);
  renderFilters();
  renderGrid();
  subscribeRealtime();
}

export default mount;

// ============================================================
// CSS
// ============================================================
const styles = `
  .leads-filters { display:flex; gap:8px; flex-wrap:wrap; align-items:center; padding:12px 20px 0; }
  @container app (min-width:900px) { .leads-filters { padding:12px 32px 0; } }
  .leads-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:12px; padding:20px; }
  @container app (min-width:900px) { .leads-grid { padding:24px 32px; } }
  .leads-empty { grid-column:1/-1; text-align:center; padding:60px 20px; font-family:var(--cc-font-mono); font-size:11px; letter-spacing:0.15em; text-transform:uppercase; color:var(--cc-muted); }

  .lead-card { background:var(--cc-surface); border:1px solid var(--cc-line); padding:14px; display:flex; flex-direction:column; gap:6px; transition:border-color .15s; }
  .lead-card:hover { border-color:var(--cc-ink); }
  .lead-card.status-ganado { border-left:3px solid var(--cc-ok); }
  .lead-card.status-perdido { border-left:3px solid var(--cc-muted); opacity:.7; }
  .lead-card.status-negociacion { border-left:3px solid var(--cc-champagne); }
  .lead-card.status-nuevo { border-left:3px solid var(--cc-info); }

  .lc-top { display:flex; justify-content:space-between; align-items:flex-start; gap:8px; }
  .lc-name { font-size:14px; font-weight:500; flex:1; }
  .lc-status { font-family:var(--cc-font-mono); font-size:9px; letter-spacing:0.15em; text-transform:uppercase; padding:2px 7px; border:1px solid; flex-shrink:0; }
  .status-badge-nuevo { color:var(--cc-info); border-color:var(--cc-info); }
  .status-badge-contactado { color:var(--cc-champagne); border-color:var(--cc-champagne); }
  .status-badge-calificado { color:var(--cc-ok); border-color:var(--cc-ok); }
  .status-badge-negociacion { color:var(--cc-warn); border-color:var(--cc-warn); }
  .status-badge-ganado { color:var(--cc-ok); border-color:var(--cc-ok); background:var(--cc-ok-soft,#e6f4ea); }
  .status-badge-perdido { color:var(--cc-muted); border-color:var(--cc-line); }

  .lc-meta { display:flex; gap:10px; flex-wrap:wrap; font-family:var(--cc-font-mono); font-size:10px; color:var(--cc-muted); }
  .lc-canal { text-transform:uppercase; letter-spacing:0.12em; font-weight:600; color:var(--cc-champagne); }
  .lc-unidad { font-family:var(--cc-font-display); font-style:italic; font-size:12px; color:var(--cc-muted); }
  .lc-consulta { font-size:12px; color:var(--cc-ink); line-height:1.4; border-left:2px solid var(--cc-line); padding-left:8px; }

  .lc-bottom { display:flex; justify-content:space-between; align-items:center; margin-top:4px; padding-top:8px; border-top:1px solid var(--cc-line-soft); gap:8px; flex-wrap:wrap; }
  .lc-assign { display:flex; flex-direction:column; gap:3px; padding:8px 0; border-top:1px solid var(--cc-line-soft); border-bottom:1px solid var(--cc-line-soft); margin:2px 0; }
  .lc-assign-lbl { font-family:var(--cc-font-mono); font-size:9px; letter-spacing:0.2em; text-transform:uppercase; color:var(--cc-muted); font-weight:500; }
  .lc-assign-row { display:flex; align-items:center; gap:8px; }
  .lc-avatar { width:24px; height:24px; background:var(--cc-ink); color:var(--cc-bg); border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:9px; font-weight:600; flex-shrink:0; }
  .lc-avatar-empty { background:var(--cc-line); color:var(--cc-muted); }
  .lc-seller-select { flex:1; padding:5px 8px; border:1px solid var(--cc-line); background:var(--cc-bg); font-family:inherit; font-size:12px; color:var(--cc-ink); cursor:pointer; }
  .lc-seller-select:focus { outline:none; border-color:var(--cc-ink); }
  .lc-seller-name { color:var(--cc-muted); }
  .lc-unassigned { font-size:10px; color:var(--cc-muted); font-style:italic; }
  .lc-actions { display:flex; gap:4px; flex-wrap:wrap; }
  .btn-xs { padding:3px 8px !important; font-size:10px !important; }
  .lc-chat { color:var(--cc-ok) !important; border-color:var(--cc-ok) !important; text-decoration:none; }
  .lc-date { font-family:var(--cc-font-mono); font-size:9px; color:var(--cc-muted); letter-spacing:0.08em; }

  .modal-leads { width:min(560px,95vw); }
  .field-row { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  @media (max-width:480px) { .field-row { grid-template-columns:1fr; } }
  .field { display:flex; flex-direction:column; gap:4px; margin-bottom:10px; }
  .field label { font-size:9px; letter-spacing:0.2em; text-transform:uppercase; color:var(--cc-muted); font-weight:500; }
  .field input, .field select, .field textarea { padding:9px 11px; border:1px solid var(--cc-line); background:var(--cc-bg); font-family:inherit; font-size:13px; color:var(--cc-ink); }
  .field input:focus, .field select:focus, .field textarea:focus { outline:none; border-color:var(--cc-ink); }
  .field textarea { resize:vertical; min-height:70px; }
`;
