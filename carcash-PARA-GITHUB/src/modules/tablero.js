// ============================================================
// CARCASH · MÓDULO TABLERO DEL DÍA
// Pantalla de inicio del vendedor (y vista resumen del dueño).
// Ruta: /tablero
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { state, isAdmin, currentUserId } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles } from '../lib/dom.js';
import { navigate } from '../lib/router.js';
import { fetchOpportunitiesWithAlerts, loadThresholds, levelForHours, LEVEL_LABELS } from '../lib/contact-alerts.js';

// ============================================================
// CONFIG
// ============================================================
const STAGES = [
  { id: 'nuevo',       name: 'Nuevo',       num: '01' },
  { id: 'contactado',  name: 'Contactado',  num: '02' },
  { id: 'visita_test', name: 'Visita',      num: '03' },
  { id: 'presupuesto', name: 'Presupuesto', num: '04' },
  { id: 'negociacion', name: 'Negociación', num: '05' },
  { id: 'reserva',     name: 'Reserva',     num: '06' },
  { id: 'ganada',      name: 'Ganada',      num: '07' },
];

const STALE_DAYS = 3; // sin actividad por X días → flag

// ============================================================
// DATA FETCH
// ============================================================
async function fetchAll() {
  const me = currentUserId();
  const admin = isAdmin();

  // Base query: oportunidades activas asignadas a mí (o todas si admin)
  let baseQ = supabase
    .from('opportunities')
    .select(`
      id, opp_code, stage, origin, ai_score, expected_amount,
      next_action_title, next_action_due_at, next_action_done,
      assigned_to, created_at, updated_at, stage_changed_at,
      contact:contacts(id, full_name),
      unit:units!unit_of_interest_id(id, brand, model, year),
      assignee:users_profile!assigned_to(id, full_name, avatar_initials)
    `)
    .is('deleted_at', null);

  if (!admin) {
    baseQ = baseQ.eq('assigned_to', me);
  }

  const { data: opps, error: oppsErr } = await baseQ;
  if (oppsErr) {
    console.error('opps fetch error', oppsErr);
    toast('Error cargando oportunidades', oppsErr.message, 'error');
    return null;
  }

  // Tareas del día (mías o todas si admin)
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  let tasksQ = supabase
    .from('tasks')
    .select('id, title, due_at, task_type, priority, completed_at, opportunity_id, contact_id')
    .gte('due_at', startOfDay.toISOString())
    .lte('due_at', endOfDay.toISOString())
    .order('due_at');
  if (!admin) tasksQ = tasksQ.eq('assigned_to', me);

  const { data: tasks } = await tasksQ;

  // Ventas MTD
  const startMonth = new Date();
  startMonth.setDate(1);
  startMonth.setHours(0, 0, 0, 0);

  let salesQ = supabase
    .from('sales')
    .select('id, sale_price, gross_margin, created_at, status')
    .gte('created_at', startMonth.toISOString())
    .is('deleted_at', null);
  if (!admin) salesQ = salesQ.eq('seller_user_id', me);

  const { data: sales } = await salesQ;

  // Settings (objetivo)
  const { data: settingTarget } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'targets')
    .maybeSingle();

  // Alertas de contacto
  const thresholds = await loadThresholds();
  const contactAlerts = await fetchOpportunitiesWithAlerts(
    admin ? { minHours: thresholds.warn } : { assigned_to: me, minHours: thresholds.warn }
  );

  return {
    opps: opps || [],
    tasks: tasks || [],
    sales: sales || [],
    targets: settingTarget?.value || {},
    contactAlerts,
    contactThresholds: thresholds,
    isAdmin: admin,
  };
}

// ============================================================
// MOUNT
// ============================================================
export async function mount() {
  injectStyles('tablero-styles', styles);
  renderLoading();
  const data = await fetchAll();
  if (!data) return;
  render(data);
}

export default mount;

