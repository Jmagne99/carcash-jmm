// ============================================================
// CARCASH · MÓDULO AGENDA  (ruta /agenda)
// ------------------------------------------------------------
// El "centro de seguimiento" del vendedor:
//   - Tareas + próximas acciones (next_action_due_at) agrupadas
//     por Vencidas / Hoy / Mañana / Próximos 7 días.
//   - Leads que se enfrían: alerta a las 24h sin contacto y
//     "FRÍO" a partir de los 4 días (96h, configurable en settings).
//   - Acciones manuales del vendedor: registrar contacto,
//     reprogramar (llamar tal fecha), o marcar "compró en otra
//     agencia" (pierde la oportunidad).
//
// Roles: el vendedor ve lo suyo. Supervisor/gerente/dueño ven
// todo el equipo y pueden filtrar por vendedor.
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { state, isSupervisorOrAdmin, currentUserId } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles, confirmDialog } from '../lib/dom.js';
import { navigate } from '../lib/router.js';
import { loadThresholds, DEFAULT_THRESHOLDS } from '../lib/contact-alerts.js';

const local = {
  thresholds: { ...DEFAULT_THRESHOLDS, cold: 96 },
  filterUser: 'me',     // 'me' | 'all' | <userId>
  members: [],          // para el selector (solo supervisor/admin)
  actions: [],          // tareas + next_action unificadas
  coldLeads: [],        // oportunidades con alerta de contacto
};

// ============================================================
// MOUNT
// ============================================================
export async function mount() {
  injectStyles('agenda-styles', styles);
  const th = await loadThresholds();
  local.thresholds = {
    warn: th.warn ?? 24,
    danger: th.danger ?? 72,
    cold: th.cold ?? 96,
  };
  if (isSupervisorOrAdmin()) {
    local.filterUser = 'all';
    await loadMembers();
  } else {
    local.filterUser = 'me';
  }
  render();
  await loadAll();
  renderUI();
}
export default mount;

// ============================================================
// FETCH
// ============================================================
async function loadMembers() {
  const { data } = await supabase
    .from('users_profile')
    .select('id, full_name, role')
    .eq('active', true)
    .is('deleted_at', null)
    .order('full_name');
  local.members = data || [];
}

function targetUserId() {
  if (local.filterUser === 'me') return currentUserId();
  if (local.filterUser === 'all') return null;
  return local.filterUser;
}

async function loadAll() {
  const [actions, cold] = await Promise.all([fetchActions(), fetchColdLeads()]);
  local.actions = actions;
  local.coldLeads = cold;
}

/**
 * Unifica dos fuentes de "cosas por hacer":
 *  1. tasks abiertas (completed_at null) con due_at
 *  2. opportunities con next_action pendiente (next_action_done=false)
 * Devuelve items normalizados { kind, id, title, due, oppId, oppCode, who, contact }.
 */
async function fetchActions() {
  const uid = targetUserId();
  const items = [];

  // 1) Tareas
  let taskQ = supabase
    .from('tasks')
    .select('id, title, description, due_at, priority, assigned_to, opportunity_id, contact_id, unit_id, completed_at, assignee:users_profile!assigned_to(full_name), opportunity:opportunities!opportunity_id(opp_code), contact:contacts!contact_id(full_name)')
    .is('completed_at', null)
    .order('due_at', { ascending: true, nullsFirst: false });
  if (uid) taskQ = taskQ.eq('assigned_to', uid);
  const { data: tasks, error: tErr } = await taskQ;
  if (tErr) console.warn('tasks fetch', tErr);
  for (const t of tasks || []) {
    items.push({
      kind: 'task',
      id: t.id,
      title: t.title,
      desc: t.description,
      due: t.due_at,
      priority: t.priority || 'media',
      oppId: t.opportunity_id,
      oppCode: t.opportunity?.opp_code || null,
      who: t.assignee?.full_name || '',
      contact: t.contact?.full_name || '',
    });
  }

  // 2) Próximas acciones de oportunidades
  let oppQ = supabase
    .from('opportunities')
    .select('id, opp_code, next_action_title, next_action_due_at, assigned_to, stage, assignee:users_profile!assigned_to(full_name), contact:contacts!contact_id(full_name)')
    .eq('next_action_done', false)
    .not('next_action_due_at', 'is', null)
    .not('stage', 'in', '(ganada,perdida)')
    .is('deleted_at', null)
    .order('next_action_due_at', { ascending: true });
  if (uid) oppQ = oppQ.eq('assigned_to', uid);
  const { data: opps, error: oErr } = await oppQ;
  if (oErr) console.warn('opp actions fetch', oErr);
  for (const o of opps || []) {
    items.push({
      kind: 'opp',
      id: o.id,
      title: o.next_action_title || 'Próxima acción',
      desc: '',
      due: o.next_action_due_at,
      priority: 'media',
      oppId: o.id,
      oppCode: o.opp_code,
      who: o.assignee?.full_name || '',
      contact: o.contact?.full_name || '',
    });
  }

  items.sort((a, b) => {
    if (!a.due) return 1;
    if (!b.due) return -1;
    return new Date(a.due) - new Date(b.due);
  });
  return items;
}

