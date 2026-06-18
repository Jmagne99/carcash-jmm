// ============================================================
// CARCASH · MÓDULO ADMIN EQUIPO
// Solo para roles dueno / gerente.
// Ruta: /equipo
// Funciones:
//   - Listado de miembros del equipo con métricas
//   - Crear nuevo miembro (instrucciones para crear en Auth + UUID)
//   - Editar miembro (nombre, rol, target, activar/desactivar)
// ============================================================

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY, createClient } from '../lib/supabase-client.js';
import { state, isAdmin, isSupervisorOrAdmin, isOwner, isSupervisor, currentUserId } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles, confirmDialog } from '../lib/dom.js';

const ROLE_OPTIONS = [
  { id: 'dueno',      label: 'Dueño',       desc: 'Acceso total · histórico completo · configuración crítica' },
  { id: 'gerente',    label: 'Gerente',     desc: 'Ve todo el pipeline · puede asignar y reasignar leads' },
  { id: 'supervisor', label: 'Supervisor',  desc: 'Ve equipo · setea objetivos a vendedores · sin acceso a config crítica' },
  { id: 'admin_back', label: 'Back office', desc: 'Operativo · documentación, cobros, no edita precios' },
  { id: 'vendedor',   label: 'Vendedor',    desc: 'Ve solo sus oportunidades · gestiona sus leads' },
];

const ROLE_LABEL = Object.fromEntries(ROLE_OPTIONS.map(r => [r.id, r.label]));

const local = {
  members: [],
  metrics: new Map(),     // user_id → { active_opps, won_count, won_amount, pipeline_value, conversion }
};

// ============================================================
// MOUNT
// ============================================================
export async function mount() {
  injectStyles('equipo-styles', styles);

  if (!isSupervisorOrAdmin()) {
    $('#view').innerHTML = `
      <div class="placeholder">
        <div class="placeholder-content">
          <div class="placeholder-num">×</div>
          <div class="placeholder-title">Acceso <i>restringido</i></div>
          <div class="placeholder-desc">Esta sección es solo para dueño / gerente / supervisor.</div>
          <div class="placeholder-status">NO AUTORIZADO</div>
        </div>
      </div>
    `;
    return;
  }

  render();
  await loadAll();
  renderTable();
}

export default mount;

// ============================================================
// FETCH
// ============================================================
async function fetchMembers() {
  const { data, error } = await supabase
    .from('users_profile')
    .select('id, full_name, email, phone, role, active, monthly_sales_target, avatar_initials, hired_at, created_at')
    .is('deleted_at', null)
    .order('role', { ascending: true })
    .order('full_name');
  if (error) {
    console.error(error);
    toast('Error cargando equipo', error.message, 'error');
    return [];
  }
  return data || [];
}