function renderLoading() {
  $('#view').innerHTML = `
    <div class="empty">Cargando tablero…</div>
  `;
}

// ============================================================
// RENDER
// ============================================================
function render(data) {
  const view = $('#view');
  const me = state.profile;
  const greeting = greetingForNow();
  const today = new Date();
  const todayLabel = today.toLocaleDateString('es-AR', {
    weekday: 'long', day: 'numeric', month: 'long',
  }).toUpperCase();

  // Cálculos
  const activeOpps = data.opps.filter(o => !['ganada', 'perdida'].includes(o.stage));
  const myActiveOpps = data.isAdmin
    ? activeOpps.filter(o => o.assigned_to === currentUserId())
    : activeOpps;

  const urgent = activeOpps.filter(isUrgent);
  const stale = activeOpps.filter(isStale);
  const newLeads = activeOpps.filter(o => o.stage === 'nuevo');

  const pipelineValue = activeOpps.reduce((s, o) => s + (o.expected_amount || 0), 0);
  const wonMTD = data.sales.filter(s => s.status !== 'cancelada');
  const wonCount = wonMTD.length;
  const wonValue = wonMTD.reduce((s, x) => s + (x.sale_price || 0), 0);
  const wonMargin = wonMTD.reduce((s, x) => s + (x.gross_margin || 0), 0);

  // Conteo por etapa
  const byStage = STAGES.map(s => ({
    ...s,
    count: activeOpps.filter(o => o.stage === s.id).length,
    value: activeOpps.filter(o => o.stage === s.id).reduce((sum, o) => sum + (o.expected_amount || 0), 0),
  }));

  // Objetivo del mes
  const target = me?.monthly_sales_target || data.targets?.monthly_sales || 0;
  const targetPct = target > 0 ? Math.min(100, (wonCount / target) * 100) : 0;

  view.innerHTML = `
    <div class="tab-hero">
      <div class="tab-hero-row">
        <div>
          <div class="tab-hero-greet">${escapeHtml(greeting)}, <i>${escapeHtml(me?.full_name?.split(' ')[0] || 'vendedor')}</i></div>
          <div class="tab-hero-date">${escapeHtml(todayLabel)}</div>
        </div>
        <div class="tab-hero-quick">
          <button class="btn btn-ghost btn-sm" id="btn-quick-pipeline">Ver pipeline →</button>
          <button class="btn btn-sm" id="btn-quick-new">+ Nueva oportunidad</button>
        </div>
      </div>
    </div>

    <div class="tab-kpis">
      ${kpi('Oportunidades activas', myActiveOpps.length, urgent.length > 0 ? `${urgent.length} urgentes` : 'Sin urgencias', urgent.length > 0 ? 'danger' : '')}
      ${kpi('Pipeline (USD)', fmt.compact(pipelineValue), 'En curso', '')}
      ${kpi('Cierres del mes', wonCount, target > 0 ? `de ${target} objetivo` : '—', wonCount >= target && target > 0 ? 'ok' : '')}
      ${kpi('Margen MTD', wonMargin > 0 ? 'USD ' + fmt.compact(wonMargin) : '—', wonValue > 0 ? `${((wonMargin / wonValue) * 100).toFixed(1)}% promedio` : '—', '')}
    </div>

    <div class="tab-grid">
      <!-- COLUMNA IZQUIERDA: ALERTAS Y NUEVAS -->
      <div class="tab-col">
        <div class="tab-section">
          <div class="tab-section-hd">
            <span>Sin contactar al cliente</span>
            <span class="ts-count">${data.contactAlerts.length}</span>
          </div>
          ${renderContactAlerts(data.contactAlerts, data.contactThresholds)}
        </div>

        <div class="tab-section">
          <div class="tab-section-hd">
            <span>Acción urgente</span>
            <span class="ts-count">${urgent.length}</span>
          </div>
          ${renderUrgentList(urgent)}
        </div>

        <div class="tab-section">
          <div class="tab-section-hd">
            <span>Leads sin contactar</span>
            <span class="ts-count">${newLeads.length}</span>
          </div>
          ${renderNewLeadsList(newLeads)}
        </div>

        <div class="tab-section">
          <div class="tab-section-hd">
            <span>Sin actividad ${STALE_DAYS}+ días</span>
            <span class="ts-count">${stale.length}</span>
          </div>
          ${renderStaleList(stale)}
        </div>
      </div>

      <!-- COLUMNA DERECHA: AGENDA + PIPELINE + TARGET -->
      <div class="tab-col">
        <div class="tab-section">
          <div class="tab-section-hd">
            <span>Agenda de hoy</span>
            <span class="ts-count">${data.tasks.length}</span>
          </div>
          ${renderAgenda(data.tasks)}
        </div>

        <div class="tab-section">
          <div class="tab-section-hd">
            <span>Pipeline</span>
            <span class="ts-count">${activeOpps.length}</span>
          </div>
          <div class="pipeline-mini">
            ${byStage.map(s => `
              <div class="pm-row" data-stage="${s.id}">
                <div class="pm-num">${s.num}</div>
                <div class="pm-name">${escapeHtml(s.name)}</div>
                <div class="pm-bar">
                  <div class="pm-bar-fill" style="width: ${activeOpps.length > 0 ? (s.count / activeOpps.length) * 100 : 0}%"></div>
                </div>
                <div class="pm-count">${s.count}</div>
                <div class="pm-value">${s.value > 0 ? 'USD ' + fmt.compact(s.value) : '—'}</div>
              </div>
            `).join('')}
          </div>
        </div>

        ${target > 0 ? `
        <div class="tab-section">
          <div class="tab-section-hd">
            <span>Objetivo del mes</span>
            <span class="ts-count">${targetPct.toFixed(0)}%</span>
          </div>
          <div class="target-block">
            <div class="target-row">
              <span>Cerrado</span>
              <b>${wonCount} ventas · USD ${fmt.compact(wonValue)}</b>
            </div>
            <div class="target-row">
              <span>Objetivo</span>
              <b>${target} ventas</b>
            </div>
            <div class="target-bar">
              <div class="target-bar-fill" style="width: ${targetPct}%"></div>
            </div>
            <div class="target-meta">
              ${target - wonCount > 0
                ? `Faltan ${target - wonCount} ventas para llegar al objetivo`
                : `🎯 Objetivo cumplido — ${wonCount - target} por encima`}
            </div>
          </div>
        </div>
        ` : ''}
      </div>
    </div>
  `;

  attachHandlers();
}