/** Oportunidades activas con horas sin contacto (vista con alertas). */
async function fetchColdLeads() {
  const uid = targetUserId();
  let q = supabase
    .from('opportunities_with_contact_alerts')
    .select('id, opp_code, stage, origin, assigned_to, hours_since_contact, last_contact_at, expected_amount, next_action_due_at, contact:contacts!contact_id(full_name, phone), assignee:users_profile!assigned_to(full_name)')
    .not('stage', 'in', '(ganada,perdida)')
    .gte('hours_since_contact', local.thresholds.warn)
    .order('hours_since_contact', { ascending: false });
  if (uid) q = q.eq('assigned_to', uid);
  const { data, error } = await q;
  if (error) { console.warn('cold leads fetch', error); return []; }
  return data || [];
}

// ============================================================
// RENDER (shell)
// ============================================================
function render() {
  $('#view').innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">MÓDULO 05 · COMERCIAL</div>
          <div class="page-title">Agenda &amp; <i>seguimiento</i></div>
          <div class="page-sub" id="ag-meta">Cargando…</div>
        </div>
        <div class="page-actions" id="ag-actions"></div>
      </div>
      <div class="kpi-grid" id="ag-kpis"></div>
    </div>
    <div class="page-body">
      <div class="ag-cols">
        <section class="ag-col">
          <div class="ag-col-hd"><span>Acciones pendientes</span><span class="ag-col-count" id="ag-act-count">—</span></div>
          <div id="ag-actions-list"><div class="empty">Cargando…</div></div>
        </section>
        <section class="ag-col">
          <div class="ag-col-hd"><span>Leads que se enfrían</span><span class="ag-col-count" id="ag-cold-count">—</span></div>
          <div id="ag-cold-list"><div class="empty">Cargando…</div></div>
        </section>
      </div>
    </div>
  `;

  // Selector de vendedor (solo supervisor/admin)
  const actions = $('#ag-actions');
  if (isSupervisorOrAdmin()) {
    const sel = el('select', { class: 'sel', style: { width: 'auto' }, id: 'ag-user' });
    sel.appendChild(new Option('Todo el equipo', 'all', false, local.filterUser === 'all'));
    sel.appendChild(new Option('— Solo yo —', 'me', false, local.filterUser === 'me'));
    local.members.forEach(m => sel.appendChild(new Option(m.full_name, m.id, false, local.filterUser === m.id)));
    sel.addEventListener('change', async () => {
      local.filterUser = sel.value;
      await loadAll();
      renderUI();
    });
    actions.appendChild(sel);
  }
  actions.appendChild(el('button', { class: 'btn btn-ghost', onClick: () => mount() }, 'Actualizar'));
}

// ============================================================
// RENDER (data)
// ============================================================
function renderUI() {
  renderKpis();
  renderActions();
  renderColdLeads();
}

function isOverdue(due) { return due && new Date(due) < new Date(); }
function isToday(due) {
  if (!due) return false;
  const d = new Date(due), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

function renderKpis() {
  const overdue = local.actions.filter(a => isOverdue(a.due)).length;
  const today = local.actions.filter(a => isToday(a.due) && !isOverdue(a.due)).length;
  const warm = local.coldLeads.filter(l => l.hours_since_contact < local.thresholds.cold).length;
  const cold = local.coldLeads.filter(l => l.hours_since_contact >= local.thresholds.cold).length;

  $('#ag-meta').innerHTML = local.filterUser === 'all'
    ? 'Seguimiento de <b>todo el equipo</b>'
    : (local.filterUser === 'me' ? 'Tu seguimiento del día' : 'Seguimiento del vendedor seleccionado');

  $('#ag-kpis').innerHTML = `
    <div class="kpi-card ${overdue ? 'danger' : ''}">
      <div class="kpi-label">Vencidas</div>
      <div class="kpi-value">${overdue}</div>
      <div class="kpi-sub">${overdue ? 'requieren atención' : 'al día'}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Para hoy</div>
      <div class="kpi-value">${today}</div>
      <div class="kpi-sub">acciones programadas</div>
    </div>
    <div class="kpi-card ${warm ? 'warn' : ''}">
      <div class="kpi-label">+24h sin contacto</div>
      <div class="kpi-value">${warm}</div>
      <div class="kpi-sub">contactar pronto</div>
    </div>
    <div class="kpi-card ${cold ? 'danger' : ''}">
      <div class="kpi-label">Leads fríos (+4 días)</div>
      <div class="kpi-value">${cold}</div>
      <div class="kpi-sub">${cold ? 'riesgo de pérdida' : 'sin leads fríos'}</div>
    </div>
  `;
}

const GROUPS = [
  { id: 'overdue', label: 'Vencidas' },
  { id: 'today',   label: 'Hoy' },
  { id: 'tomorrow',label: 'Mañana' },
  { id: 'week',    label: 'Próximos 7 días' },
  { id: 'later',   label: 'Más adelante' },
];

function bucketFor(due) {
  if (!due) return 'later';
  const d = new Date(due), n = new Date();
  if (d < n && !isToday(due)) return 'overdue';
  if (isToday(due)) return d < n ? 'overdue' : 'today';
  const startTom = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
  const endTom = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 2);
  if (d >= startTom && d < endTom) return 'tomorrow';
  const in7 = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 8);
  if (d < in7) return 'week';
  return 'later';
}

function renderActions() {
  const host = $('#ag-actions-list');
  $('#ag-act-count').textContent = local.actions.length;
  if (!local.actions.length) {
    host.innerHTML = `<div class="empty-rich"><div class="er-icon">✓</div><div class="er-title">Todo al día</div><div class="er-desc">No tenés tareas ni acciones pendientes. Cuando programes un seguimiento aparecerá acá.</div></div>`;
    return;
  }
  const byGroup = {};
  for (const a of local.actions) (byGroup[bucketFor(a.due)] ??= []).push(a);

  host.innerHTML = GROUPS.filter(g => byGroup[g.id]?.length).map(g => `
    <div class="ag-group">
      <div class="ag-group-hd ${g.id === 'overdue' ? 'is-overdue' : ''}">${g.label} <span>${byGroup[g.id].length}</span></div>
      ${byGroup[g.id].map(actionRow).join('')}
    </div>
  `).join('');

  host.querySelectorAll('[data-done]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation(); completeTask(b.dataset.done);
  }));
  host.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => {
    const code = b.dataset.open; if (code) navigate('/pipeline/' + code.toLowerCase());
  }));
}

function actionRow(a) {
  const overdue = isOverdue(a.due);
  const prioClass = a.priority === 'alta' ? 'danger' : (a.priority === 'baja' ? '' : 'warn');
  return `
    <div class="ag-item ${a.oppCode ? 'clickable' : ''}" ${a.oppCode ? `data-open="${escapeHtml(a.oppCode)}"` : ''}>
      <div class="ag-item-kind ${a.kind}">${a.kind === 'task' ? '✓' : '☎'}</div>
      <div class="ag-item-main">
        <div class="ag-item-title">${escapeHtml(a.title)}</div>
        <div class="ag-item-meta">
          ${a.contact ? `<span>${escapeHtml(a.contact)}</span>` : ''}
          ${a.oppCode ? `<span class="mono">${escapeHtml(a.oppCode)}</span>` : ''}
          ${a.who && local.filterUser !== 'me' ? `<span class="ag-who">${escapeHtml(a.who)}</span>` : ''}
        </div>
      </div>
      <div class="ag-item-right">
        <div class="ag-due ${overdue ? 'overdue' : ''}">${escapeHtml(fmt.relative(a.due))}</div>
        ${a.kind === 'task' ? `<button class="ag-mini" data-done="${a.id}" title="Marcar hecha">Hecha</button>` : ''}
      </div>
    </div>
  `;
}

function renderColdLeads() {
  const host = $('#ag-cold-list');
  $('#ag-cold-count').textContent = local.coldLeads.length;
  if (!local.coldLeads.length) {
    host.innerHTML = `<div class="empty-rich"><div class="er-icon">◷</div><div class="er-title">Sin leads en riesgo</div><div class="er-desc">Todas las oportunidades activas tuvieron contacto en las últimas ${local.thresholds.warn}h.</div></div>`;
    return;
  }
  host.innerHTML = local.coldLeads.map(coldRow).join('');

  host.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => navigate('/pipeline/' + b.dataset.open.toLowerCase())));
  host.querySelectorAll('[data-contacted]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); registerContact(b.dataset.contacted); }));
  host.querySelectorAll('[data-snooze]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); snoozeLead(b.dataset.snooze); }));
  host.querySelectorAll('[data-lost]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); markBoughtElsewhere(b.dataset.lost, b.dataset.code); }));
}

function coldRow(l) {
  const h = Math.round(l.hours_since_contact || 0);
  const isCold = h >= local.thresholds.cold;
  const isDanger = h >= local.thresholds.danger;
  const lvl = isCold ? 'cold' : (isDanger ? 'danger' : 'warn');
  const days = Math.floor(h / 24);
  const label = isCold ? `FRÍO · ${days}d sin contacto` : `${h}h sin contacto`;
  return `
    <div class="ag-lead lvl-${lvl}">
      <div class="ag-lead-bar"></div>
      <div class="ag-lead-main clickable" data-open="${escapeHtml(l.opp_code)}">
        <div class="ag-lead-top">
          <span class="ag-lead-name">${escapeHtml(l.contact?.full_name || 'Sin nombre')}</span>
          <span class="chip sm ${lvl === 'cold' ? 'danger' : (lvl === 'danger' ? 'danger' : 'warn')}">${escapeHtml(label)}</span>
        </div>
        <div class="ag-lead-meta">
          <span class="mono">${escapeHtml(l.opp_code)}</span>
          <span>${escapeHtml(fmt.humanize(l.stage))}</span>
          ${l.expected_amount ? `<span>USD ${escapeHtml(fmt.compact(l.expected_amount))}</span>` : ''}
          ${local.filterUser !== 'me' && l.assignee?.full_name ? `<span class="ag-who">${escapeHtml(l.assignee.full_name)}</span>` : ''}
        </div>
      </div>
      <div class="ag-lead-actions">
        <button class="ag-mini ok" data-contacted="${l.id}" title="Registrar que lo contactaste">Contacté</button>
        <button class="ag-mini" data-snooze="${l.id}" title="Reprogramar para mañana">Llamar +1d</button>
        <button class="ag-mini danger" data-lost="${l.id}" data-code="${escapeHtml(l.opp_code)}" title="Compró en otra agencia">Perdido</button>
      </div>
    </div>
  `;
}

// ============================================================
// ACCIONES (escrituras)
// ============================================================
async function completeTask(id) {
  const { error } = await supabase.from('tasks').update({ completed_at: new Date().toISOString() }).eq('id', id);
  if (error) { toast('Error', error.message, 'error'); return; }
  toast('Tarea completada', null, 'ok');
  await loadAll(); renderUI();
}

/** Registra un contacto saliente → resetea las horas sin contacto. */
async function registerContact(oppId) {
  const { error } = await supabase.from('timeline_events').insert({
    opportunity_id: oppId,
    event_type: 'llamada',
    channel: 'llamada',
    direction: 'saliente',
    title: 'Contacto registrado desde agenda',
    user_id: currentUserId(),
    is_system: false,
  });
  if (error) { toast('Error', error.message, 'error'); return; }
  toast('Contacto registrado', 'El lead vuelve a estar al día', 'ok');
  await loadAll(); renderUI();
}

/** Reprograma la próxima acción para mañana a las 10:00 (acción manual del vendedor). */
async function snoozeLead(oppId) {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  t.setHours(10, 0, 0, 0);
  const { error } = await supabase.from('opportunities').update({
    next_action_title: 'Llamar al cliente',
    next_action_due_at: t.toISOString(),
    next_action_done: false,
  }).eq('id', oppId);
  if (error) { toast('Error', error.message, 'error'); return; }
  toast('Reprogramado', 'Llamada agendada para mañana 10:00', 'ok');
  await loadAll(); renderUI();
}

/** Marca la oportunidad como perdida por "compró en la competencia". */
async function markBoughtElsewhere(oppId, code) {
  const ok = await confirmDialog(
    `¿Marcar ${code} como perdida porque el cliente compró en otra agencia?`,
    { okText: 'Sí, marcar perdida' }
  );
  if (!ok) return;
  const { error } = await supabase.from('opportunities').update({
    stage: 'perdida',
    loss_reason: 'compro_en_competencia',
    lost_at: new Date().toISOString(),
    next_action_done: true,
  }).eq('id', oppId);
  if (error) { toast('Error', error.message, 'error'); return; }
  toast('Oportunidad cerrada', `${code} marcada como perdida`, 'warn');
  await loadAll(); renderUI();
}

// ============================================================
// STYLES
// ============================================================
const styles = `
  .ag-cols { display: grid; grid-template-columns: 1fr; gap: 20px; }
  @container app (min-width: 1000px) { .ag-cols { grid-template-columns: 1fr 1fr; } }

  .ag-col { background: var(--cc-surface); border: 1px solid var(--cc-line); }
  .ag-col-hd {
    display: flex; justify-content: space-between; align-items: center;
    padding: 13px 16px; border-bottom: 1px solid var(--cc-line);
    font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.18em;
    text-transform: uppercase; font-weight: 600; color: var(--cc-ink);
    background: var(--cc-bg-alt);
  }
  .ag-col-count { color: var(--cc-champagne); }

  .ag-group { border-bottom: 1px solid var(--cc-line-soft); }
  .ag-group-hd {
    padding: 9px 16px; font-family: var(--cc-font-mono); font-size: 9px;
    letter-spacing: 0.2em; text-transform: uppercase; color: var(--cc-muted);
    background: var(--cc-bg); display: flex; gap: 8px; align-items: center;
  }
  .ag-group-hd span { color: var(--cc-steel); }
  .ag-group-hd.is-overdue { color: var(--cc-danger); }

  .ag-item { display: flex; gap: 12px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--cc-line-soft); }
  .ag-item:last-child { border-bottom: none; }
  .ag-item.clickable { cursor: pointer; }
  .ag-item.clickable:hover { background: var(--cc-bg-alt); }
  .ag-item-kind { width: 26px; height: 26px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border: 1px solid var(--cc-line); font-size: 12px; color: var(--cc-muted); }
  .ag-item-kind.opp { color: var(--cc-info); border-color: var(--cc-info); }
  .ag-item-main { flex: 1; min-width: 0; }
  .ag-item-title { font-size: 13px; font-weight: 500; line-height: 1.3; }
  .ag-item-meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 11px; color: var(--cc-muted); margin-top: 3px; }
  .ag-item-meta .mono { font-family: var(--cc-font-mono); }
  .ag-who { color: var(--cc-champagne); }
  .ag-item-right { text-align: right; flex-shrink: 0; display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
  .ag-due { font-family: var(--cc-font-mono); font-size: 11px; color: var(--cc-muted); }
  .ag-due.overdue { color: var(--cc-danger); font-weight: 600; }

  .ag-mini {
    border: 1px solid var(--cc-line); background: var(--cc-surface); cursor: pointer;
    font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.1em;
    text-transform: uppercase; padding: 4px 8px; color: var(--cc-ink-soft);
    transition: all .12s var(--cc-ease);
  }
  .ag-mini:hover { background: var(--cc-ink); color: var(--cc-bg); border-color: var(--cc-ink); }
  .ag-mini.ok:hover { background: var(--cc-ok); border-color: var(--cc-ok); }
  .ag-mini.danger:hover { background: var(--cc-danger); border-color: var(--cc-danger); }

  .ag-lead { display: flex; gap: 0; border-bottom: 1px solid var(--cc-line-soft); position: relative; }
  .ag-lead:last-child { border-bottom: none; }
  .ag-lead-bar { width: 3px; flex-shrink: 0; background: var(--cc-warn); }
  .ag-lead.lvl-danger .ag-lead-bar { background: #FF8C42; }
  .ag-lead.lvl-cold .ag-lead-bar { background: var(--cc-danger); }
  .ag-lead-main { flex: 1; min-width: 0; padding: 12px 14px; cursor: pointer; }
  .ag-lead-main:hover { background: var(--cc-bg-alt); }
  .ag-lead-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .ag-lead-name { font-size: 13px; font-weight: 600; }
  .ag-lead-meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 11px; color: var(--cc-muted); margin-top: 4px; }
  .ag-lead-meta .mono { font-family: var(--cc-font-mono); }
  .ag-lead-actions { display: flex; flex-direction: column; gap: 4px; justify-content: center; padding: 10px 12px; flex-shrink: 0; }
`;