async function fetchTeamMetrics() {
  // Oportunidades activas + valor pipeline + conversión
  const startMonth = new Date();
  startMonth.setDate(1);
  startMonth.setHours(0, 0, 0, 0);

  // Activas (no ganada/perdida)
  const { data: active } = await supabase
    .from('opportunities')
    .select('assigned_to, expected_amount, stage')
    .is('deleted_at', null);

  // Ventas del mes
  const { data: sales } = await supabase
    .from('sales')
    .select('seller_user_id, sale_price, gross_margin, created_at, status')
    .gte('created_at', startMonth.toISOString())
    .is('deleted_at', null);

  // Cerradas este mes (ganadas + perdidas) para conversión
  const { data: closed } = await supabase
    .from('opportunities')
    .select('assigned_to, stage')
    .gte('updated_at', startMonth.toISOString())
    .in('stage', ['ganada', 'perdida'])
    .is('deleted_at', null);

  // Tiempo de respuesta: desde que se asigna el lead hasta el 1er mensaje del vendedor
  const { data: resp } = await supabase
    .from('opportunities')
    .select('assigned_to, created_at, assigned_at, first_response_at')
    .not('first_response_at', 'is', null)
    .is('deleted_at', null);

  // Agregar por user
  const map = new Map();
  function getOrInit(id) {
    if (!map.has(id)) map.set(id, {
      active_opps: 0,
      pipeline_value: 0,
      won_count: 0,
      won_amount: 0,
      lost_count: 0,
      margin_total: 0,
      resp_sum: 0,
      resp_count: 0,
    });
    return map.get(id);
  }

  for (const o of active || []) {
    if (!['ganada', 'perdida'].includes(o.stage)) {
      const m = getOrInit(o.assigned_to);
      m.active_opps += 1;
      m.pipeline_value += parseFloat(o.expected_amount) || 0;
    }
  }
  for (const c of closed || []) {
    const m = getOrInit(c.assigned_to);
    if (c.stage === 'ganada') m.won_count += 1;
    else if (c.stage === 'perdida') m.lost_count += 1;
  }
  for (const s of sales || []) {
    if (s.status === 'cancelada') continue;
    const m = getOrInit(s.seller_user_id);
    m.won_amount += parseFloat(s.sale_price) || 0;
    m.margin_total += parseFloat(s.gross_margin) || 0;
  }

  // Tiempo de respuesta promedio (en minutos)
  for (const o of resp || []) {
    const base = o.assigned_at || o.created_at;
    if (!base || !o.first_response_at) continue;
    const mins = (new Date(o.first_response_at) - new Date(base)) / 60000;
    if (mins < 0 || mins > 60 * 24 * 30) continue; // descartar valores absurdos
    const m = getOrInit(o.assigned_to);
    m.resp_sum += mins;
    m.resp_count += 1;
  }

  // Conversión + promedio de respuesta
  for (const m of map.values()) {
    const closedTotal = m.won_count + m.lost_count;
    m.conversion = closedTotal > 0 ? (m.won_count / closedTotal) * 100 : 0;
    m.resp_avg_min = m.resp_count > 0 ? Math.round(m.resp_sum / m.resp_count) : null;
  }

  return map;
}