function kpi(label, value, sub, tone = '') {
  return `
    <div class="kpi-card ${tone}">
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-value">${value}</div>
      <div class="kpi-sub">${escapeHtml(sub)}</div>
    </div>
  `;
}

function renderContactAlerts(items, thresholds) {
  if (!items.length) {
    return `<div class="ts-empty">✓ Todas las oportunidades con contacto reciente</div>`;
  }
  // Agrupar por nivel
  const danger = items.filter(o => o.hours_since_contact >= thresholds.danger);
  const warn2 = items.filter(o => o.hours_since_contact >= thresholds.warn2 && o.hours_since_contact < thresholds.danger);
  const warn = items.filter(o => o.hours_since_contact >= thresholds.warn && o.hours_since_contact < thresholds.warn2);

  return `
    <div class="contact-alert-summary">
      <div class="cas-stat danger ${danger.length === 0 ? 'empty' : ''}">
        <div class="cas-num">${danger.length}</div>
        <div class="cas-lbl">+${thresholds.danger}h</div>
      </div>
      <div class="cas-stat warn2 ${warn2.length === 0 ? 'empty' : ''}">
        <div class="cas-num">${warn2.length}</div>
        <div class="cas-lbl">+${thresholds.warn2}h</div>
      </div>
      <div class="cas-stat warn ${warn.length === 0 ? 'empty' : ''}">
        <div class="cas-num">${warn.length}</div>
        <div class="cas-lbl">+${thresholds.warn}h</div>
      </div>
    </div>
    <div class="ts-list">
      ${items.slice(0, 6).map(o => contactAlertRow(o, thresholds)).join('')}
      ${items.length > 6 ? `<div class="ts-more">+${items.length - 6} más</div>` : ''}
    </div>
  `;
}

