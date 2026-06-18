// ============================================================
// CARCASH · MÓDULO USUARIOS Y ROLES  (ruta /usuarios)
// ------------------------------------------------------------
// Administración de accesos: crear usuarios (login + rol), cambiar
// roles, activar/desactivar. Pensado para el perfil de dueño/gerente.
// Crea el usuario en Supabase Auth + el perfil en una sola operación
// usando un cliente auxiliar (no pisa la sesión del admin).
// ============================================================

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY, createClient } from '../lib/supabase-client.js';
import { state, isAdmin, currentUserId } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles, confirmDialog } from '../lib/dom.js';

const ROLE_OPTIONS = [
  { id: 'dueno',      label: 'Dueño',       desc: 'Acceso total · histórico · configuración crítica' },
  { id: 'gerente',    label: 'Gerente',     desc: 'Ve todo el pipeline · asigna y reasigna leads' },
  { id: 'supervisor', label: 'Supervisor',  desc: 'Ve equipo · objetivos · recibe y asigna leads' },
  { id: 'admin_back', label: 'Back office', desc: 'Operativo · documentación, cobros' },
  { id: 'vendedor',   label: 'Vendedor',    desc: 'Ve solo sus oportunidades' },
];
const ROLE_LABEL = Object.fromEntries(ROLE_OPTIONS.map(r => [r.id, r.label]));
const ROLE_CHIP = { dueno: 'danger', gerente: 'warn', supervisor: 'info', admin_back: '', vendedor: 'ok' };

const local = { users: [], filter: 'all' };

export async function mount() {
  injectStyles('usuarios-styles', styles);
  if (!isAdmin()) {
    $('#view').innerHTML = `<div class="placeholder"><div class="placeholder-content">
      <div class="placeholder-num">×</div>
      <div class="placeholder-title">Acceso <i>restringido</i></div>
      <div class="placeholder-desc">La administración de usuarios es solo para dueño / gerente.</div>
      <div class="placeholder-status">NO AUTORIZADO</div>
    </div></div>`;
    return;
  }
  render();
  await load();
  renderUI();
}
export default mount;

async function load() {
  const { data, error } = await supabase
    .from('users_profile')
    .select('id, full_name, email, phone, role, active, monthly_sales_target, hired_at, created_at, avatar_initials')
    .is('deleted_at', null)
    .order('active', { ascending: false })
    .order('role')
    .order('full_name');
  if (error) { toast('Error cargando usuarios', error.message, 'error'); local.users = []; return; }
  local.users = data || [];
}

