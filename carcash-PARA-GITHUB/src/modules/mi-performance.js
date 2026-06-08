// ============================================================
// CARCASH · MÓDULO MI PERFORMANCE
// Dashboard personal del vendedor con métricas, ranking y comparativa.
// Rutas:
//   /mi-performance               → mi propio performance
//   /mi-performance/:vendedorId   → performance de otro vendedor (solo admin)
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { state, isAdmin, isSupervisorOrAdmin, currentUserId } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles } from '../lib/dom.js';
import { navigate } from '../lib/router.js';

const STAGES = [
  { id: 'nuevo',       name: 'Nuevo',       num: '01' },
  { id: 'contactado',  name: 'Contactado',  num: '02' },
  { id: 'visita_test', name: 'Visita',      num: '03' },
  { id: 'presupuesto', name: 'Presupuesto', num: '04' },
  { id: 'negociacion', name: 'Negociación', num: '05' },
  { id: 'reserva',     name: 'Reserva',     num: '06' },
  { id: 'ganada',      name: 'Ganada',      num: '07' },
];

const ORIGIN_LABELS = {
  mercado_libre: 'Mercado Libre', instagram: 'Instagram', meta_ads: 'Meta Ads',
  whatsapp: 'WhatsApp', web: 'Web', walk_in: 'Showroom',
  referido: 'Referido', google_ads: 'Google Ads', otro: 'Otro',
};

const local = {
  range: 'this_month',
  vendedorId: null,
  vendedor: null,
  team: [],
  data: null,
};

// ============================================================
// MOUNT
// ============================================================
export async function mount(params = {}) {
  injectStyles('mi-performance-styles', styles);

  // Determinar de quién es el dashboard
  if (params.vendedorId) {
    if (!isSupervisorOrAdmin()) {
      toast('No tenés permiso para ver la performance de otros', null, 'warn');
      navigate('/mi-performance');
      return;
    }
    local.vendedorId = params.vendedorId;
  } else {
    local.vendedorId = currentUserId();
  }

  render();
  await loadAll();
  renderUI();
}

export default mount;

// ============================================================
// FETCH
// ============================================================
function getRangeBounds(range) {
  const now = new Date();
  let start, prevStart, prevEnd, end = now;
  if (range === 'this_month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    prevEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  } else if (range === 'last_month') {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    prevStart = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    prevEnd = new Date(now.getFullYear(), now.getMonth() - 1, 0, 23, 59, 59);
  } else if (range === 'last_3_months') {
    start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    prevStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    prevEnd = new Date(now.getFullYear(), now.getMonth() - 2, 0, 23, 59, 59);
  } else if (range === 'ytd') {
    start = new Date(now.getFullYear(), 0, 1);
    prevStart = new Date(now.getFullYear() - 1, 0, 1);
    prevEnd = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59);
  }
  return { start, end, prevStart, prevEnd };
}

async function loadAll() {
  const { start, end, prevStart, prevEnd } = getRangeBounds(local.range);
  const uid = local.vendedorId;

  // Vendedor info
  const { data: vendedor } = await supabase
    .from('users_profile')
    .select('id, full_name, email, phone, role, monthly_sales_target, avatar_initials, hired_at')
    .eq('id', uid)
    .maybeSingle();
  local.vendedor = vendedor;

  // Equipo (para ranking)
  const { data: team } = await supabase
    .from('users_profile')
    .select('id, full_name, avatar_initials, role, monthly_sales_target')
    .eq('active', true)
    .in('role', ['vendedor', 'gerente', 'dueno'])
    .is('deleted_at', null);
  local.team = team || [];

  // Mis ventas
  const { data: mySales } = await supabase
    .from('sales')
    .select(`
      id, sale_code, sale_price, gross_margin, margin_pct, status, created_at,
      buyer:contacts!buyer_contact_id(id, full_name),
      unit:units!unit_id(brand, model, year)
    `)
    .eq('seller_user_id', uid)
    .gte('created_at', start.toISOString())
    .lte('created_at', end.toISOString())
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  // Mis ventas mes anterior
  const { data: myPrevSales } = await supabase
    .from('sales')
    .select('sale_price, gross_margin, status')
    .eq('seller_user_id', uid)
    .gte('created_at', prevStart.toISOString())
    .lte('created_at', prevEnd.toISOString())
    .is('deleted_at', null);

  // Mis oportunidades en el período
  const { data: myOpps } = await supabase
    .from('opportunities')
    .select(`
      id, opp_code, stage, origin, expected_amount, ai_score,
      next_action_title, next_action_due_at, next_action_done,
      created_at, won_at, lost_at, loss_reason,
      contact:contacts!contact_id(full_name),
      unit:units!unit_of_interest_id(brand, model, year)
    `)
    .eq('assigned_to', uid)
    .gte('created_at', start.toISOString())
    .lte('created_at', end.toISOString())
    .is('deleted_at', null);

  // Mi pipeline activo (no filtrado por fecha)
  const { data: myActive } = await supabase
    .from('opportunities')
    .select(`
      id, opp_code, stage, expected_amount, ai_score,
      next_action_title, next_action_due_at, next_action_done,
      contact:contacts!contact_id(full_name),
      unit:units!unit_of_interest_id(brand, model, year)
    `)
    .eq('assigned_to', uid)
    .not('stage', 'in', '(ganada,perdida)')
    .is('deleted_at', null);

  // Performance del equipo entero (para ranking + comparativas)
  // Solo si soy admin O si veo mi propio performance (necesito comparar con equipo)
  let teamSales = [], teamOpps = [];
  if (isAdmin() || uid === currentUserId()) {
    const { data: ts } = await supabase
      .from('sales')
      .select('seller_user_id, sale_price, gross_margin, status')
      .gte('created_at', start.toISOString())
      .lte('created_at', end.toISOString())
      .is('deleted_at', null);
    teamSales = ts || [];

    const { data: to } = await supabase
      .from('opportunities')
      .select('assigned_to, stage, expected_amount')
      .gte('created_at', start.toISOString())
      .lte('created_at', end.toISOString())
      .is('deleted_at', null);
    teamOpps = to || [];
  }

  local.data = {
    mySales: mySales || [],
    myPrevSales: myPrevSales || [],
    myOpps: myOpps || [],
    myActive: myActive || [],
    teamSales,
    teamOpps,
    range: { start, end, prevStart, prevEnd },
  };
}