async function loadAll() {
  [local.members, local.metrics] = await Promise.all([fetchMembers(), fetchTeamMetrics()]);
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
          <div class="page-num">MÓDULO 13 · DIRECCIÓN</div>
          <div class="page-title">Equipo <i>comercial</i></div>
          <div class="page-sub" id="equipo-meta">Cargando…</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-ghost" id="btn-refresh">Actualizar</button>
          ${isAdmin() ? '<button class="btn" id="btn-add">+ Agregar miembro</button>' : ''}
        </div>
      </div>
    </div>
    <div class="equipo-list" id="equipo-list">
      <div class="empty">Cargando equipo…</div>
    </div>
  `;
  $('#btn-refresh').addEventListener('click', () => mount());
  $('#btn-add')?.addEventListener('click', () => openAddMemberModal());
}

function renderTable() {
  const list = $('#equipo-list');
  const meta = $('#equipo-meta');
  const total = local.members.length;
  const active = local.members.filter(m => m.active).length;

  meta.innerHTML = `
    <b>${active}</b> activos · ${total - active} inactivos · ${total} total
  `;

  if (!local.members.length) {
    list.innerHTML = `<div class="empty">No hay miembros cargados</div>`;
    return;
  }

  list.innerHTML = `
    <div class="team-grid">
      ${local.members.map(memberCard).join('')}
    </div>
  `;

  list.addEventListener('click', (e) => {
    const card = e.target.closest('.member-card');
    if (!card) return;
    const id = card.dataset.id;
    const member = local.members.find(m => m.id === id);
    if (member) openEditMemberModal(member);
  });
}

function fmtRespTime(min) {
  if (min == null) return '—';
  if (min < 60) return min + 'm';
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function memberCard(m) {
  const metrics = local.metrics.get(m.id) || { active_opps: 0, pipeline_value: 0, won_count: 0, won_amount: 0, conversion: 0, margin_total: 0, resp_avg_min: null };
  const target = m.monthly_sales_target || 0;
  const progress = target > 0 ? Math.min(100, (metrics.won_count / target) * 100) : 0;
  const isMe = m.id === currentUserId();

  return `
    <div class="member-card ${m.active ? '' : 'inactive'}" data-id="${m.id}">
      <div class="mc-hd">
        <div class="mc-avatar role-${m.role}">${escapeHtml(m.avatar_initials || fmt.initials(m.full_name))}</div>
        <div class="mc-info">
          <div class="mc-name">
            ${escapeHtml(m.full_name)}
            ${isMe ? '<span class="mc-you">tú</span>' : ''}
            ${!m.active ? '<span class="mc-inactive">INACTIVO</span>' : ''}
          </div>
          <div class="mc-role">${escapeHtml(ROLE_LABEL[m.role] || m.role)}</div>
          ${m.email ? `<div class="mc-meta">${escapeHtml(m.email)}</div>` : ''}
          ${m.phone ? `<div class="mc-meta">${escapeHtml(fmt.phone(m.phone))}</div>` : ''}
        </div>
      </div>

      <div class="mc-stats">
        <div class="mc-stat">
          <div class="mc-stat-value">${metrics.active_opps}</div>
          <div class="mc-stat-label">Activas</div>
        </div>
        <div class="mc-stat">
          <div class="mc-stat-value">USD ${escapeHtml(fmt.compact(metrics.pipeline_value))}</div>
          <div class="mc-stat-label">Pipeline</div>
        </div>
        <div class="mc-stat">
          <div class="mc-stat-value">${metrics.won_count}</div>
          <div class="mc-stat-label">Ventas mes</div>
        </div>
        <div class="mc-stat">
          <div class="mc-stat-value">${metrics.conversion.toFixed(0)}%</div>
          <div class="mc-stat-label">Conversión</div>
        </div>
        <div class="mc-stat">
          <div class="mc-stat-value">${fmtRespTime(metrics.resp_avg_min)}</div>
          <div class="mc-stat-label">Resp. prom.</div>
        </div>
      </div>

      ${target > 0 ? `
        <div class="mc-target">
          <div class="mc-target-row">
            <span>Objetivo del mes</span>
            <b>${metrics.won_count} / ${target}</b>
          </div>
          <div class="mc-target-bar">
            <div class="mc-target-bar-fill" style="width: ${progress}%"></div>
          </div>
        </div>
      ` : '<div class="mc-target-empty">Sin objetivo definido</div>'}
    </div>
  `;
}

// ============================================================
// MODAL: AGREGAR MIEMBRO (alta automática)
// ============================================================
function openAddMemberModal() {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', style: { maxWidth: '520px' } });

  // Generar password aleatorio razonable
  const suggestedPassword = generatePassword();

  modal.appendChild(el('div', { class: 'modal-hd' },
    el('h3', {}, 'Agregar vendedor al equipo'),
    el('button', { class: 'modal-close', onClick: () => close() }, '×')
  ));
  modal.appendChild(el('div', { class: 'modal-body' },
    el('div', { class: 'add-intro' }, 'Se crea el usuario en Supabase Auth + el perfil en una sola operación. Después podés compartirle el password al vendedor.'),
    el('div', { class: 'amf-form' },
      field('Nombre completo', el('input', { type: 'text', id: 'add-name', class: 'loss-select', placeholder: 'Ej: Diego Martínez', autocomplete: 'off' })),
      el('div', { class: 'field-row' },
        field('Email (login)', el('input', { type: 'email', id: 'add-email', class: 'loss-select', placeholder: 'diego@carcash.com.ar', autocomplete: 'off' })),
        field('Teléfono', el('input', { type: 'text', id: 'add-phone', class: 'loss-select', placeholder: '+54 9 11 ...', autocomplete: 'off' })),
      ),
      el('div', { class: 'field' },
        el('label', { class: 'loss-label' }, 'Password inicial (lo va a poder cambiar)'),
        el('div', { class: 'pwd-row' },
          el('input', { type: 'text', id: 'add-password', class: 'loss-select', value: suggestedPassword, autocomplete: 'off' }),
          el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => { $('#add-password').value = generatePassword(); } }, '↻'),
        ),
      ),
      field('Rol', renderRoleSelect('add-role')),
      field('Objetivo mensual de ventas', el('input', { type: 'number', id: 'add-target', class: 'loss-select', value: '5', min: '0' })),
    )
  ));
  modal.appendChild(el('div', { class: 'modal-actions' },
    el('button', { class: 'btn btn-ghost', onClick: () => close() }, 'Cancelar'),
    el('button', { class: 'btn btn-ok', id: 'btn-create-member', onClick: () => createMemberAuto(close) }, '+ Crear vendedor'),
  ));

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  function close() { backdrop.remove(); }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
}

function generatePassword() {
  // 10 chars, alfanuméricos, fácil de leer (sin O/0, l/1)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pwd = '';
  for (let i = 0; i < 10; i++) {
    pwd += chars[Math.floor(Math.random() * chars.length)];
  }
  return pwd;
}

async function createMemberAuto(closeModal) {
  const btn = $('#btn-create-member');
  btn.disabled = true;
  btn.textContent = 'Creando…';

  const name = $('#add-name').value.trim();
  const email = $('#add-email').value.trim().toLowerCase();
  const password = $('#add-password').value;
  const role = $('#add-role').value;
  const phone = $('#add-phone').value.trim();
  const target = parseInt($('#add-target').value, 10) || 0;

  if (!name || !email || !password) {
    toast('Faltan datos', 'Nombre, email y password son obligatorios', 'warn');
    btn.disabled = false;
    btn.textContent = '+ Crear vendedor';
    return;
  }
  if (password.length < 6) {
    toast('Password muy corto', 'Mínimo 6 caracteres', 'warn');
    btn.disabled = false;
    btn.textContent = '+ Crear vendedor';
    return;
  }

  try {
    // 1. Cliente secundario (sin sesión) para no romper la del admin
    const aux = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    // 2. signUp en el cliente secundario
    const { data: signUpData, error: signUpError } = await aux.auth.signUp({
      email, password,
    });
    if (signUpError) throw new Error('Auth: ' + signUpError.message);
    const newUserId = signUpData?.user?.id;
    if (!newUserId) throw new Error('No se obtuvo el ID del usuario creado');

    // Sign out del cliente auxiliar (por las dudas)
    await aux.auth.signOut().catch(() => {});

    // 3. Auto-confirmar el email (RPC con security definer)
    const { error: confirmErr } = await supabase.rpc('auto_confirm_user', { user_id: newUserId });
    if (confirmErr) {
      // Si la RPC no existe (deploy viejo), solo advertir
      console.warn('auto_confirm_user fallo:', confirmErr);
      toast('Aviso', 'El usuario fue creado pero quizá necesite confirmar el email', 'warn');
    }

    // 4. Insertar el perfil
    const { error: profileErr } = await supabase.from('users_profile').insert({
      id: newUserId,
      full_name: name,
      email,
      phone: phone || null,
      role,
      monthly_sales_target: target,
      active: true,
    });
    if (profileErr) throw new Error('Perfil: ' + profileErr.message);

    // 5. Cerrar modal y mostrar credenciales
    closeModal();
    showCredentialsModal({ name, email, password, role });
    await loadAll();
    renderTable();
  } catch (err) {
    console.error(err);
    toast('Error creando vendedor', err.message, 'error');
    btn.disabled = false;
    btn.textContent = '+ Crear vendedor';
  }
}

function showCredentialsModal({ name, email, password, role }) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', style: { maxWidth: '460px' } });

  const message = `Hola ${name.split(' ')[0]}! Tu acceso al CRM CarCash:

🔗 ${window.location.origin}${window.location.pathname}
✉ Email: ${email}
🔐 Password: ${password}

Una vez que entres podés cambiar el password en tu perfil. Cualquier duda avisame.`;

  const wspUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
  const mailUrl = `mailto:${email}?subject=${encodeURIComponent('Tu acceso al CRM CarCash')}&body=${encodeURIComponent(message)}`;

  modal.appendChild(el('div', { class: 'modal-hd' },
    el('h3', {}, '✓ Vendedor creado'),
    el('button', { class: 'modal-close', onClick: () => close() }, '×')
  ));
  modal.appendChild(el('div', { class: 'modal-body' },
    el('div', { class: 'creds-card' },
      el('div', { class: 'creds-row' },
        el('span', {}, 'Nombre'),
        el('b', {}, name),
      ),
      el('div', { class: 'creds-row' },
        el('span', {}, 'Email'),
        el('b', {}, email),
      ),
      el('div', { class: 'creds-row' },
        el('span', {}, 'Password'),
        el('b', { class: 'creds-pwd' }, password),
      ),
      el('div', { class: 'creds-row' },
        el('span', {}, 'Rol'),
        el('b', {}, role),
      ),
    ),
    el('div', { class: 'creds-hint' }, 'Compartile estas credenciales al vendedor. Va a poder cambiar el password al loguearse.'),
  ));
  modal.appendChild(el('div', { class: 'modal-actions' },
    el('button', { class: 'btn btn-ghost', onClick: () => {
      navigator.clipboard?.writeText(message);
      toast('Copiado', 'Mensaje en el portapapeles', 'ok');
    } }, '⧉ Copiar mensaje'),
    el('a', { class: 'btn', href: wspUrl, target: '_blank', rel: 'noopener', onClick: () => close() }, '● WhatsApp'),
    el('a', { class: 'btn btn-ok', href: mailUrl, onClick: () => close() }, '✉ Email'),
  ));

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  function close() { backdrop.remove(); }
}

// ============================================================
// MODAL: EDITAR MIEMBRO
// ============================================================
function openEditMemberModal(m) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', style: { maxWidth: '520px' } });

  const isMe = m.id === currentUserId();
  const supervisorMode = isSupervisor();
  // Supervisor solo edita objetivos de vendedores
  if (supervisorMode && m.role !== 'vendedor') {
    toast('Acceso restringido', 'Como supervisor solo podés editar objetivos de vendedores', 'warn');
    return;
  }

  modal.appendChild(el('div', { class: 'modal-hd' },
    el('h3', {}, `Editar ${m.full_name}`),
    el('button', { class: 'modal-close', onClick: () => close() }, '×')
  ));
  modal.appendChild(el('div', { class: 'modal-body' },
    supervisorMode ? el('div', { class: 'field-hint', style: { marginBottom: '12px', padding: '10px 12px', background: 'var(--cc-bg-alt)', borderLeft: '3px solid var(--cc-champagne)' } },
      'Como supervisor solo podés editar el <b>objetivo mensual</b> del vendedor. Para cambiar otros datos pedí a un dueño/gerente.'
    ) : null,
    field('Nombre completo', el('input', { type: 'text', id: 'ed-name', class: 'loss-select', value: m.full_name, disabled: supervisorMode })),
    el('div', { class: 'field-row' },
      field('Email', el('input', { type: 'email', id: 'ed-email', class: 'loss-select', value: m.email || '', disabled: supervisorMode })),
      field('Teléfono', el('input', { type: 'text', id: 'ed-phone', class: 'loss-select', value: m.phone || '', disabled: supervisorMode })),
    ),
    field('Rol', renderRoleSelect('ed-role', m.role, isMe || supervisorMode)),
    isMe ? el('div', { class: 'field-hint', style: { marginTop: '-4px', marginBottom: '12px' } }, 'No podés cambiar tu propio rol.') : null,
    field('Objetivo mensual de ventas', el('input', { type: 'number', id: 'ed-target', class: 'loss-select', value: m.monthly_sales_target || 0, min: '0' })),
    el('label', { class: 'cb-row', style: { marginTop: '14px', display: 'flex', alignItems: 'center', gap: '8px' } },
      el('input', { type: 'checkbox', id: 'ed-active', checked: !!m.active, disabled: isMe || supervisorMode }),
      el('span', {}, 'Usuario activo'),
    ),
    isMe || supervisorMode ? null : el('div', { class: 'field-hint', style: { marginTop: '-4px' } }, 'Si lo desactivás, no va a poder loguearse hasta que lo reactives.')
  ));
  modal.appendChild(el('div', { class: 'modal-actions' },
    isMe || supervisorMode ? null : el('button', { class: 'btn btn-danger btn-sm', onClick: async () => {
      const ok = await confirmDialog(`¿Desactivar permanentemente a ${m.full_name}? Perdería acceso al CRM.`, { okText: 'Desactivar' });
      if (!ok) return;
      const { error } = await supabase.from('users_profile').update({ active: false, deleted_at: new Date().toISOString() }).eq('id', m.id);
      if (error) { toast('Error', error.message, 'error'); return; }
      toast('Miembro desactivado', m.full_name, 'warn');
      close();
      await loadAll();
      renderTable();
    } }, 'Eliminar'),
    el('div', { style: { flex: '1' } }),
    el('button', { class: 'btn btn-ghost', onClick: () => close() }, 'Cancelar'),
    el('button', { class: 'btn btn-ok', onClick: async () => {
      let update;
      if (supervisorMode) {
        // Supervisor: solo edita objetivo
        update = { monthly_sales_target: parseInt($('#ed-target').value, 10) || 0 };
      } else {
        update = {
          full_name: $('#ed-name').value.trim(),
          email: $('#ed-email').value.trim() || null,
          phone: $('#ed-phone').value.trim() || null,
          monthly_sales_target: parseInt($('#ed-target').value, 10) || 0,
        };
        if (!isMe) {
          update.role = $('#ed-role').value;
          update.active = $('#ed-active').checked;
        }
      }
      const { error } = await supabase.from('users_profile').update(update).eq('id', m.id);
      if (error) { toast('Error', error.message, 'error'); return; }
      toast('Cambios guardados', m.full_name, 'ok');
      close();
      await loadAll();
      renderTable();
    } }, supervisorMode ? 'Guardar objetivo' : 'Guardar'),
  ));

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  function close() { backdrop.remove(); }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
}

// ============================================================
// HELPERS
// ============================================================
function field(label, input) {
  return el('div', { class: 'field' },
    el('label', { class: 'loss-label' }, label),
    input,
  );
}

function renderRoleSelect(id, current = 'vendedor', disabled = false) {
  const sel = document.createElement('select');
  sel.id = id;
  sel.className = 'loss-select';
  if (disabled) sel.disabled = true;
  ROLE_OPTIONS.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = `${r.label} — ${r.desc}`;
    if (r.id === current) opt.selected = true;
    sel.appendChild(opt);
  });
  return sel;
}

// ============================================================
// STYLES
// ============================================================
const styles = `
  .equipo-list { padding: 18px 20px 32px; }
  @container app (min-width: 900px) { .equipo-list { padding: 22px 32px 40px; } }

  .team-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 16px;
  }
  @container app (min-width: 700px) { .team-grid { grid-template-columns: repeat(2, 1fr); } }
  @container app (min-width: 1200px) { .team-grid { grid-template-columns: repeat(3, 1fr); } }

  .member-card {
    background: var(--cc-surface);
    border: 1px solid var(--cc-line);
    padding: 18px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .member-card:hover { border-color: var(--cc-ink); transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.06); }
  .member-card.inactive { opacity: 0.5; background: var(--cc-bg-alt); }

  .mc-hd { display: flex; gap: 14px; margin-bottom: 16px; }
  .mc-avatar {
    width: 52px; height: 52px; border-radius: 50%;
    background: linear-gradient(135deg, var(--cc-graphite), var(--cc-steel));
    color: var(--cc-bg);
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; font-weight: 600;
    flex-shrink: 0;
  }
  .mc-avatar.role-dueno { background: linear-gradient(135deg, var(--cc-champagne), #8a6f45); color: var(--cc-ink); }
  .mc-avatar.role-gerente { background: linear-gradient(135deg, var(--cc-info), #1f3a5e); }
  .mc-avatar.role-admin_back { background: linear-gradient(135deg, var(--cc-warn), #6b4d1c); }

  .mc-info { flex: 1; min-width: 0; }
  .mc-name {
    font-family: var(--cc-font-display);
    font-weight: 400;
    font-size: 18px;
    line-height: 1.2;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .mc-you { font-family: var(--cc-font-mono); font-size: 9px; padding: 2px 6px; background: var(--cc-champagne); color: var(--cc-ink); letter-spacing: 0.15em; text-transform: uppercase; font-weight: 600; }
  .mc-inactive { font-family: var(--cc-font-mono); font-size: 9px; padding: 2px 6px; background: var(--cc-bg-alt); border: 1px solid var(--cc-line); color: var(--cc-muted); letter-spacing: 0.15em; }
  .mc-role { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.18em; color: var(--cc-champagne); font-weight: 600; text-transform: uppercase; margin-top: 2px; }
  .mc-meta { font-size: 11px; color: var(--cc-muted); margin-top: 2px; }

  .mc-stats {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 1px;
    background: var(--cc-line);
    border: 1px solid var(--cc-line);
    margin-bottom: 14px;
  }
  @container app (max-width: 560px) { .mc-stats { grid-template-columns: repeat(3, 1fr); } }
  .mc-stat { background: var(--cc-bg); padding: 10px 6px; text-align: center; }
  .mc-stat-value { font-family: var(--cc-font-mono); font-weight: 600; font-size: 13px; }
  .mc-stat-label { font-family: var(--cc-font-mono); font-size: 8px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--cc-muted); margin-top: 2px; }

  .mc-target {}
  .mc-target-row { display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 6px; }
  .mc-target-row span { color: var(--cc-muted); }
  .mc-target-row b { font-family: var(--cc-font-mono); }
  .mc-target-bar { height: 6px; background: var(--cc-bg-alt); position: relative; overflow: hidden; }
  .mc-target-bar-fill { position: absolute; inset: 0; background: linear-gradient(90deg, var(--cc-champagne), var(--cc-ok)); transition: width 0.4s; }
  .mc-target-empty { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); letter-spacing: 0.05em; text-align: center; padding: 4px 0; }

  /* MODAL ADD MEMBER */
  .add-intro { font-size: 12px; color: var(--cc-muted); line-height: 1.5; margin-bottom: 16px; padding: 10px 12px; background: var(--cc-bg-alt); border-left: 2px solid var(--cc-champagne); }
  .amf-form { display: flex; flex-direction: column; gap: 12px; }
  .pwd-row { display: flex; gap: 6px; align-items: center; }
  .pwd-row input { flex: 1; font-family: var(--cc-font-mono); }

  /* MODAL CREDENCIALES */
  .creds-card { background: var(--cc-bg-alt); border: 1px solid var(--cc-line); padding: 14px; margin-bottom: 12px; }
  .creds-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--cc-line-soft); font-size: 13px; }
  .creds-row:last-child { border-bottom: none; }
  .creds-row span { color: var(--cc-muted); }
  .creds-row b { font-weight: 500; }
  .creds-pwd { font-family: var(--cc-font-mono); background: var(--cc-ink); color: var(--cc-bg); padding: 3px 8px; letter-spacing: 0.05em; }
  .creds-hint { font-size: 11px; color: var(--cc-muted); line-height: 1.5; padding: 8px 0; }
  .field-row { display: flex; gap: 10px; }
  .field-row .field { flex: 1; }
  .field { display: flex; flex-direction: column; }
  .field-hint { font-size: 11px; color: var(--cc-muted); margin-top: 4px; }

  .loss-select, .loss-notes { width: 100%; padding: 10px 12px; border: 1px solid var(--cc-line); background: var(--cc-bg); font-family: inherit; font-size: 13px; color: var(--cc-ink); }
  .loss-label { display: block; font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cc-muted); font-weight: 500; margin-bottom: 6px; }
`;