function render() {
  $('#view').innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">ADMINISTRACIÓN · ACCESOS</div>
          <div class="page-title">Usuarios &amp; <i>roles</i></div>
          <div class="page-sub" id="us-meta">Cargando…</div>
        </div>
        <div class="page-actions">
          <div class="seg" id="us-filter">
            <button data-f="all" class="active">Todos</button>
            <button data-f="active">Activos</button>
            <button data-f="inactive">Inactivos</button>
          </div>
          <button class="btn" id="us-add">+ Nuevo usuario</button>
        </div>
      </div>
    </div>
    <div class="page-body">
      <div class="note" style="margin-bottom:16px">Acá creás los accesos y definís el rol de cada persona. El rol controla qué ve y qué puede hacer en el CRM. Los leads entrantes se <b>reparten solos</b> entre los vendedores activos (rotación equitativa); si uno no responde en 1 hora, pasa al siguiente.</div>
      <div id="us-list"><div class="empty">Cargando…</div></div>
    </div>
  `;
  $('#us-add').addEventListener('click', openCreateModal);
  $('#us-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]'); if (!b) return;
    local.filter = b.dataset.f;
    $$('#us-filter button').forEach(x => x.classList.toggle('active', x === b));
    renderList();
  });
}

function renderUI() { renderMeta(); renderList(); }

function renderMeta() {
  const active = local.users.filter(u => u.active).length;
  const byRole = {};
  local.users.filter(u => u.active).forEach(u => { byRole[u.role] = (byRole[u.role] || 0) + 1; });
  const parts = ROLE_OPTIONS.filter(r => byRole[r.id]).map(r => `${byRole[r.id]} ${ROLE_LABEL[r.id].toLowerCase()}${byRole[r.id] > 1 ? 's' : ''}`);
  $('#us-meta').innerHTML = `<b>${active}</b> activos · ${parts.join(' · ') || 'sin usuarios'}`;
}

function filtered() {
  if (local.filter === 'active') return local.users.filter(u => u.active);
  if (local.filter === 'inactive') return local.users.filter(u => !u.active);
  return local.users;
}

function renderList() {
  const host = $('#us-list');
  const rows = filtered();
  if (!rows.length) { host.innerHTML = `<div class="empty">Sin usuarios para este filtro</div>`; return; }
  host.innerHTML = `<div class="cc-table-wrap"><table class="cc-table">
    <thead><tr><th>Usuario</th><th>Rol</th><th>Estado</th><th class="num">Objetivo</th><th>Alta</th><th></th></tr></thead>
    <tbody>${rows.map(userRow).join('')}</tbody></table></div>`;
  host.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    const u = local.users.find(x => x.id === b.dataset.edit); if (u) openEditModal(u);
  }));
}

function userRow(u) {
  const me = u.id === currentUserId();
  return `
    <tr class="${u.active ? '' : 'row-off'}">
      <td>
        <div class="us-name">
          <span class="us-ava role-${u.role}">${escapeHtml(u.avatar_initials || fmt.initials(u.full_name))}</span>
          <div>
            <div class="t-strong">${escapeHtml(u.full_name)} ${me ? '<span class="chip sm">vos</span>' : ''}</div>
            <div class="text-muted" style="font-size:11px">${escapeHtml(u.email || '—')}</div>
          </div>
        </div>
      </td>
      <td><span class="chip sm ${ROLE_CHIP[u.role] || ''}">${escapeHtml(ROLE_LABEL[u.role] || u.role)}</span></td>
      <td>${u.active ? '<span class="chip sm ok">Activo</span>' : '<span class="chip sm danger">Inactivo</span>'}</td>
      <td class="num">${u.role === 'vendedor' ? (u.monthly_sales_target || 0) : '—'}</td>
      <td class="text-muted mono" style="font-size:11px">${u.hired_at ? escapeHtml(fmt.dateShortAR(u.hired_at)) : '—'}</td>
      <td style="text-align:right"><button class="ag-mini" data-edit="${u.id}">Editar</button></td>
    </tr>
  `;
}

// ============================================================
// MODAL: CREAR
// ============================================================
function openCreateModal() {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', style: { maxWidth: '500px' } });
  const pwd = generatePassword();
  modal.appendChild(el('div', { class: 'modal-hd' },
    el('h3', {}, 'Nuevo usuario'),
    el('button', { class: 'modal-close', onClick: () => close() }, '×')));
  modal.appendChild(el('div', { class: 'modal-body' },
    el('div', { class: 'note', style: { marginBottom: '14px' } }, 'Se crea el acceso (login) y el perfil con su rol en una sola operación.'),
    field('Nombre completo', el('input', { type: 'text', id: 'u-name', class: 'inp', placeholder: 'Diego Martínez', autocomplete: 'off' })),
    el('div', { class: 'field-row' },
      field('Email (login)', el('input', { type: 'email', id: 'u-email', class: 'inp', placeholder: 'diego@carcash.com.ar', autocomplete: 'off' })),
      field('Teléfono', el('input', { type: 'text', id: 'u-phone', class: 'inp', placeholder: '+54 9 11 …', autocomplete: 'off' })),
    ),
    field('Contraseña inicial', el('div', { class: 'pwd-row' },
      el('input', { type: 'text', id: 'u-pwd', class: 'inp', value: pwd, autocomplete: 'off' }),
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => { $('#u-pwd').value = generatePassword(); } }, '↻'),
    )),
    field('Rol', roleSelect('u-role')),
    field('Objetivo mensual (si es vendedor)', el('input', { type: 'number', id: 'u-target', class: 'inp', value: '5', min: '0' })),
  ));
  modal.appendChild(el('div', { class: 'modal-actions' },
    el('button', { class: 'btn btn-ghost', onClick: () => close() }, 'Cancelar'),
    el('button', { class: 'btn btn-ok', id: 'u-create', onClick: () => create(close) }, '+ Crear usuario')));
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  function close() { backdrop.remove(); }
}

async function create(closeModal) {
  const btn = $('#u-create'); btn.disabled = true; btn.textContent = 'Creando…';
  const name = $('#u-name').value.trim();
  const email = $('#u-email').value.trim().toLowerCase();
  const password = $('#u-pwd').value;
  const role = $('#u-role').value;
  const phone = $('#u-phone').value.trim();
  const target = parseInt($('#u-target').value, 10) || 0;
  const fail = (m) => { toast('Faltan datos', m, 'warn'); btn.disabled = false; btn.textContent = '+ Crear usuario'; };
  if (!name || !email || !password) return fail('Nombre, email y contraseña son obligatorios');
  if (password.length < 6) return fail('La contraseña debe tener al menos 6 caracteres');

  try {
    const aux = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data: signUp, error: suErr } = await aux.auth.signUp({ email, password });
    if (suErr) throw new Error('Auth: ' + suErr.message);
    // Si el email ya tiene cuenta, Supabase devuelve un usuario "vacío"
    // (identities = []). Avisamos claro en vez de fallar por FK del perfil.
    if (signUp?.user && Array.isArray(signUp.user.identities) && signUp.user.identities.length === 0) {
      throw new Error('Ese email ya tiene una cuenta de acceso. Usá otro email distinto.');
    }
    const uid = signUp?.user?.id;
    if (!uid) throw new Error('No se obtuvo el ID del usuario');
    await aux.auth.signOut().catch(() => {});

    const { error: confErr } = await supabase.rpc('auto_confirm_user', { user_id: uid });
    if (confErr) console.warn('auto_confirm_user', confErr);

    const { error: pErr } = await supabase.from('users_profile').insert({
      id: uid, full_name: name, email, phone: phone || null, role,
      monthly_sales_target: role === 'vendedor' ? target : 0, active: true,
    });
    if (pErr) throw new Error('Perfil: ' + pErr.message);

    closeModal();
    showCredentials({ name, email, password, role });
    await load(); renderUI();
  } catch (err) {
    console.error(err);
    toast('Error creando usuario', err.message, 'error');
    btn.disabled = false; btn.textContent = '+ Crear usuario';
  }
}

function showCredentials({ name, email, password, role }) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', style: { maxWidth: '440px' } });
  const msg = `Hola ${name.split(' ')[0]}! Tu acceso al CRM CarCash:\n\n🔗 ${location.origin}${location.pathname}\n✉ ${email}\n🔐 ${password}\n\nPodés cambiar la contraseña una vez que entres.`;
  modal.appendChild(el('div', { class: 'modal-hd' }, el('h3', {}, '✓ Usuario creado'),
    el('button', { class: 'modal-close', onClick: () => close() }, '×')));
  modal.appendChild(el('div', { class: 'modal-body' },
    el('div', { class: 'creds' },
      credRow('Nombre', name), credRow('Email', email),
      credRow('Contraseña', password, true), credRow('Rol', ROLE_LABEL[role] || role)),
    el('div', { class: 'text-muted', style: { fontSize: '11px', marginTop: '10px' } }, 'Compartile estas credenciales. Va a poder cambiar la contraseña al ingresar.')));
  modal.appendChild(el('div', { class: 'modal-actions' },
    el('button', { class: 'btn btn-ghost', onClick: () => { navigator.clipboard?.writeText(msg); toast('Copiado', null, 'ok'); } }, '⧉ Copiar'),
    el('a', { class: 'btn', href: `https://wa.me/?text=${encodeURIComponent(msg)}`, target: '_blank', rel: 'noopener', onClick: () => close() }, '● WhatsApp'),
    el('button', { class: 'btn btn-ok', onClick: () => close() }, 'Listo')));
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  function close() { backdrop.remove(); }
}