// ============================================================
// RENDER
// ============================================================
function render() {
  $('#view').innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">MÓDULO 05.5 · COMERCIAL</div>
          <div class="page-title" id="mp-title">Mi <i>performance</i></div>
          <div class="page-sub" id="mp-meta">Cargando…</div>
        </div>
        <div class="page-actions">
          ${isAdmin() ? '<select class="rep-range" id="mp-vendedor"></select>' : ''}
          <select class="rep-range" id="mp-range">
            <option value="this_month">Mes en curso</option>
            <option value="last_month">Mes anterior</option>
            <option value="last_3_months">Últimos 3 meses</option>
            <option value="ytd">Año en curso</option>
          </select>
          <button class="btn btn-ghost" id="btn-refresh">Actualizar</button>
        </div>
      </div>
    </div>
    <div class="mp-body" id="mp-body">
      <div class="empty">Cargando…</div>
    </div>
  `;

  $('#mp-range').value = local.range;
  $('#mp-range').addEventListener('change', async (e) => {
    local.range = e.target.value;
    await loadAll();
    renderUI();
  });
  $('#btn-refresh').addEventListener('click', () => mount({ vendedorId: local.vendedorId === currentUserId() ? null : local.vendedorId }));
}

function renderUI() {
  const d = local.data;
  if (!d || !local.vendedor) return;

  // Métricas mías
  const validSales = d.mySales.filter(s => s.status !== 'cancelada');
  const wonCount = validSales.length;
  const revenue = validSales.reduce((s, x) => s + (parseFloat(x.sale_price) || 0), 0);
  const margin = validSales.reduce((s, x) => s + (parseFloat(x.gross_margin) || 0), 0);
  const avgTicket = wonCount > 0 ? revenue / wonCount : 0;

  const closed = d.myOpps.filter(o => ['ganada', 'perdida'].includes(o.stage));
  const won = closed.filter(o => o.stage === 'ganada');
  const conversion = closed.length > 0 ? (won.length / closed.length) * 100 : 0;
  const newLeads = d.myOpps.length;

  const pipelineValue = d.myActive.reduce((s, o) => s + (parseFloat(o.expected_amount) || 0), 0);
  const pendingActions = d.myActive.filter(o => o.next_action_title && !o.next_action_done).length;
  const urgentActions = d.myActive.filter(o => isUrgent(o)).length;

  // Comparativa mes anterior
  const prevValid = d.myPrevSales.filter(s => s.status !== 'cancelada');
  const prevRevenue = prevValid.reduce((s, x) => s + (parseFloat(x.sale_price) || 0), 0);
  const prevCount = prevValid.length;

  // Target
  const target = local.vendedor.monthly_sales_target || 0;
  const targetPct = target > 0 ? Math.min(100, (wonCount / target) * 100) : 0;

  // Ranking del equipo y mi posición
  const ranking = computeRanking(d.teamSales, d.teamOpps, local.team);
  const myRank = ranking.findIndex(r => r.id === local.vendedorId) + 1;
  const teamAvgConv = computeTeamAvg(ranking, 'conversion');
  const teamAvgTicket = computeTeamAvg(ranking, 'avgTicket');

  // Origen de mis leads
  const byOrigin = computeByOrigin(d.myOpps);

  // Funnel personal
  const funnel = STAGES.map(s => ({
    ...s,
    count: d.myOpps.filter(o => isAtOrPastStage(o.stage, s.id)).length,
  }));

  $('#mp-title').innerHTML = local.vendedorId === currentUserId()
    ? 'Mi <i>performance</i>'
    : `Performance: <i>${escapeHtml(local.vendedor.full_name)}</i>`;

  $('#mp-meta').innerHTML = `
    Período <b>${escapeHtml(formatRange(d.range.start, d.range.end))}</b> ·
    ${isAdmin() ? `Mostrando: <b>${escapeHtml(local.vendedor.full_name)}</b> ·` : ''}
    Ranking actual: <b>${myRank > 0 ? `#${myRank} de ${ranking.length}` : '—'}</b>
  `;

  // Selector de vendedor (admin)
  if (isAdmin()) {
    const sel = $('#mp-vendedor');
    sel.innerHTML = local.team.map(m =>
      `<option value="${m.id}" ${m.id === local.vendedorId ? 'selected' : ''}>${escapeHtml(m.full_name)}</option>`
    ).join('');
    sel.onchange = (e) => {
      const newId = e.target.value;
      if (newId === currentUserId()) navigate('/mi-performance');
      else navigate(`/mi-performance/${newId}`);
    };
  }

  // ============================================================
  // ALERTAS Y SEMÁFORO
  // ============================================================
  // Calcular el "esperado a esta altura del mes" para comparar
  const today = new Date();
  const dayOfMonth = today.getDate();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const expectedByNow = target > 0 && local.range === 'this_month'
    ? Math.round((target * dayOfMonth) / daysInMonth)
    : 0;
  const behindTarget = target > 0 && local.range === 'this_month' && wonCount < expectedByNow;
  const targetGap = behindTarget ? expectedByNow - wonCount : 0;

  // Semáforo del target
  let targetTone = 'neutral';
  if (target > 0) {
    if (targetPct >= 100) targetTone = 'success';
    else if (targetPct >= 75) targetTone = 'good';
    else if (targetPct >= 50 || (local.range === 'this_month' && !behindTarget)) targetTone = 'warn';
    else targetTone = 'danger';
  }

  // Lista de alertas
  const alerts = [];
  if (target > 0 && local.range === 'this_month' && targetGap > 0) {
    alerts.push({
      level: targetGap >= target * 0.5 ? 'danger' : 'warn',
      icon: '🎯',
      title: `Vas atrasado · faltan ${targetGap} ventas para llegar al ritmo del mes`,
      desc: `A día ${dayOfMonth}/${daysInMonth} deberías llevar ${expectedByNow}, llevás ${wonCount}.`,
    });
  }
  if (urgentActions > 0) {
    alerts.push({
      level: urgentActions >= 3 ? 'danger' : 'warn',
      icon: '⚠',
      title: `${urgentActions} oportunidad${urgentActions > 1 ? 'es' : ''} con acción urgente`,
      desc: 'Próximas vencidas o por vencer en menos de 2 horas.',
      action: { label: 'Ver pipeline →', route: '/pipeline' },
    });
  }
  if (d.myActive.length === 0 && d.myOpps.length === 0 && local.range === 'this_month') {
    alerts.push({
      level: 'danger',
      icon: '📭',
      title: 'No tenés oportunidades activas',
      desc: 'Pedile leads al equipo o creá uno nuevo desde el pipeline.',
      action: { label: '+ Nueva oportunidad', route: '/pipeline/nueva' },
    });
  }
  if (teamAvgConv > 0 && conversion > 0 && conversion < teamAvgConv * 0.7) {
    alerts.push({
      level: 'warn',
      icon: '📉',
      title: `Tu conversión está abajo del equipo`,
      desc: `Vos cerrás ${conversion.toFixed(0)}% vs ${teamAvgConv.toFixed(0)}% promedio. Mirá los motivos de pérdida.`,
    });
  }
  if (targetPct >= 100) {
    alerts.push({
      level: 'success',
      icon: '🏆',
      title: '¡Objetivo del mes cumplido!',
      desc: `Llegaste a ${wonCount} ventas (objetivo ${target}). Todo lo que cierres por encima es bonus.`,
    });
  }

  $('#mp-body').innerHTML = `
    ${alerts.length ? `
      <div class="mp-alerts">
        ${alerts.map(alertCard).join('')}
      </div>
    ` : ''}

    <!-- HERO PERSONAL -->
    <div class="mp-hero tone-${targetTone}">
      <div class="mp-hero-avatar role-${local.vendedor.role}">${escapeHtml(local.vendedor.avatar_initials || fmt.initials(local.vendedor.full_name))}</div>
      <div class="mp-hero-info">
        <div class="mp-hero-name">${escapeHtml(local.vendedor.full_name)}</div>
        <div class="mp-hero-meta">
          <span>${escapeHtml(local.vendedor.role.toUpperCase())}</span>
          ${local.vendedor.hired_at ? `<span>· en el equipo desde ${escapeHtml(fmt.dateAR(local.vendedor.hired_at))}</span>` : ''}
        </div>
      </div>
      ${target > 0 ? `
        <div class="mp-hero-target">
          <div class="mp-target-bar-big">
            <div class="mp-target-bar-fill tone-${targetTone}" style="width: ${targetPct}%"></div>
            ${expectedByNow > 0 && local.range === 'this_month' ? `
              <div class="mp-target-marker" style="left: ${(expectedByNow / target) * 100}%" title="Esperado a hoy: ${expectedByNow}"></div>
            ` : ''}
          </div>
          <div class="mp-target-row">
            <div class="mp-target-pct tone-${targetTone}">${targetPct.toFixed(0)}%</div>
            <div class="mp-target-meta">
              <b>${wonCount}</b> de <b>${target}</b> ventas objetivo
              ${behindTarget ? `<span class="mp-target-gap">▼ ${targetGap} abajo del ritmo</span>` : ''}
              ${targetPct >= 100 ? `<span class="mp-target-bonus">🏆 cumplido</span>` : ''}
            </div>
          </div>
        </div>
      ` : ''}
    </div>

    <!-- KPIs -->
    <div class="mp-kpis">
      ${kpi('Ventas cerradas', wonCount, deltaLine(wonCount, prevCount), toneVentas(wonCount, expectedByNow))}
      ${kpi('Ingresos', 'USD ' + fmt.compact(revenue), deltaLine(revenue, prevRevenue, true), toneIngresos(revenue, prevRevenue))}
      ${kpi('Margen aportado', 'USD ' + fmt.compact(margin), revenue > 0 ? `${((margin/revenue)*100).toFixed(1)}% promedio` : '—', margin <= 0 && wonCount > 0 ? 'danger' : (margin > 0 ? 'good' : 'neutral'))}
      ${kpi('Ticket promedio', avgTicket > 0 ? 'USD ' + fmt.compact(avgTicket) : '—', teamAvgTicket > 0 ? `vs USD ${fmt.compact(teamAvgTicket)} equipo` : '—', avgTicket > 0 && teamAvgTicket > 0 && avgTicket >= teamAvgTicket ? 'good' : '')}
      ${kpi('Conversión', conversion.toFixed(0) + '%', `${won.length} ganadas / ${closed.length} cerradas · vs ${teamAvgConv.toFixed(0)}% equipo`, toneConversion(conversion, teamAvgConv))}
      ${kpi('Pipeline activo', 'USD ' + fmt.compact(pipelineValue), `${d.myActive.length} oportunidades${urgentActions > 0 ? ` · ${urgentActions} urgentes` : ''}`, tonePipeline(d.myActive.length, urgentActions))}
    </div>

    <div class="mp-grid">
      <!-- COL 1: RANKING + FUNNEL -->
      <div class="mp-col">
        <div class="mp-section">
          <div class="mp-section-hd">
            <span>Ranking del equipo</span>
            <span class="mp-section-meta">por ingresos · período actual</span>
          </div>
          ${renderRanking(ranking, local.vendedorId)}
        </div>

        <div class="mp-section">
          <div class="mp-section-hd"><span>Mi funnel</span></div>
          ${renderFunnel(funnel)}
        </div>
      </div>

      <!-- COL 2: ACCIONES + ORIGEN + CIERRES -->
      <div class="mp-col">
        <div class="mp-section">
          <div class="mp-section-hd">
            <span>Top 5 oportunidades activas</span>
            <span class="mp-section-meta">por valor</span>
          </div>
          ${renderTopOpps(d.myActive)}
        </div>

        <div class="mp-section">
          <div class="mp-section-hd"><span>Origen de mis leads</span></div>
          ${renderOrigins(byOrigin)}
        </div>

        <div class="mp-section">
          <div class="mp-section-hd">
            <span>Mis cierres del período</span>
            <span class="mp-section-meta">${validSales.length}</span>
          </div>
          ${renderClosedSales(validSales)}
        </div>
      </div>
    </div>
  `;

  $('#mp-body').addEventListener('click', (e) => {
    const link = e.target.closest('[data-route]');
    if (link) {
      e.preventDefault();
      navigate(link.dataset.route);
    }
  });
}

// ============================================================
// COMPONENTES
// ============================================================
function kpi(label, value, sub, tone = '') {
  return `
    <div class="mp-kpi tone-${tone || 'neutral'}">
      <div class="mp-kpi-label">${escapeHtml(label)}</div>
      <div class="mp-kpi-value">${escapeHtml(String(value))}</div>
      ${sub ? `<div class="mp-kpi-sub">${sub}</div>` : ''}
    </div>
  `;
}

function alertCard(a) {
  return `
    <div class="mp-alert tone-${a.level}">
      <div class="mp-alert-icon">${a.icon}</div>
      <div class="mp-alert-body">
        <div class="mp-alert-title">${escapeHtml(a.title)}</div>
        ${a.desc ? `<div class="mp-alert-desc">${escapeHtml(a.desc)}</div>` : ''}
      </div>
      ${a.action ? `<a class="mp-alert-action" data-route="${a.action.route}">${escapeHtml(a.action.label)}</a>` : ''}
    </div>
  `;
}

// Sistema de tonos por KPI: neutral / good / warn / danger / success
function toneVentas(wonCount, expectedByNow) {
  if (wonCount === 0 && expectedByNow > 0) return 'danger';
  if (expectedByNow > 0 && wonCount < expectedByNow * 0.5) return 'danger';
  if (expectedByNow > 0 && wonCount < expectedByNow) return 'warn';
  if (expectedByNow > 0 && wonCount >= expectedByNow) return 'good';
  return 'neutral';
}

function toneIngresos(current, previous) {
  if (current === 0 && previous > 0) return 'danger';
  if (previous > 0 && current < previous * 0.7) return 'warn';
  if (current > previous && previous > 0) return 'good';
  return 'neutral';
}

function toneConversion(myConv, teamConv) {
  if (myConv === 0) return 'neutral';
  if (teamConv === 0) return 'neutral';
  if (myConv >= teamConv * 1.1) return 'success';
  if (myConv >= teamConv) return 'good';
  if (myConv >= teamConv * 0.7) return 'warn';
  return 'danger';
}

function tonePipeline(activeCount, urgentCount) {
  if (activeCount === 0) return 'danger';
  if (urgentCount >= 3) return 'danger';
  if (urgentCount > 0) return 'warn';
  return 'good';
}

function deltaLine(current, previous, isMoney = false) {
  if (previous === 0 && current === 0) return '<span class="delta">— sin cambios vs período anterior</span>';
  if (previous === 0) return `<span class="delta up">▲ período nuevo</span>`;
  const diff = current - previous;
  const pct = (diff / previous) * 100;
  const arrow = diff > 0 ? '▲' : (diff < 0 ? '▼' : '—');
  const cls = diff > 0 ? 'up' : (diff < 0 ? 'down' : '');
  return `<span class="delta ${cls}">${arrow} ${pct.toFixed(0)}% vs período anterior</span>`;
}

function renderRanking(ranking, highlightId) {
  if (!ranking.length) {
    return `<div class="mp-empty">Sin datos del equipo en el período</div>`;
  }
  const max = Math.max(...ranking.map(r => r.revenue), 1);
  return `
    <div class="mp-ranking">
      ${ranking.slice(0, 8).map((r, i) => `
        <div class="mp-rk-row ${r.id === highlightId ? 'highlight' : ''}">
          <div class="mp-rk-pos">${i + 1}</div>
          <div class="mp-rk-name">${escapeHtml(r.name)}${r.id === highlightId ? ' <span class="mp-rk-you">tú</span>' : ''}</div>
          <div class="mp-rk-bar"><div class="mp-rk-bar-fill" style="width: ${(r.revenue / max) * 100}%"></div></div>
          <div class="mp-rk-stats">
            <b>${r.wonCount}</b><span> ventas · </span>
            <b>USD ${fmt.compact(r.revenue)}</b>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderFunnel(funnel) {
  const max = Math.max(...funnel.map(c => c.count), 1);
  return `
    <div class="mp-funnel">
      ${funnel.map((c, i) => {
        const pct = (c.count / max) * 100;
        const conversion = i > 0 && funnel[i - 1].count > 0 ? (c.count / funnel[i - 1].count) * 100 : null;
        return `
          <div class="mp-fn-row">
            <div class="mp-fn-stage">
              <span class="mp-fn-num">${c.num}</span>
              <span class="mp-fn-name">${escapeHtml(c.name)}</span>
            </div>
            <div class="mp-fn-bar"><div class="mp-fn-bar-fill" style="width: ${pct}%"></div></div>
            <div class="mp-fn-count">${c.count}</div>
            ${conversion !== null ? `<div class="mp-fn-conv">${conversion.toFixed(0)}%</div>` : '<div class="mp-fn-conv">—</div>'}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderTopOpps(opps) {
  if (!opps.length) {
    return `<div class="mp-empty">Sin oportunidades activas en el pipeline</div>`;
  }
  const top = [...opps].sort((a, b) => (b.expected_amount || 0) - (a.expected_amount || 0)).slice(0, 5);
  return `
    <div class="mp-top-opps">
      ${top.map(o => {
        const urgent = isUrgent(o);
        return `
          <a class="mp-opp" data-route="/pipeline/${o.opp_code.toLowerCase()}">
            <div class="mp-opp-mark ${urgent ? 'urgent' : ''}"></div>
            <div class="mp-opp-info">
              <div class="mp-opp-name">${escapeHtml(o.contact?.full_name || '—')}</div>
              <div class="mp-opp-sub">${escapeHtml([o.unit?.brand, o.unit?.model].filter(Boolean).join(' ') || 'Sin unidad')} · ${escapeHtml(stageLabel(o.stage))}</div>
            </div>
            <div class="mp-opp-stats">
              <div class="mp-opp-amount">USD ${fmt.compact(o.expected_amount || 0)}</div>
              ${o.ai_score != null ? `<div class="mp-opp-score">${o.ai_score}</div>` : ''}
            </div>
          </a>
        `;
      }).join('')}
    </div>
  `;
}

function renderOrigins(byOrigin) {
  if (!byOrigin.length) {
    return `<div class="mp-empty">Sin leads en el período</div>`;
  }
  const max = Math.max(...byOrigin.map(o => o.total), 1);
  return `
    <div class="mp-origins">
      ${byOrigin.map(o => `
        <div class="mp-or-row">
          <div class="mp-or-name">${escapeHtml(ORIGIN_LABELS[o.origin] || o.origin)}</div>
          <div class="mp-or-bar"><div class="mp-or-bar-fill" style="width: ${(o.total / max) * 100}%"></div></div>
          <div class="mp-or-stats">
            <b>${o.total}</b><span class="mp-or-conv">${o.won > 0 ? ` (${o.won} 🏆)` : ''}</span>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderClosedSales(sales) {
  if (!sales.length) {
    return `<div class="mp-empty">No cerraste ventas en el período todavía</div>`;
  }
  return `
    <div class="mp-sales">
      ${sales.slice(0, 5).map(s => `
        <a class="mp-sale" data-route="/ventas/${s.sale_code.toLowerCase()}">
          <div class="mp-sale-info">
            <div class="mp-sale-name">${escapeHtml(s.buyer?.full_name || '—')}</div>
            <div class="mp-sale-sub">${escapeHtml([s.unit?.brand, s.unit?.model, s.unit?.year ? "'" + String(s.unit.year).slice(2) : null].filter(Boolean).join(' '))}</div>
          </div>
          <div class="mp-sale-stats">
            <div class="mp-sale-amount">USD ${fmt.compact(s.sale_price)}</div>
            <div class="mp-sale-meta">${escapeHtml(s.sale_code)} · ${escapeHtml(fmt.dateAR(s.created_at))}</div>
          </div>
        </a>
      `).join('')}
      ${sales.length > 5 ? `<div class="mp-more">+${sales.length - 5} más</div>` : ''}
    </div>
  `;
}

// ============================================================
// CÁLCULOS
// ============================================================
function computeRanking(teamSales, teamOpps, team) {
  const map = new Map();
  team.forEach(t => {
    map.set(t.id, {
      id: t.id, name: t.full_name, role: t.role,
      wonCount: 0, revenue: 0, margin: 0,
      newLeads: 0, lost: 0, conversion: 0, avgTicket: 0,
    });
  });
  for (const s of teamSales || []) {
    if (s.status === 'cancelada') continue;
    const m = map.get(s.seller_user_id);
    if (!m) continue;
    m.wonCount++;
    m.revenue += parseFloat(s.sale_price) || 0;
    m.margin += parseFloat(s.gross_margin) || 0;
  }
  for (const o of teamOpps || []) {
    const m = map.get(o.assigned_to);
    if (!m) continue;
    m.newLeads++;
    if (o.stage === 'perdida') m.lost++;
  }
  for (const m of map.values()) {
    const closedTotal = m.wonCount + m.lost;
    m.conversion = closedTotal > 0 ? (m.wonCount / closedTotal) * 100 : 0;
    m.avgTicket = m.wonCount > 0 ? m.revenue / m.wonCount : 0;
  }
  return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue || b.wonCount - a.wonCount);
}

function computeTeamAvg(ranking, key) {
  if (!ranking.length) return 0;
  const valid = ranking.filter(r => r[key] > 0);
  if (!valid.length) return 0;
  return valid.reduce((s, r) => s + r[key], 0) / valid.length;
}

function computeByOrigin(opps) {
  const m = new Map();
  for (const o of opps) {
    const cur = m.get(o.origin) || { origin: o.origin, total: 0, won: 0 };
    cur.total++;
    if (o.stage === 'ganada') cur.won++;
    m.set(o.origin, cur);
  }
  return Array.from(m.values()).sort((a, b) => b.total - a.total);
}

function isAtOrPastStage(currentStage, targetStage) {
  const order = ['nuevo', 'contactado', 'visita_test', 'presupuesto', 'negociacion', 'reserva', 'ganada'];
  if (currentStage === 'perdida') return false;
  return order.indexOf(currentStage) >= order.indexOf(targetStage);
}

function isUrgent(o) {
  if (!o.next_action_due_at || o.next_action_done) return false;
  return new Date(o.next_action_due_at) < new Date(Date.now() + 2 * 3600 * 1000);
}

function stageLabel(id) {
  return STAGES.find(s => s.id === id)?.name || id;
}

function formatRange(start, end) {
  const f = (d) => d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
  return `${f(start)} — ${f(end)}`;
}

// ============================================================
// STYLES
// ============================================================
const styles = `
  .page-hd { padding: 22px 20px 16px; border-bottom: 1px solid var(--cc-line); }
  @container app (min-width: 900px) { .page-hd { padding: 28px 32px 20px; } }
  .page-hd-top { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; flex-wrap: wrap; margin-bottom: 0; }
  .page-num { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.22em; color: var(--cc-champagne); font-weight: 600; margin-bottom: 4px; }
  .page-title { font-family: var(--cc-font-display); font-weight: 300; font-size: 30px; letter-spacing: -0.025em; line-height: 1; }
  @container app (min-width: 700px) { .page-title { font-size: 36px; } }
  .page-title i { font-style: italic; font-weight: 500; }
  .page-sub { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.12em; color: var(--cc-muted); margin-top: 6px; }
  .page-sub b { color: var(--cc-ink); font-weight: 600; }
  .page-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .rep-range { padding: 7px 12px; border: 1px solid var(--cc-line); background: var(--cc-surface); font-family: inherit; font-size: 11px; }

  .mp-body { padding: 0; }

  /* ALERTAS ARRIBA */
  .mp-alerts { display: flex; flex-direction: column; gap: 1px; background: var(--cc-line); border-bottom: 1px solid var(--cc-line); }
  .mp-alert { display: flex; align-items: center; gap: 14px; padding: 12px 20px; background: var(--cc-surface); }
  @container app (min-width: 900px) { .mp-alert { padding: 14px 32px; } }
  .mp-alert.tone-danger { background: var(--cc-danger-soft); border-left: 4px solid var(--cc-danger); }
  .mp-alert.tone-warn { background: var(--cc-warn-soft); border-left: 4px solid var(--cc-warn); }
  .mp-alert.tone-success { background: var(--cc-ok-soft); border-left: 4px solid var(--cc-ok); }
  .mp-alert-icon { font-size: 24px; flex-shrink: 0; line-height: 1; }
  .mp-alert-body { flex: 1; min-width: 0; }
  .mp-alert-title { font-weight: 600; font-size: 13px; line-height: 1.3; }
  .mp-alert.tone-danger .mp-alert-title { color: var(--cc-danger); }
  .mp-alert.tone-warn .mp-alert-title { color: var(--cc-warn); }
  .mp-alert.tone-success .mp-alert-title { color: var(--cc-ok); }
  .mp-alert-desc { font-size: 11px; color: var(--cc-muted); margin-top: 2px; line-height: 1.4; }
  .mp-alert-action {
    font-family: var(--cc-font-mono); font-size: 10px;
    letter-spacing: 0.18em; text-transform: uppercase; font-weight: 600;
    padding: 6px 12px; border: 1px solid currentColor; cursor: pointer;
    text-decoration: none; flex-shrink: 0;
  }
  .mp-alert.tone-danger .mp-alert-action { color: var(--cc-danger); }
  .mp-alert.tone-warn .mp-alert-action { color: var(--cc-warn); }
  .mp-alert-action:hover { background: currentColor; color: var(--cc-bg) !important; }

  /* HERO PERSONAL CON BARRA DE PROGRESO */
  .mp-hero {
    display: flex; align-items: center; gap: 16px;
    background: var(--cc-surface);
    padding: 18px 20px;
    border-bottom: 1px solid var(--cc-line);
    position: relative;
  }
  .mp-hero::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px;
    background: var(--cc-line);
  }
  .mp-hero.tone-success::before { background: linear-gradient(180deg, var(--cc-ok), var(--cc-champagne)); }
  .mp-hero.tone-good::before { background: var(--cc-ok); }
  .mp-hero.tone-warn::before { background: var(--cc-warn); }
  .mp-hero.tone-danger::before { background: var(--cc-danger); }
  @container app (min-width: 900px) { .mp-hero { padding: 22px 32px; } }
  .mp-hero-avatar {
    width: 56px; height: 56px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, var(--cc-graphite), var(--cc-steel));
    color: var(--cc-bg);
    font-size: 18px; font-weight: 600;
    flex-shrink: 0;
  }
  .mp-hero-avatar.role-dueno { background: linear-gradient(135deg, var(--cc-champagne), #8a6f45); color: var(--cc-ink); }
  .mp-hero-avatar.role-gerente { background: linear-gradient(135deg, var(--cc-info), #1f3a5e); }
  .mp-hero-info { flex: 1; min-width: 0; }
  .mp-hero-name { font-family: var(--cc-font-display); font-weight: 400; font-size: 22px; line-height: 1.1; }
  .mp-hero-meta { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.1em; color: var(--cc-muted); margin-top: 4px; }

  .mp-hero-target { flex-shrink: 0; min-width: 280px; }
  @container app (max-width: 700px) { .mp-hero-target { width: 100%; } }
  .mp-target-bar-big {
    height: 14px; background: var(--cc-bg-alt); position: relative; overflow: hidden;
    margin-bottom: 8px; border: 1px solid var(--cc-line);
  }
  .mp-target-bar-fill {
    position: absolute; inset: 0; transition: width 0.6s ease;
  }
  .mp-target-bar-fill.tone-danger { background: linear-gradient(90deg, var(--cc-danger), #ff6b6b); }
  .mp-target-bar-fill.tone-warn { background: linear-gradient(90deg, var(--cc-warn), #ffbb55); }
  .mp-target-bar-fill.tone-good { background: linear-gradient(90deg, var(--cc-info), var(--cc-ok)); }
  .mp-target-bar-fill.tone-success { background: linear-gradient(90deg, var(--cc-ok), var(--cc-champagne)); }
  .mp-target-bar-fill.tone-neutral { background: var(--cc-steel); }
  .mp-target-marker {
    position: absolute; top: -2px; bottom: -2px; width: 2px;
    background: var(--cc-ink); z-index: 2;
  }
  .mp-target-marker::before {
    content: 'HOY'; position: absolute; top: -14px; left: 50%; transform: translateX(-50%);
    font-family: var(--cc-font-mono); font-size: 8px; font-weight: 700; color: var(--cc-ink);
    letter-spacing: 0.1em; white-space: nowrap;
  }
  .mp-target-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .mp-target-pct {
    font-family: var(--cc-font-display); font-weight: 500; font-size: 32px; line-height: 1;
    color: var(--cc-muted);
  }
  .mp-target-pct.tone-danger { color: var(--cc-danger); }
  .mp-target-pct.tone-warn { color: var(--cc-warn); }
  .mp-target-pct.tone-good { color: var(--cc-ok); }
  .mp-target-pct.tone-success { color: var(--cc-champagne); }
  .mp-target-meta {
    font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted);
    letter-spacing: 0.05em; text-align: right;
  }
  .mp-target-meta b { color: var(--cc-ink); font-weight: 700; }
  .mp-target-gap { display: block; color: var(--cc-danger); font-weight: 600; margin-top: 2px; }
  .mp-target-bonus { display: block; color: var(--cc-ok); font-weight: 600; margin-top: 2px; }

  /* KPIs */
  .mp-kpis {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1px;
    background: var(--cc-line);
    border-bottom: 1px solid var(--cc-line);
  }
  @container app (min-width: 700px) { .mp-kpis { grid-template-columns: repeat(3, 1fr); } }
  @container app (min-width: 1100px) { .mp-kpis { grid-template-columns: repeat(6, 1fr); } }
  .mp-kpi { background: var(--cc-surface); padding: 14px 16px; position: relative; }
  .mp-kpi::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: transparent; }
  .mp-kpi.tone-danger { background: var(--cc-danger-soft); }
  .mp-kpi.tone-danger::before { background: var(--cc-danger); }
  .mp-kpi.tone-warn { background: var(--cc-warn-soft); }
  .mp-kpi.tone-warn::before { background: var(--cc-warn); }
  .mp-kpi.tone-good { background: var(--cc-ok-soft); }
  .mp-kpi.tone-good::before { background: var(--cc-ok); }
  .mp-kpi.tone-success { background: linear-gradient(135deg, var(--cc-ok-soft), #f5e9d0); }
  .mp-kpi.tone-success::before { background: var(--cc-champagne); }
  .mp-kpi.ok { background: var(--cc-ok-soft); }
  .mp-kpi.warn { background: var(--cc-warn-soft); }
  .mp-kpi.tone-danger .mp-kpi-value { color: var(--cc-danger); }
  .mp-kpi.tone-good .mp-kpi-value { color: var(--cc-ok); }
  .mp-kpi.tone-success .mp-kpi-value { color: var(--cc-champagne); }
  .mp-kpi-label { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cc-muted); font-weight: 500; margin-bottom: 6px; }
  .mp-kpi-value { font-family: var(--cc-font-display); font-weight: 400; font-size: 24px; letter-spacing: -0.02em; line-height: 1; }
  @container app (min-width: 900px) { .mp-kpi-value { font-size: 28px; } }
  .mp-kpi-sub { font-size: 11px; color: var(--cc-muted); margin-top: 4px; line-height: 1.4; }
  .delta { color: var(--cc-muted); font-family: var(--cc-font-mono); font-size: 10px; }
  .delta.up { color: var(--cc-ok); font-weight: 600; }
  .delta.down { color: var(--cc-danger); font-weight: 600; }

  /* GRID */
  .mp-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1px;
    background: var(--cc-line);
  }
  @container app (min-width: 1100px) { .mp-grid { grid-template-columns: 1fr 1fr; } }
  .mp-col { background: var(--cc-bg); padding: 18px 20px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
  @container app (min-width: 900px) { .mp-col { padding: 22px 28px; } }

  .mp-section { background: var(--cc-surface); border: 1px solid var(--cc-line); }
  .mp-section-hd { padding: 12px 14px; border-bottom: 1px solid var(--cc-line-soft); display: flex; justify-content: space-between; align-items: baseline; font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; font-weight: 600; }
  .mp-section-meta { color: var(--cc-muted); font-weight: 400; letter-spacing: 0.1em; }
  .mp-empty { padding: 18px 14px; text-align: center; color: var(--cc-muted); font-style: italic; font-size: 12px; }

  /* RANKING */
  .mp-ranking { padding: 4px 0; }
  .mp-rk-row { display: grid; grid-template-columns: 24px 1fr 1.5fr auto; gap: 10px; align-items: center; padding: 8px 14px; border-bottom: 1px solid var(--cc-line-soft); font-size: 12px; }
  .mp-rk-row:last-child { border-bottom: none; }
  .mp-rk-row.highlight { background: var(--cc-bg-alt); }
  .mp-rk-row.highlight .mp-rk-pos { color: var(--cc-champagne); font-weight: 700; }
  .mp-rk-pos { font-family: var(--cc-font-mono); font-weight: 600; text-align: center; color: var(--cc-muted); }
  .mp-rk-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mp-rk-you { font-family: var(--cc-font-mono); font-size: 9px; padding: 1px 5px; background: var(--cc-champagne); color: var(--cc-ink); letter-spacing: 0.15em; text-transform: uppercase; font-weight: 600; }
  .mp-rk-bar { height: 5px; background: var(--cc-bg-alt); position: relative; overflow: hidden; }
  .mp-rk-bar-fill { position: absolute; inset: 0; background: linear-gradient(90deg, var(--cc-champagne), var(--cc-ok)); }
  .mp-rk-stats { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); white-space: nowrap; }
  .mp-rk-stats b { color: var(--cc-ink); font-weight: 600; }

  /* FUNNEL */
  .mp-funnel { padding: 14px; }
  .mp-fn-row { display: grid; grid-template-columns: 130px 1fr 40px 50px; gap: 10px; align-items: center; padding: 4px 0; font-size: 12px; }
  .mp-fn-stage { display: flex; gap: 8px; align-items: center; }
  .mp-fn-num { font-family: var(--cc-font-mono); font-size: 9px; color: var(--cc-champagne); font-weight: 600; letter-spacing: 0.1em; }
  .mp-fn-name { font-weight: 500; }
  .mp-fn-bar { height: 12px; background: var(--cc-bg-alt); position: relative; }
  .mp-fn-bar-fill { position: absolute; inset: 0; background: var(--cc-ink); }
  .mp-fn-count { font-family: var(--cc-font-mono); font-weight: 600; text-align: right; }
  .mp-fn-conv { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); text-align: right; }

  /* TOP OPPS */
  .mp-top-opps { display: flex; flex-direction: column; }
  .mp-opp { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--cc-line-soft); text-decoration: none; color: inherit; cursor: pointer; }
  .mp-opp:last-child { border-bottom: none; }
  .mp-opp:hover { background: var(--cc-bg-alt); }
  .mp-opp-mark { width: 4px; height: 32px; background: var(--cc-line); flex-shrink: 0; }
  .mp-opp-mark.urgent { background: var(--cc-danger); }
  .mp-opp-info { flex: 1; min-width: 0; }
  .mp-opp-name { font-weight: 500; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mp-opp-sub { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); margin-top: 2px; letter-spacing: 0.05em; }
  .mp-opp-stats { text-align: right; flex-shrink: 0; display: flex; align-items: center; gap: 8px; }
  .mp-opp-amount { font-family: var(--cc-font-mono); font-weight: 600; font-size: 12px; }
  .mp-opp-score { font-family: var(--cc-font-mono); font-weight: 600; font-size: 11px; padding: 2px 6px; background: var(--cc-bg-alt); border: 1px solid var(--cc-line); }

  /* ORIGINS */
  .mp-origins { padding: 4px 0; }
  .mp-or-row { display: grid; grid-template-columns: 110px 1fr auto; gap: 10px; align-items: center; padding: 8px 14px; border-bottom: 1px solid var(--cc-line-soft); font-size: 12px; }
  .mp-or-row:last-child { border-bottom: none; }
  .mp-or-name { font-weight: 500; }
  .mp-or-bar { height: 6px; background: var(--cc-bg-alt); position: relative; }
  .mp-or-bar-fill { position: absolute; inset: 0; background: var(--cc-info); }
  .mp-or-stats { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); }
  .mp-or-stats b { color: var(--cc-ink); font-size: 12px; }
  .mp-or-conv { color: var(--cc-ok); }

  /* CIERRES */
  .mp-sales { display: flex; flex-direction: column; }
  .mp-sale { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--cc-line-soft); text-decoration: none; color: inherit; cursor: pointer; gap: 10px; }
  .mp-sale:last-child { border-bottom: none; }
  .mp-sale:hover { background: var(--cc-bg-alt); }
  .mp-sale-info { flex: 1; min-width: 0; }
  .mp-sale-name { font-weight: 500; font-size: 13px; }
  .mp-sale-sub { font-family: var(--cc-font-display); font-style: italic; font-size: 11px; color: var(--cc-muted); margin-top: 2px; }
  .mp-sale-stats { text-align: right; flex-shrink: 0; }
  .mp-sale-amount { font-family: var(--cc-font-mono); font-weight: 600; font-size: 13px; }
  .mp-sale-meta { font-family: var(--cc-font-mono); font-size: 9px; color: var(--cc-muted); margin-top: 2px; letter-spacing: 0.05em; }
  .mp-more { padding: 10px 14px; text-align: center; font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); letter-spacing: 0.1em; text-transform: uppercase; }
`;