function contactAlertRow(o, thresholds) {
  const level = levelForHours(o.hours_since_contact, thresholds);
  const hours = Math.floor(o.hours_since_contact);
  const display = hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h`;
  return `
    <a class="ts-row clickable" data-route="/pipeline/${o.opp_code.toLowerCase()}">
      <div class="ts-row-mark ${level}"></div>
      <div class="ts-row-main">
        <div class="ts-row-title">${escapeHtml(o.contact?.full_name || '—')}</div>
        <div class="ts-row-sub">
          ${escapeHtml([o.unit?.brand, o.unit?.model].filter(Boolean).join(' ') || 'Sin unidad')}
          · ${escapeHtml(stageLabel(o.stage))}
        </div>
      </div>
      <div class="ts-row-meta">
        <div class="ts-row-time level-${level}">${display}</div>
        <div class="ts-row-code">${escapeHtml(o.opp_code)}</div>
      </div>
    </a>
  `;
}

function renderUrgentList(items) {
  if (!items.length) {
    return `<div class="ts-empty">Sin acciones urgentes 🎉</div>`;
  }
  return `<div class="ts-list">
    ${items.slice(0, 8).map(o => urgentRow(o)).join('')}
    ${items.length > 8 ? `<div class="ts-more">+${items.length - 8} más</div>` : ''}
  </div>`;
}

function urgentRow(o) {
  const overdue = o.next_action_due_at && new Date(o.next_action_due_at) < new Date();
  const time = o.next_action_due_at ? fmt.relative(o.next_action_due_at) : '—';
  return `
    <a class="ts-row clickable" data-route="/pipeline/${o.opp_code.toLowerCase()}">
      <div class="ts-row-mark ${overdue ? 'urgent' : 'warn'}"></div>
      <div class="ts-row-main">
        <div class="ts-row-title">${escapeHtml(o.contact?.full_name || '—')}</div>
        <div class="ts-row-sub">${escapeHtml(o.next_action_title || 'Sin acción definida')}</div>
      </div>
      <div class="ts-row-meta">
        <div class="ts-row-time ${overdue ? 'urgent' : ''}">${overdue ? '● ' : ''}${escapeHtml(time)}</div>
        <div class="ts-row-code">${escapeHtml(o.opp_code)}</div>
      </div>
    </a>
  `;
}

function renderNewLeadsList(items) {
  if (!items.length) return `<div class="ts-empty">Sin leads nuevos sin contactar</div>`;
  return `<div class="ts-list">
    ${items.slice(0, 6).map(o => `
      <a class="ts-row clickable" data-route="/pipeline/${o.opp_code.toLowerCase()}">
        <div class="ts-row-mark info"></div>
        <div class="ts-row-main">
          <div class="ts-row-title">${escapeHtml(o.contact?.full_name || '—')}</div>
          <div class="ts-row-sub">${escapeHtml([o.unit?.brand, o.unit?.model].filter(Boolean).join(' ') || 'Sin unidad')} · ${escapeHtml(originLabel(o.origin))}</div>
        </div>
        <div class="ts-row-meta">
          <div class="ts-row-time">${escapeHtml(fmt.relative(o.created_at))}</div>
          <div class="ts-row-code">${escapeHtml(o.opp_code)}</div>
        </div>
      </a>
    `).join('')}
  </div>`;
}

function renderStaleList(items) {
  if (!items.length) return `<div class="ts-empty">Todas las oportunidades con actividad reciente ✓</div>`;
  return `<div class="ts-list">
    ${items.slice(0, 6).map(o => `
      <a class="ts-row clickable" data-route="/pipeline/${o.opp_code.toLowerCase()}">
        <div class="ts-row-mark muted"></div>
        <div class="ts-row-main">
          <div class="ts-row-title">${escapeHtml(o.contact?.full_name || '—')}</div>
          <div class="ts-row-sub">${escapeHtml(stageLabel(o.stage))} · sin movimiento desde ${escapeHtml(fmt.relative(o.updated_at))}</div>
        </div>
        <div class="ts-row-meta">
          <div class="ts-row-code">${escapeHtml(o.opp_code)}</div>
        </div>
      </a>
    `).join('')}
  </div>`;
}

function renderAgenda(tasks) {
  if (!tasks.length) {
    return `<div class="ts-empty">Sin tareas programadas para hoy</div>`;
  }
  return `<div class="agenda-list">
    ${tasks.map(t => {
      const time = fmt.timeAR(t.due_at);
      const done = !!t.completed_at;
      const isNow = !done && Math.abs(new Date(t.due_at) - new Date()) < 30 * 60 * 1000;
      return `
        <div class="agenda-row ${done ? 'done' : ''} ${isNow ? 'now' : ''}">
          <div class="agenda-time">${escapeHtml(time)}</div>
          <div class="agenda-content">
            <div class="agenda-type">${isNow ? '● AHORA · ' : ''}${escapeHtml((t.task_type || 'TAREA').toUpperCase())}</div>
            <div class="agenda-title">${escapeHtml(t.title)}</div>
          </div>
          ${done ? '<div class="agenda-done">✓</div>' : ''}
        </div>
      `;
    }).join('')}
  </div>`;
}

// ============================================================
// HELPERS
// ============================================================
function isUrgent(o) {
  if (!o.next_action_due_at || o.next_action_done) return false;
  // Vencido O en las próximas 2 horas
  const due = new Date(o.next_action_due_at);
  return due < new Date(Date.now() + 2 * 3600 * 1000);
}

function isStale(o) {
  if (['ganada', 'perdida'].includes(o.stage)) return false;
  const lastUpdate = new Date(o.updated_at);
  const days = (Date.now() - lastUpdate) / 86400000;
  return days >= STALE_DAYS;
}

function stageLabel(id) {
  return STAGES.find(s => s.id === id)?.name || id;
}

function originLabel(o) {
  const m = {
    mercado_libre: 'ML', instagram: 'IG', meta_ads: 'Meta',
    whatsapp: 'WSP', web: 'Web', walk_in: 'Showroom',
    referido: 'Referido', google_ads: 'Google', otro: 'Otro',
  };
  return m[o] || o;
}

function greetingForNow() {
  const h = new Date().getHours();
  if (h < 6) return 'Buenas noches';
  if (h < 13) return 'Buen día';
  if (h < 20) return 'Buenas tardes';
  return 'Buenas noches';
}

// ============================================================
// HANDLERS
// ============================================================
function attachHandlers() {
  $('#btn-quick-pipeline').addEventListener('click', () => navigate('/pipeline'));
  $('#btn-quick-new').addEventListener('click', () => navigate('/pipeline/nueva'));
}

// ============================================================
// STYLES
// ============================================================
const styles = `
  /* HERO */
  .tab-hero { padding: 22px 20px 18px; border-bottom: 1px solid var(--cc-line); }
  @container app (min-width: 900px) { .tab-hero { padding: 28px 32px 22px; } }
  .tab-hero-row { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
  .tab-hero-greet { font-family: var(--cc-font-display); font-weight: 300; font-size: 30px; letter-spacing: -0.025em; line-height: 1; }
  .tab-hero-greet i { font-style: italic; font-weight: 500; }
  @container app (min-width: 700px) { .tab-hero-greet { font-size: 38px; } }
  .tab-hero-date { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.18em; color: var(--cc-muted); margin-top: 8px; }
  .tab-hero-quick { display: flex; gap: 8px; flex-wrap: wrap; }

  /* KPIs */
  .tab-kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--cc-line); border-bottom: 1px solid var(--cc-line); }
  @container app (min-width: 700px) { .tab-kpis { grid-template-columns: repeat(4, 1fr); } }
  .kpi-card { background: var(--cc-surface); padding: 16px 18px; }
  .kpi-card.danger { background: var(--cc-danger-soft); }
  .kpi-card.ok { background: var(--cc-ok-soft); }
  .kpi-label { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cc-muted); font-weight: 500; margin-bottom: 6px; }
  .kpi-value { font-family: var(--cc-font-display); font-weight: 400; font-size: 28px; letter-spacing: -0.02em; line-height: 1; }
  @container app (min-width: 900px) { .kpi-value { font-size: 32px; } }
  .kpi-sub { font-size: 11px; color: var(--cc-muted); margin-top: 4px; }
  .kpi-card.danger .kpi-sub { color: var(--cc-danger); font-weight: 500; }
  .kpi-card.ok .kpi-sub { color: var(--cc-ok); font-weight: 500; }

  /* GRID */
  .tab-grid { display: grid; grid-template-columns: 1fr; gap: 1px; background: var(--cc-line); }
  @container app (min-width: 1100px) { .tab-grid { grid-template-columns: 1.2fr 1fr; } }
  .tab-col { background: var(--cc-bg); padding: 18px 20px; display: flex; flex-direction: column; gap: 18px; }
  @container app (min-width: 900px) { .tab-col { padding: 22px 28px; } }

  /* SECTIONS */
  .tab-section { background: var(--cc-surface); border: 1px solid var(--cc-line); }
  .tab-section-hd { padding: 12px 16px; border-bottom: 1px solid var(--cc-line-soft); display: flex; justify-content: space-between; align-items: center; font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; font-weight: 600; color: var(--cc-ink); }
  .ts-count { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); background: var(--cc-bg-alt); padding: 2px 7px; border: 1px solid var(--cc-line); font-weight: 600; }
  .ts-empty { padding: 18px 16px; color: var(--cc-muted); font-style: italic; font-size: 12px; text-align: center; }
  .ts-list { display: flex; flex-direction: column; }
  .ts-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--cc-line-soft); text-decoration: none; color: inherit; }
  .ts-row:last-child { border-bottom: none; }
  .ts-row.clickable:hover { background: var(--cc-bg-alt); cursor: pointer; }
  .ts-row-mark { width: 6px; height: 36px; flex-shrink: 0; background: var(--cc-line); }
  .ts-row-mark.urgent { background: var(--cc-danger); }
  .ts-row-mark.danger { background: var(--cc-danger); }
  .ts-row-mark.warn2 { background: #FF8C42; }
  .ts-row-mark.warn { background: var(--cc-warn); }
  .ts-row-mark.info { background: var(--cc-info); }
  .ts-row-mark.muted { background: var(--cc-steel); }
  .ts-row-time.level-danger { color: var(--cc-danger); font-weight: 700; }
  .ts-row-time.level-warn2 { color: #FF8C42; font-weight: 600; }
  .ts-row-time.level-warn { color: var(--cc-warn); font-weight: 600; }

  /* Resumen 24/48/72hs */
  .contact-alert-summary {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1px;
    background: var(--cc-line);
    border-bottom: 1px solid var(--cc-line);
  }
  .cas-stat { background: var(--cc-surface); padding: 12px 8px; text-align: center; }
  .cas-stat.empty { opacity: 0.4; }
  .cas-stat.danger { background: var(--cc-danger-soft); }
  .cas-stat.warn2 { background: #fff0e5; }
  .cas-stat.warn { background: var(--cc-warn-soft); }
  .cas-stat.empty.danger, .cas-stat.empty.warn2, .cas-stat.empty.warn { background: var(--cc-bg-alt); }
  .cas-num { font-family: var(--cc-font-display); font-weight: 500; font-size: 22px; line-height: 1; }
  .cas-stat.danger .cas-num { color: var(--cc-danger); }
  .cas-stat.warn2 .cas-num { color: #FF8C42; }
  .cas-stat.warn .cas-num { color: var(--cc-warn); }
  .cas-stat.empty .cas-num { color: var(--cc-muted); }
  .cas-lbl { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--cc-muted); margin-top: 4px; font-weight: 600; }
  .ts-row-main { flex: 1; min-width: 0; }
  .ts-row-title { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ts-row-sub { font-size: 11px; color: var(--cc-muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ts-row-meta { text-align: right; flex-shrink: 0; }
  .ts-row-time { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); letter-spacing: 0.05em; }
  .ts-row-time.urgent { color: var(--cc-danger); font-weight: 600; }
  .ts-row-code { font-family: var(--cc-font-mono); font-size: 9px; color: var(--cc-steel); margin-top: 2px; letter-spacing: 0.08em; }
  .ts-more { padding: 10px 16px; text-align: center; font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); letter-spacing: 0.1em; text-transform: uppercase; }

  /* AGENDA */
  .agenda-list { display: flex; flex-direction: column; }
  .agenda-row { display: flex; gap: 14px; padding: 12px 16px; border-bottom: 1px solid var(--cc-line-soft); align-items: center; }
  .agenda-row:last-child { border-bottom: none; }
  .agenda-row.now { background: var(--cc-warn-soft); border-left: 3px solid var(--cc-warn); padding-left: 13px; }
  .agenda-row.done { opacity: 0.5; }
  .agenda-time { font-family: var(--cc-font-mono); font-size: 13px; color: var(--cc-ink); font-weight: 500; min-width: 50px; }
  .agenda-row.done .agenda-time { text-decoration: line-through; }
  .agenda-content { flex: 1; min-width: 0; }
  .agenda-type { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.18em; color: var(--cc-muted); font-weight: 600; margin-bottom: 2px; }
  .agenda-row.now .agenda-type { color: var(--cc-warn); }
  .agenda-title { font-size: 13px; font-weight: 500; }
  .agenda-done { font-size: 14px; color: var(--cc-ok); font-weight: 600; }

  /* PIPELINE MINI */
  .pipeline-mini { padding: 8px 0; }
  .pm-row { display: grid; grid-template-columns: auto 110px 1fr 40px 80px; gap: 10px; align-items: center; padding: 8px 16px; font-size: 12px; }
  .pm-num { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-champagne); letter-spacing: 0.1em; font-weight: 600; }
  .pm-name { color: var(--cc-ink); font-weight: 500; }
  .pm-bar { height: 4px; background: var(--cc-bg-alt); position: relative; overflow: hidden; }
  .pm-bar-fill { position: absolute; inset: 0; background: var(--cc-ink); transition: width 0.3s; }
  .pm-row[data-stage="ganada"] .pm-bar-fill { background: var(--cc-ok); }
  .pm-row[data-stage="reserva"] .pm-bar-fill { background: var(--cc-champagne); }
  .pm-count { font-family: var(--cc-font-mono); font-weight: 600; color: var(--cc-ink); text-align: right; }
  .pm-value { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); letter-spacing: 0.05em; text-align: right; }

  /* TARGET */
  .target-block { padding: 14px 16px; }
  .target-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12px; }
  .target-row span { color: var(--cc-muted); }
  .target-row b { font-weight: 500; }
  .target-bar { height: 8px; background: var(--cc-bg-alt); margin: 12px 0 10px; position: relative; overflow: hidden; }
  .target-bar-fill { position: absolute; inset: 0; background: linear-gradient(90deg, var(--cc-champagne), var(--cc-ok)); transition: width 0.4s; }
  .target-meta { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); letter-spacing: 0.05em; text-align: center; }
`;