// ============================================================
// MODAL: EDITAR
// ============================================================
function openEditModal(u) {
  const me = u.id === currentUserId();
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', style: { maxWidth: '500px' } });
  modal.appendChild(el('div', { class: 'modal-hd' }, el('h3', {}, `Editar ${u.full_name}`),
    el('button', { class: 'modal-close', onClick: () => close() }, '×')));
  modal.appendChild(el('div', { class: 'modal-body' },
    field('Nombre completo', el('input', { type: 'text', id: 'e-name', class: 'inp', value: u.full_name })),
    el('div', { class: 'field-row' },
      field('Email', el('input', { type: 'email', id: 'e-email', class: 'inp', value: u.email || '' })),
      field('Teléfono', el('input', { type: 'text', id: 'e-phone', class: 'inp', value: u.phone || '' })),
    ),
    field('Rol', roleSelect('e-role', u.role, me)),
    me ? el('div', { class: 'text-muted', style: { fontSize: '11px', marginTop: '-8px', marginBottom: '10px' } }, 'No podés cambiar tu propio rol.') : null,
    field('Objetivo mensual', el('input', { type: 'number', id: 'e-target', class: 'inp', value: u.monthly_sales_target || 0, min: '0' })),
    el('label', { class: 'cb', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' } },
      el('input', { type: 'checkbox', id: 'e-active', checked: !!u.active, disabled: me }),
      el('span', {}, 'Usuario activo'),
    ),
    me ? null : el('div', { class: 'text-muted', style: { fontSize: '11px', marginTop: '4px' } }, 'Desmarcá "activo" para suspender el acceso temporalmente (lo podés reactivar). "Eliminar" lo saca de la lista.'),
  ));
  modal.appendChild(el('div', { class: 'modal-actions' },
    me ? null : el('button', { class: 'btn btn-danger btn-sm', onClick: () => removeUser(u, close) }, 'Eliminar usuario'),
    el('div', { style: { flex: '1' } }),
    el('button', { class: 'btn btn-ghost', onClick: () => close() }, 'Cancelar'),
    el('button', { class: 'btn btn-ok', id: 'e-save', onClick: () => save(u, me, close) }, 'Guardar')));
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  function close() { backdrop.remove(); }
}

async function save(u, me, closeModal) {
  const update = {
    full_name: $('#e-name').value.trim(),
    email: $('#e-email').value.trim() || null,
    phone: $('#e-phone').value.trim() || null,
    monthly_sales_target: parseInt($('#e-target').value, 10) || 0,
  };
  if (!me) {
    update.role = $('#e-role').value;
    update.active = $('#e-active').checked;
  }
  const { error } = await supabase.from('users_profile').update(update).eq('id', u.id);
  if (error) { toast('Error', error.message, 'error'); return; }
  toast('Cambios guardados', u.full_name, 'ok');
  closeModal();
  await load(); renderUI();
}

async function removeUser(u, closeModal) {
  const ok = await confirmDialog(
    `¿Eliminar a ${u.full_name}? Pierde el acceso y sale de la lista. Sus ventas y registros históricos se conservan. Los leads que tenga abiertos conviene reasignarlos.`,
    { okText: 'Eliminar', danger: true });
  if (!ok) return;
  const { error } = await supabase.from('users_profile')
    .update({ active: false, deleted_at: new Date().toISOString() }).eq('id', u.id);
  if (error) { toast('Error', error.message, 'error'); return; }
  toast('Usuario eliminado', u.full_name, 'warn');
  closeModal();
  await load(); renderUI();
}

// ============================================================
// HELPERS
// ============================================================
function field(label, input) {
  return el('div', { class: 'field', style: { marginBottom: '12px' } },
    el('label', { class: 'inp-label' }, label), input);
}
function roleSelect(id, current = 'vendedor', disabled = false) {
  const sel = el('select', { id, class: 'sel' });
  if (disabled) sel.disabled = true;
  ROLE_OPTIONS.forEach(r => {
    const opt = new Option(`${r.label} — ${r.desc}`, r.id, false, r.id === current);
    sel.appendChild(opt);
  });
  return sel;
}
function credRow(label, value, mono = false) {
  return el('div', { class: 'cred-row' }, el('span', {}, label),
    el('b', mono ? { class: 'cred-mono' } : {}, value));
}
function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let p = '';
  for (let i = 0; i < 10; i++) p += chars[Math.floor(Math.random() * chars.length)];
  return p;
}

