// ============================================================
// CARCASH · ESTADÍSTICAS COMPARATIVAS DEL EQUIPO
// Solo dueño / gerente / supervisor.
// Ruta: /estadisticas
//
// Vista profunda del rendimiento del equipo:
//   - Tabla comparativa con todas las métricas
//   - Tendencia mensual por vendedor (últimos 6 meses)
//   - Distribución por origen × vendedor (heatmap)
//   - Top y bottom performers
//   - Drill-down → click en un vendedor abre /mi-performance/:id
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { state, isAdmin, isSupervisorOrAdmin, isOwner, currentUserId } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles } from '../lib/dom.js';
import { navigate } from '../lib/router.js';

const ORIGIN_LABELS = {
  mercado_libre: 'ML', instagram: 'IG', meta_ads: 'Meta',
  whatsapp: 'WSP', web: 'Web', walk_in: 'Showroom',
  referido: 'Ref.', google_ads: 'Google', otro: 'Otro',
};

const local = {
  range: 'this_month',
  data: null,
  sortBy: 'revenue',
  sortDir: 'desc',
};

// ============================================================
// MOUNT
// ============================================================
export async function mount() {
  injectStyles('estadisticas-styles', styles);
  if (!isSupervisorOrAdmin()) {
    $('#view').innerHTML = `
      <div class="placeholder">
        <div class="placeholder-content">
          <div class="placeholder-num">×</div>
          <div class="placeholder-title">Acceso <i>restringido</i></div>
          <div class="placeholder-desc">Solo dueño / gerente / supervisor.</div>
          <div class="placeholder-status">NO AUTORIZADO</div>
        </div>
      </div>
    `;
    return;
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
  let start, end = now;
  if (range === 'this_month') start = new Date(now.getFullYear(), now.getMonth(), 1);
  else if (range === 'last_month') {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  }
  else if (range === 'last_3_months') start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  else if (range === 'last_6_months') start = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  else if (range === 'ytd') start = new Date(now.getFullYear(), 0, 1);
  else if (range === 'all_time') start = new Date(2000, 0, 1);
  return { start, end };
}

async function loadAll() {
  const { start, end } = getRangeBounds(local.range);

  // Equipo activo
  const { data: team } = await supabase
    .from('users_profile')
    .select('id, full_name, avatar_initials, role, monthly_sales_target, hired_at')
    .eq('active', true)
    .in('role', ['vendedor', 'gerente', 'dueno'])
    .is('deleted_at', null)
    .order('role', { ascending: true })
    .order('full_name');

  // Ventas en el período
  const { data: sales } = await supabase
    .from('sales')
    .select('seller_user_id, sale_price, gross_margin, status, created_at')
    .gte('created_at', start.toISOString())
    .lte('created_at', end.toISOString())
    .is('deleted_at', null);

  // Oportunidades en el período
  const { data: opps } = await supabase
    .from('opportunities')
    .select('assigned_to, stage, origin, expected_amount, created_at, won_at, first_contact_at, first_response_at')
    .gte('created_at', start.toISOString())
    .lte('created_at', end.toISOString())
    .is('deleted_at', null);

  // Pipeline activo (no filtrado por fecha)
  const { data: activePipeline } = await supabase
    .from('opportunities')
    .select('assigned_to, expected_amount, stage')
    .not('stage', 'in', '(ganada,perdida)')
    .is('deleted_at', null);

  // Snapshots de los últimos 6 meses para tendencia
  const monthsBack = local.range === 'all_time' ? 18 : 6;
  const { data: snapshots } = await supabase
    .from('monthly_snapshots')
    .select('user_id, period_year, period_month, sales_count, total_revenue, total_margin, target_pct, monthly_target')
    .order('period_year', { ascending: false })
    .order('period_month', { ascending: false })
    .limit(monthsBack * 30);

  local.data = {
    team: team || [],
    sales: sales || [],
    opps: opps || [],
    activePipeline: activePipeline || [],
    snapshots: snapshots || [],
    rangeBounds: { start, end },
  };
}

// ============================================================
// RENDER SHELL
// ============================================================
function render() {
  $('#view').innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">MÓDULO 13.5 · DIRECCIÓN</div>
          <div class="page-title">Estadísticas <i>del equipo</i></div>
          <div class="page-sub" id="est-meta">Cargando…</div>
        </div>
        <div class="page-actions">
          <select class="rep-range" id="est-range">
            <option value="this_month">Mes en curso</option>
            <option value="last_month">Mes anterior</option>
            <option value="last_3_months">Últimos 3 meses</option>
            <option value="last_6_months">Últimos 6 meses</option>
            <option value="ytd">Año en curso</option>
            ${isOwner() ? '<option value="all_time">Histórico completo</option>' : ''}
          </select>
          <button class="btn btn-ghost" id="btn-refresh">Actualizar</button>
        </div>
      </div>
    </div>
    <div class="est-body" id="est-body">
      <div class="empty">Cargando estadísticas…</div>
    </div>
  `;
  $('#est-range').value = local.range;
  $('#est-range').addEventListener('change', async (e) => {
    local.range = e.target.value;
    await loadAll();
    renderUI();
  });
  $('#btn-refresh').addEventListener('click', () => mount());
}

// ============================================================
// RENDER UI
// ============================================================
function renderUI() {
  const d = local.data;
  if (!d) return;

  // Calcular métricas por vendedor
  const stats = computeSellerStats(d);
  const sortedStats = sortStats(stats, local.sortBy, local.sortDir);

  // Totales del equipo
  const teamTotals = {
    sales: stats.reduce((s, x) => s + x.salesCount, 0),
    revenue: stats.reduce((s, x) => s + x.revenue, 0),
    margin: stats.reduce((s, x) => s + x.margin, 0),
    pipeline: stats.reduce((s, x) => s + x.pipelineValue, 0),
    leads: stats.reduce((s, x) => s + x.newLeads, 0),
    won: stats.reduce((s, x) => s + x.wonOpps, 0),
    lost: stats.reduce((s, x) => s + x.lostOpps, 0),
  };
  const teamConv = (teamTotals.won + teamTotals.lost) > 0
    ? (teamTotals.won / (teamTotals.won + teamTotals.lost)) * 100 : 0;
  const teamAvgTicket = teamTotals.sales > 0 ? teamTotals.revenue / teamTotals.sales : 0;

  // Top y bottom performers
  const topRevenue = [...stats].sort((a, b) => b.revenue - a.revenue).slice(0, 1)[0];
  const topConversion = [...stats].filter(s => s.totalClosed > 0).sort((a, b) => b.conversion - a.conversion).slice(0, 1)[0];
  const topAvgTicket = [...stats].filter(s => s.salesCount > 0).sort((a, b) => b.avgTicket - a.avgTicket).slice(0, 1)[0];
  const bottomRevenue = [...stats].filter(s => s.salesCount === 0 && s.newLeads > 0).slice(0, 1)[0];

  // Heatmap origen × vendedor
  const originMatrix = computeOriginMatrix(d, stats);

  $('#est-meta').innerHTML = `
    Período <b>${escapeHtml(formatRange(d.rangeBounds))}</b> ·
    <b>${stats.length}</b> vendedores · <b>${teamTotals.sales}</b> ventas · ingresos <b>USD ${fmt.compact(teamTotals.revenue)}</b>
  `;

  $('#est-body').innerHTML = `
    <!-- HIGHLIGHTS -->
    <div class="est-highlights">
      ${highlight('🥇 Top ingresos', topRevenue?.name, topRevenue ? `USD ${fmt.compact(topRevenue.revenue)} · ${topRevenue.salesCount} ventas` : '—', 'success')}
      ${highlight('🎯 Mejor conversión', topConversion?.name, topConversion ? `${topConversion.conversion.toFixed(0)}% · ${topConversion.wonOpps} de ${topConversion.totalClosed}` : '—', 'good')}
      ${highlight('💵 Mejor ticket promedio', topAvgTicket?.name, topAvgTicket ? `USD ${fmt.compact(topAvgTicket.avgTicket)}` : '—', 'good')}
      ${bottomRevenue ? highlight('⚠ Necesita atención', bottomRevenue.name, `${bottomRevenue.newLeads} leads · 0 cierres`, 'warn') : ''}
    </div>

    <!-- TABLA COMPARATIVA -->
    <div class="est-section">
      <div class="est-section-hd">
        <span>Comparativa de vendedores</span>
        <span class="est-section-meta">click en una columna para ordenar · click en un vendedor para ver detalle</span>
      </div>
      ${renderComparativeTable(sortedStats, teamTotals, teamConv, teamAvgTicket)}
    </div>

    <!-- TENDENCIA MENSUAL -->
    <div class="est-section">
      <div class="est-section-hd">
        <span>Tendencia mensual por vendedor</span>
        <span class="est-section-meta">snapshots últimos 6 meses · ventas cerradas</span>
      </div>
      ${renderTrendChart(d.snapshots, d.team)}
    </div>

    <!-- HEATMAP ORIGEN × VENDEDOR -->
    <div class="est-section">
      <div class="est-section-hd">
        <span>Distribución de leads por origen y vendedor</span>
        <span class="est-section-meta">cuántos leads recibió cada vendedor de cada canal</span>
      </div>
      ${renderOriginHeatmap(originMatrix)}
    </div>

    <!-- VELOCIDAD / TIMING -->
    <div class="est-section">
      <div class="est-section-hd">
        <span>Velocidad de respuesta y cierre</span>
        <span class="est-section-meta">tiempo promedio desde lead hasta primer contacto y hasta cierre</span>
      </div>
      ${renderVelocityTable(stats)}
    </div>
  `;

  attachHandlers();
}

// ============================================================
// CÁLCULOS
// ============================================================
function computeSellerStats(d) {
  const map = new Map();
  d.team.forEach(t => map.set(t.id, {
    id: t.id, name: t.full_name, role: t.role, target: t.monthly_sales_target,
    avatar: t.avatar_initials || fmt.initials(t.full_name),
    salesCount: 0, revenue: 0, margin: 0,
    newLeads: 0, wonOpps: 0, lostOpps: 0,
    pipelineValue: 0, pipelineCount: 0,
    avgResponseHours: null, avgCloseDays: null,
    responseTimes: [], closeTimes: [],
    totalClosed: 0,
    avgTicket: 0, marginPct: 0, conversion: 0,
  }));

  for (const s of d.sales) {
    if (s.status === 'cancelada') continue;
    const m = map.get(s.seller_user_id);
    if (!m) continue;
    m.salesCount++;
    m.revenue += parseFloat(s.sale_price) || 0;
    m.margin += parseFloat(s.gross_margin) || 0;
  }

  for (const o of d.opps) {
    const m = map.get(o.assigned_to);
    if (!m) continue;
    m.newLeads++;
    if (o.stage === 'ganada') m.wonOpps++;
    if (o.stage === 'perdida') m.lostOpps++;

    if (o.first_contact_at && o.first_response_at) {
      const diffMs = new Date(o.first_response_at) - new Date(o.first_contact_at);
      m.responseTimes.push(diffMs / (1000 * 60 * 60));
    }
    if (o.created_at && o.won_at) {
      const diffMs = new Date(o.won_at) - new Date(o.created_at);
      m.closeTimes.push(diffMs / (1000 * 60 * 60 * 24));
    }
  }

  for (const o of d.activePipeline) {
    const m = map.get(o.assigned_to);
    if (!m) continue;
    m.pipelineCount++;
    m.pipelineValue += parseFloat(o.expected_amount) || 0;
  }

  // Calcular derivados
  for (const m of map.values()) {
    m.avgTicket = m.salesCount > 0 ? m.revenue / m.salesCount : 0;
    m.marginPct = m.revenue > 0 ? (m.margin / m.revenue) * 100 : 0;
    m.totalClosed = m.wonOpps + m.lostOpps;
    m.conversion = m.totalClosed > 0 ? (m.wonOpps / m.totalClosed) * 100 : 0;
    m.targetPct = m.target > 0 ? (m.salesCount / m.target) * 100 : 0;
    m.avgResponseHours = m.responseTimes.length > 0
      ? m.responseTimes.reduce((a, b) => a + b, 0) / m.responseTimes.length : null;
    m.avgCloseDays = m.closeTimes.length > 0
      ? m.closeTimes.reduce((a, b) => a + b, 0) / m.closeTimes.length : null;
  }

  return Array.from(map.values());
}

function sortStats(stats, by, dir) {
  const sorted = [...stats].sort((a, b) => {
    const av = a[by] ?? 0;
    const bv = b[by] ?? 0;
    return dir === 'desc' ? bv - av : av - bv;
  });
  return sorted;
}

function computeOriginMatrix(d, stats) {
  const origins = Array.from(new Set(d.opps.map(o => o.origin))).sort();
  const matrix = stats.map(s => {
    const row = { name: s.name, id: s.id, byOrigin: {} };
    origins.forEach(o => row.byOrigin[o] = 0);
    return row;
  });
  for (const o of d.opps) {
    const row = matrix.find(r => r.id === o.assigned_to);
    if (!row) continue;
    row.byOrigin[o.origin] = (row.byOrigin[o.origin] || 0) + 1;
  }
  return { origins, matrix };
}

// ============================================================
// COMPONENTES
// ============================================================
function highlight(label, name, sub, tone) {
  return `
    <div class="est-hl tone-${tone}">
      <div class="est-hl-label">${label}</div>
      <div class="est-hl-name">${escapeHtml(name || '—')}</div>
      <div class="est-hl-sub">${escapeHtml(sub)}</div>
    </div>
  `;
}

function renderComparativeTable(stats, totals, teamConv, teamAvgTicket) {
  if (!stats.length) {
    return `<div class="est-empty">Sin vendedores con métricas en el período</div>`;
  }
  const cols = [
    { key: 'name', label: 'Vendedor', align: 'left' },
    { key: 'salesCount', label: 'Ventas', align: 'right', format: v => v },
    { key: 'targetPct', label: 'Objetivo', align: 'right', format: (v, r) => r.target ? `${v.toFixed(0)}% (${r.salesCount}/${r.target})` : '—' },
    { key: 'revenue', label: 'Ingresos', align: 'right', format: v => 'USD ' + fmt.compact(v) },
    isOwner() ? { key: 'margin', label: 'Margen', align: 'right', format: v => 'USD ' + fmt.compact(v) } : null,
    { key: 'avgTicket', label: 'Ticket prom.', align: 'right', format: v => v > 0 ? 'USD ' + fmt.compact(v) : '—' },
    { key: 'newLeads', label: 'Leads', align: 'right' },
    { key: 'conversion', label: 'Conversión', align: 'right', format: (v, r) => r.totalClosed > 0 ? `${v.toFixed(0)}%` : '—' },
    { key: 'pipelineValue', label: 'Pipeline', align: 'right', format: v => v > 0 ? 'USD ' + fmt.compact(v) : '—' },
  ].filter(Boolean);

  return `
    <div class="est-table">
      <table>
        <thead>
          <tr>
            ${cols.map(c => `<th class="${c.align}" data-sort="${c.key}">
              ${escapeHtml(c.label)}
              ${local.sortBy === c.key ? (local.sortDir === 'desc' ? ' ▼' : ' ▲') : ''}
            </th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${stats.map(s => `
            <tr class="est-tr-link" data-vendedor="${s.id}">
              <td>
                <div class="est-name-cell">
                  <div class="est-avatar role-${s.role}">${escapeHtml(s.avatar)}</div>
                  <div>
                    <div class="est-name">${escapeHtml(s.name)}</div>
                    <div class="est-name-role">${escapeHtml(s.role.toUpperCase())}</div>
                  </div>
                </div>
              </td>
              ${cols.slice(1).map(c => {
                const raw = s[c.key];
                const display = c.format ? c.format(raw, s) : raw;
                let tone = '';
                if (c.key === 'targetPct' && s.target > 0) {
                  tone = raw >= 100 ? 'tone-success' : raw >= 75 ? 'tone-good' : raw >= 50 ? 'tone-warn' : 'tone-danger';
                }
                if (c.key === 'conversion' && s.totalClosed > 0) {
                  tone = raw >= teamConv ? 'tone-good' : raw >= teamConv * 0.7 ? 'tone-warn' : 'tone-danger';
                }
                return `<td class="${c.align} ${tone}">${escapeHtml(String(display))}</td>`;
              }).join('')}
            </tr>
          `).join('')}
          <tr class="est-tr-totals">
            <td><b>Total equipo</b></td>
            <td class="right"><b>${totals.sales}</b></td>
            <td class="right">—</td>
            <td class="right"><b>USD ${fmt.compact(totals.revenue)}</b></td>
            ${isOwner() ? `<td class="right"><b>USD ${fmt.compact(totals.margin)}</b></td>` : ''}
            <td class="right"><b>USD ${fmt.compact(teamAvgTicket)}</b></td>
            <td class="right"><b>${totals.leads}</b></td>
            <td class="right"><b>${teamConv.toFixed(0)}%</b></td>
            <td class="right"><b>USD ${fmt.compact(totals.pipeline)}</b></td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

function renderTrendChart(snapshots, team) {
  if (!snapshots?.length) {
    return `<div class="est-empty">Sin snapshots todavía. Se generan automáticamente el día 1 de cada mes.</div>`;
  }
  // Agrupar por mes
  const byMonth = new Map();
  for (const s of snapshots) {
    const key = `${s.period_year}-${String(s.period_month).padStart(2, '0')}`;
    if (!byMonth.has(key)) byMonth.set(key, { year: s.period_year, month: s.period_month, key, byUser: {} });
    byMonth.get(key).byUser[s.user_id] = s;
  }
  const months = Array.from(byMonth.values()).sort((a, b) => (a.year - b.year) || (a.month - b.month));
  const recent = months.slice(-6);
  if (!recent.length) return `<div class="est-empty">Sin datos en últimos 6 meses</div>`;

  const userIds = Array.from(new Set(snapshots.map(s => s.user_id)));
  const teamLookup = Object.fromEntries(team.map(t => [t.id, t]));

  const maxSales = Math.max(...recent.flatMap(m => Object.values(m.byUser).map(s => s.sales_count || 0)), 1);

  return `
    <div class="trend-chart">
      <div class="trend-grid">
        ${recent.map(m => {
          const monthLabel = new Date(m.year, m.month - 1, 1).toLocaleDateString('es-AR', { month: 'short' }).replace('.', '');
          return `
            <div class="trend-col">
              <div class="trend-month">${escapeHtml(monthLabel)}</div>
              <div class="trend-bars">
                ${userIds.map(uid => {
                  const s = m.byUser[uid];
                  const t = teamLookup[uid];
                  if (!s || !t) return '';
                  const h = ((s.sales_count || 0) / maxSales) * 100;
                  const tone = (s.target_pct || 0) >= 100 ? 'success' : (s.target_pct || 0) >= 75 ? 'good' : (s.target_pct || 0) >= 50 ? 'warn' : 'danger';
                  return `<div class="trend-bar tone-${tone}" style="height: ${h}%" title="${escapeHtml(t.full_name)} · ${s.sales_count} ventas (${(s.target_pct || 0).toFixed(0)}% obj)"></div>`;
                }).join('')}
              </div>
            </div>
          `;
        }).join('')}
      </div>
      <div class="trend-legend">
        ${userIds.map(uid => {
          const t = teamLookup[uid];
          if (!t) return '';
          return `<span class="trend-leg"><span class="leg-dot role-${t.role}"></span>${escapeHtml(t.full_name)}</span>`;
        }).join('')}
      </div>
    </div>
  `;
}

function renderOriginHeatmap({ origins, matrix }) {
  if (!matrix.length || !origins.length) {
    return `<div class="est-empty">Sin leads en el período</div>`;
  }
  const max = Math.max(...matrix.flatMap(r => Object.values(r.byOrigin)), 1);
  return `
    <div class="heatmap-wrap">
      <table class="heatmap">
        <thead>
          <tr>
            <th class="left">Vendedor</th>
            ${origins.map(o => `<th class="center">${escapeHtml(ORIGIN_LABELS[o] || o)}</th>`).join('')}
            <th class="right">Total</th>
          </tr>
        </thead>
        <tbody>
          ${matrix.map(r => {
            const total = origins.reduce((s, o) => s + (r.byOrigin[o] || 0), 0);
            return `
              <tr>
                <td class="left"><b>${escapeHtml(r.name)}</b></td>
                ${origins.map(o => {
                  const v = r.byOrigin[o] || 0;
                  const intensity = v > 0 ? Math.min(1, v / max) : 0;
                  return `<td class="center heat-cell" style="background: rgba(184, 153, 104, ${intensity * 0.7});">${v || ''}</td>`;
                }).join('')}
                <td class="right"><b>${total}</b></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderVelocityTable(stats) {
  const valid = stats.filter(s => s.avgResponseHours !== null || s.avgCloseDays !== null);
  if (!valid.length) {
    return `<div class="est-empty">Sin datos de velocidad en el período</div>`;
  }
  const allResp = stats.map(s => s.avgResponseHours).filter(v => v !== null);
  const teamAvgResp = allResp.length ? allResp.reduce((a, b) => a + b, 0) / allResp.length : null;
  const allClose = stats.map(s => s.avgCloseDays).filter(v => v !== null);
  const teamAvgClose = allClose.length ? allClose.reduce((a, b) => a + b, 0) / allClose.length : null;

  return `
    <div class="velocity-grid">
      <div class="velocity-card">
        <div class="vel-card-hd">⏱ Tiempo de primera respuesta</div>
        <div class="vel-card-meta">desde que entra el lead hasta el primer mensaje del vendedor</div>
        <div class="vel-list">
          ${stats.filter(s => s.avgResponseHours !== null)
            .sort((a, b) => a.avgResponseHours - b.avgResponseHours)
            .map(s => {
              const tone = teamAvgResp && s.avgResponseHours <= teamAvgResp * 0.7 ? 'good'
                : teamAvgResp && s.avgResponseHours <= teamAvgResp ? 'neutral'
                : teamAvgResp && s.avgResponseHours > teamAvgResp * 1.5 ? 'danger' : 'warn';
              const display = s.avgResponseHours < 1
                ? `${Math.round(s.avgResponseHours * 60)} min`
                : `${s.avgResponseHours.toFixed(1)} hs`;
              return `
                <div class="vel-row">
                  <div class="vel-name">${escapeHtml(s.name)}</div>
                  <div class="vel-value tone-${tone}">${display}</div>
                </div>
              `;
            }).join('')}
        </div>
        ${teamAvgResp !== null ? `<div class="vel-team-avg">Promedio equipo: <b>${teamAvgResp < 1 ? Math.round(teamAvgResp * 60) + ' min' : teamAvgResp.toFixed(1) + ' hs'}</b></div>` : ''}
      </div>

      <div class="velocity-card">
        <div class="vel-card-hd">📅 Tiempo de cierre</div>
        <div class="vel-card-meta">desde que se crea la oportunidad hasta que se gana</div>
        <div class="vel-list">
          ${stats.filter(s => s.avgCloseDays !== null)
            .sort((a, b) => a.avgCloseDays - b.avgCloseDays)
            .map(s => {
              const tone = teamAvgClose && s.avgCloseDays <= teamAvgClose * 0.7 ? 'good'
                : teamAvgClose && s.avgCloseDays <= teamAvgClose ? 'neutral'
                : teamAvgClose && s.avgCloseDays > teamAvgClose * 1.5 ? 'danger' : 'warn';
              return `
                <div class="vel-row">
                  <div class="vel-name">${escapeHtml(s.name)}</div>
                  <div class="vel-value tone-${tone}">${s.avgCloseDays.toFixed(1)} días</div>
                </div>
              `;
            }).join('')}
        </div>
        ${teamAvgClose !== null ? `<div class="vel-team-avg">Promedio equipo: <b>${teamAvgClose.toFixed(1)} días</b></div>` : ''}
      </div>
    </div>
  `;
}

// ============================================================
// HANDLERS
// ============================================================
function attachHandlers() {
  // Click en filas → drill-down
  $$('.est-tr-link').forEach(tr => {
    tr.addEventListener('click', () => {
      navigate(`/mi-performance/${tr.dataset.vendedor}`);
    });
  });
  // Click en headers → sort
  $$('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (local.sortBy === key) {
        local.sortDir = local.sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        local.sortBy = key;
        local.sortDir = 'desc';
      }
      renderUI();
    });
  });
}

// ============================================================
// HELPERS
// ============================================================
function formatRange({ start, end }) {
  const f = (d) => d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
  return `${f(start)} — ${f(end)}`;
}

// ============================================================
// STYLES
// ============================================================
const styles = `
  .page-hd { padding: 22px 20px 16px; border-bottom: 1px solid var(--cc-line); }
  @container app (min-width: 900px) { .page-hd { padding: 28px 32px 20px; } }
  .page-hd-top { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; flex-wrap: wrap; }
  .page-num { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.22em; color: var(--cc-champagne); font-weight: 600; margin-bottom: 4px; }
  .page-title { font-family: var(--cc-font-display); font-weight: 300; font-size: 30px; letter-spacing: -0.025em; line-height: 1; }
  @container app (min-width: 700px) { .page-title { font-size: 36px; } }
  .page-title i { font-style: italic; font-weight: 500; }
  .page-sub { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.12em; color: var(--cc-muted); margin-top: 6px; }
  .page-sub b { color: var(--cc-ink); font-weight: 600; }
  .page-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .rep-range { padding: 7px 12px; border: 1px solid var(--cc-line); background: var(--cc-surface); font-family: inherit; font-size: 11px; }

  .est-body { padding: 0; }

  /* HIGHLIGHTS */
  .est-highlights {
    display: grid; grid-template-columns: 1fr; gap: 1px;
    background: var(--cc-line); border-bottom: 1px solid var(--cc-line);
  }
  @container app (min-width: 700px) { .est-highlights { grid-template-columns: repeat(2, 1fr); } }
  @container app (min-width: 1200px) { .est-highlights { grid-template-columns: repeat(4, 1fr); } }
  .est-hl { background: var(--cc-surface); padding: 16px 18px; }
  .est-hl.tone-success { background: linear-gradient(135deg, var(--cc-ok-soft), #f5e9d0); border-left: 4px solid var(--cc-champagne); }
  .est-hl.tone-good { background: var(--cc-ok-soft); border-left: 4px solid var(--cc-ok); }
  .est-hl.tone-warn { background: var(--cc-warn-soft); border-left: 4px solid var(--cc-warn); }
  .est-hl-label { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--cc-muted); margin-bottom: 4px; }
  .est-hl-name { font-family: var(--cc-font-display); font-weight: 500; font-size: 18px; line-height: 1.2; margin-bottom: 4px; }
  .est-hl-sub { font-size: 12px; color: var(--cc-ink-soft); }

  /* SECTIONS */
  .est-section { background: var(--cc-bg); padding: 20px; border-bottom: 1px solid var(--cc-line); }
  @container app (min-width: 900px) { .est-section { padding: 24px 32px; } }
  .est-section-hd { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; font-weight: 600; flex-wrap: wrap; gap: 8px; }
  .est-section-meta { color: var(--cc-muted); font-weight: 400; letter-spacing: 0.1em; text-transform: none; font-size: 10px; }
  .est-empty { padding: 24px; text-align: center; color: var(--cc-muted); font-style: italic; font-size: 12px; background: var(--cc-surface); border: 1px solid var(--cc-line); }

  /* TABLA COMPARATIVA */
  .est-table { background: var(--cc-surface); border: 1px solid var(--cc-line); overflow-x: auto; }
  .est-table table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .est-table th {
    padding: 10px 12px; text-align: left;
    font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.15em;
    text-transform: uppercase; font-weight: 600; color: var(--cc-muted);
    background: var(--cc-bg-alt); border-bottom: 1px solid var(--cc-line);
    cursor: pointer; user-select: none;
  }
  .est-table th:hover { color: var(--cc-ink); }
  .est-table th.right, .est-table td.right { text-align: right; }
  .est-table th.center, .est-table td.center { text-align: center; }
  .est-table td { padding: 10px 12px; border-bottom: 1px solid var(--cc-line-soft); }
  .est-tr-link { cursor: pointer; }
  .est-tr-link:hover { background: var(--cc-bg-alt); }
  .est-tr-totals { background: var(--cc-bg-alt); font-family: var(--cc-font-mono); }
  .est-tr-totals td { border-bottom: none; padding-top: 14px; }
  .est-name-cell { display: flex; gap: 10px; align-items: center; }
  .est-avatar { width: 30px; height: 30px; border-radius: 50%; background: linear-gradient(135deg, var(--cc-graphite), var(--cc-steel)); color: var(--cc-bg); display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; flex-shrink: 0; }
  .est-avatar.role-dueno { background: linear-gradient(135deg, var(--cc-champagne), #8a6f45); color: var(--cc-ink); }
  .est-avatar.role-gerente { background: linear-gradient(135deg, var(--cc-info), #1f3a5e); }
  .est-avatar.role-supervisor { background: linear-gradient(135deg, var(--cc-warn), #6b4d1c); }
  .est-name { font-weight: 500; }
  .est-name-role { font-family: var(--cc-font-mono); font-size: 9px; color: var(--cc-muted); letter-spacing: 0.1em; margin-top: 2px; }
  td.tone-success { color: var(--cc-champagne); font-weight: 600; }
  td.tone-good { color: var(--cc-ok); font-weight: 600; }
  td.tone-warn { color: var(--cc-warn); font-weight: 600; }
  td.tone-danger { color: var(--cc-danger); font-weight: 600; }

  /* TENDENCIA */
  .trend-chart { background: var(--cc-surface); border: 1px solid var(--cc-line); padding: 18px; }
  .trend-grid { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 16px; align-items: end; min-height: 200px; }
  .trend-col { display: flex; flex-direction: column; align-items: center; min-height: 200px; gap: 8px; }
  .trend-bars { display: flex; gap: 3px; align-items: flex-end; flex: 1; width: 100%; max-width: 80px; min-height: 160px; }
  .trend-bar { flex: 1; background: var(--cc-bg-alt); transition: height 0.4s ease; border-bottom: 1px solid var(--cc-line); min-height: 4px; }
  .trend-bar.tone-success { background: linear-gradient(0deg, var(--cc-champagne), var(--cc-ok)); }
  .trend-bar.tone-good { background: var(--cc-ok); }
  .trend-bar.tone-warn { background: var(--cc-warn); }
  .trend-bar.tone-danger { background: var(--cc-danger); }
  .trend-month { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--cc-muted); font-weight: 600; }
  .trend-legend { display: flex; flex-wrap: wrap; gap: 14px; padding-top: 14px; border-top: 1px solid var(--cc-line-soft); margin-top: 14px; }
  .trend-leg { display: flex; align-items: center; gap: 6px; font-size: 11px; }
  .leg-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--cc-steel); flex-shrink: 0; }
  .leg-dot.role-dueno { background: var(--cc-champagne); }
  .leg-dot.role-gerente { background: var(--cc-info); }
  .leg-dot.role-supervisor { background: var(--cc-warn); }

  /* HEATMAP */
  .heatmap-wrap { background: var(--cc-surface); border: 1px solid var(--cc-line); overflow-x: auto; }
  .heatmap { width: 100%; border-collapse: collapse; font-size: 12px; }
  .heatmap th { padding: 8px 12px; font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.15em; text-transform: uppercase; font-weight: 600; color: var(--cc-muted); background: var(--cc-bg-alt); border-bottom: 1px solid var(--cc-line); }
  .heatmap th.left, .heatmap td.left { text-align: left; }
  .heatmap th.center, .heatmap td.center { text-align: center; }
  .heatmap th.right, .heatmap td.right { text-align: right; }
  .heatmap td { padding: 10px 12px; border-bottom: 1px solid var(--cc-line-soft); font-family: var(--cc-font-mono); }
  .heat-cell { font-weight: 600; transition: background 0.2s; }

  /* VELOCITY */
  .velocity-grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
  @container app (min-width: 900px) { .velocity-grid { grid-template-columns: 1fr 1fr; } }
  .velocity-card { background: var(--cc-surface); border: 1px solid var(--cc-line); padding: 16px; }
  .vel-card-hd { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
  .vel-card-meta { font-size: 11px; color: var(--cc-muted); margin-bottom: 14px; }
  .vel-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
  .vel-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--cc-line-soft); font-size: 12px; }
  .vel-row:last-child { border-bottom: none; }
  .vel-name { font-weight: 500; }
  .vel-value { font-family: var(--cc-font-mono); font-weight: 600; }
  .vel-value.tone-good { color: var(--cc-ok); }
  .vel-value.tone-warn { color: var(--cc-warn); }
  .vel-value.tone-danger { color: var(--cc-danger); }
  .vel-team-avg { padding-top: 10px; border-top: 1px solid var(--cc-line-soft); font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.1em; color: var(--cc-muted); }
  .vel-team-avg b { color: var(--cc-ink); }
`;