const styles = `
  .us-name { display: flex; align-items: center; gap: 10px; }
  .us-ava { width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; color: var(--cc-bg); background: linear-gradient(135deg, var(--cc-graphite), var(--cc-steel)); }
  .us-ava.role-dueno { background: linear-gradient(135deg, var(--cc-champagne), #8a6f45); color: var(--cc-ink); }
  .us-ava.role-gerente { background: linear-gradient(135deg, var(--cc-info), #1f3a5e); }
  .us-ava.role-supervisor { background: linear-gradient(135deg, #3A5B87, #243b59); }
  .us-ava.role-admin_back { background: linear-gradient(135deg, var(--cc-warn), #6b4d1c); }
  .cc-table tr.row-off { opacity: 0.55; }
  .field-row { display: flex; gap: 10px; }
  .field-row .field { flex: 1; }
  .pwd-row { display: flex; gap: 6px; align-items: center; }
  .pwd-row .inp { flex: 1; font-family: var(--cc-font-mono); }
  .creds { background: var(--cc-bg-alt); border: 1px solid var(--cc-line); padding: 12px 14px; }
  .cred-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--cc-line-soft); font-size: 13px; }
  .cred-row:last-child { border-bottom: none; }
  .cred-row span { color: var(--cc-muted); }
  .cred-mono { font-family: var(--cc-font-mono); background: var(--cc-ink); color: var(--cc-bg); padding: 3px 8px; }
`;
