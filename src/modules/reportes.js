// ============================================================
// CARCASH · MÓDULO DASHBOARD EJECUTIVO
// Solo dueño / gerente.
// Ruta: /reportes
// Charts SVG nativos (sin libs externas).
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { state, isAdmin, isSupervisorOrAdmin, isOwner } from '../lib/state.js';
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
  mercado_libre: 'Mercado Libre',
  instagram: 'Instagram',
  meta_ads: 'Meta Ads',
  whatsapp: 'WhatsApp',
  web: 'Web propia',
  walk_in: 'Showroom',
  referido: 'Referido',
  google_ads: 'Google Ads',
  otro: 'Otro',
};

const local = {
  data: null,
  range: 'this_month',  // this_month | last_month | last_3_months | ytd
};

// ============================================================
// MOUNT
// ============================================================
export async function mount() {
  injectStyles('reportes-styles', styles);
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
  renderUI();
}

export default mount;

// ============================================================
// FETCH
// ============================================================
function getRangeBounds(range) {
  const now = new Date();
  let start, prevStart, prevEnd;
  if (range === 'this_month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    prevEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  } else if (range === 'last_month') {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    prevStart = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    prevEnd = new Date(now.getFullYear(), now.getMonth() - 1, 0, 23, 59, 59);
    return { start, end, prevStart, prevEnd };
  } else if (range === 'last_3_months') {
    start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    prevStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    prevEnd = new Date(now.getFullYear(), now.getMonth() - 2, 0, 23, 59, 59);
  } else if (range === 'last_6_months') {
    start = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    prevStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    prevEnd = new Date(now.getFullYear(), now.getMonth() - 5, 0, 23, 59, 59);
  } else if (range === 'ytd') {
    start = new Date(now.getFullYear(), 0, 1);
    prevStart = new Date(now.getFullYear() - 1, 0, 1);
    prevEnd = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59);
  } else if (range === 'all_time') {
    start = new Date(2000, 0, 1);
    prevStart = new Date(2000, 0, 1);
    prevEnd = new Date(2000, 0, 1);
  }
  return { start, end: now, prevStart, prevEnd };
}

async function loadAll() {
  const { start, end, prevStart, prevEnd } = getRangeBounds(local.range);

  // Ventas en el período
  const { data: sales } = await supabase
    .from('sales')
    .select(`
      id, sale_code, sale_price, gross_margin, margin_pct, status, created_at,
      seller:users_profile!seller_user_id(id, full_name, avatar_initials),
      unit:units!unit_id(brand, model, year, modality),
      buyer:contacts!buyer_contact_id(full_name)
    `)
    .gte('created_at', start.toISOString())
    .lte('created_at', end.toISOString())
    .is('deleted_at', null);

  // Ventas del período anterior (para comparativa)
  const { data: prevSales } = await supabase
    .from('sales')
    .select('sale_price, gross_margin, status, created_at')
    .gte('created_at', prevStart.toISOString())
    .lte('created_at', prevEnd.toISOString())
    .is('deleted_at', null);

  // Oportunidades del período (para conversión + funnel + origen)
  const { data: opps } = await supabase
    .from('opportunities')
    .select(`
      id, stage, origin, expected_amount, ai_score,
      created_at, won_at, lost_at, loss_reason,
      assigned_to,
      assignee:users_profile!assigned_to(id, full_name, avatar_initials)
    `)
    .gte('created_at', start.toISOString())
    .lte('created_at', end.toISOString())
    .is('deleted_at', null);

  // Pipeline activo (no filtrado por fecha)
  const { data: activePipeline } = await supabase
    .from('opportunities')
    .select('stage, expected_amount, assigned_to')
    .not('stage', 'in', '(ganada,perdida)')
    .is('deleted_at', null);

  // Stock por antigüedad
  const { data: stock } = await supabase
    .from('units')
    .select('id, unit_code, brand, model, year, public_price, status, entered_at')
    .eq('status', 'disponible')
    .is('deleted_at', null);

  // Equipo
  const { data: team } = await supabase
    .from('users_profile')
    .select('id, full_name, avatar_initials, role, monthly_sales_target')
    .eq('active', true)
    .in('role', ['vendedor', 'gerente', 'dueno'])
    .is('deleted_at', null);

  // Settings (objetivos)
  const { data: targetSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'targets')
    .maybeSingle();

  // Snapshots históricos: últimos 6 meses (o todos si all_time + dueño)
  const monthsBack = local.range === 'all_time' ? 24 : 6;
  const { data: snapshots } = await supabase
    .from('monthly_snapshots')
    .select(`
      *,
      user:users_profile!user_id(id, full_name, role)
    `)
    .order('period_year', { ascending: false })
    .order('period_month', { ascending: false })
    .limit(monthsBack * 20);  // hasta 20 vendedores por mes

  // Rotación de stock del período actual y el anterior
  const { data: rotationCurrent } = await supabase
    .rpc('stock_rotation_for_period', {
      p_start: start.toISOString(),
      p_end: end.toISOString(),
    });
  const { data: rotationPrev } = await supabase
    .rpc('stock_rotation_for_period', {
      p_start: prevStart.toISOString(),
      p_end: prevEnd.toISOString(),
    });

  // Métricas comparativas por sucursal
  const { data: branchMetrics } = await supabase
    .rpc('branch_metrics_for_period', {
      p_start: start.toISOString(),
      p_end: end.toISOString(),
    });
  const { data: branchMetricsPrev } = await supabase
    .rpc('branch_metrics_for_period', {
      p_start: prevStart.toISOString(),
      p_end: prevEnd.toISOString(),
    });

  local.data = {
    sales: sales || [],
    prevSales: prevSales || [],
    opps: opps || [],
    activePipeline: activePipeline || [],
    stock: stock || [],
    team: team || [],
    targets: targetSetting?.value || {},
    snapshots: snapshots || [],
    rotationCurrent: rotationCurrent?.[0] || null,
    rotationPrev: rotationPrev?.[0] || null,
    branchMetrics: branchMetrics || [],
    branchMetricsPrev: branchMetricsPrev || [],
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
          <div class="page-num">MÓDULO 12 · DIRECCIÓN</div>
          <div class="page-title">Dashboard <i>ejecutivo</i></div>
          <div class="page-sub" id="rep-meta">Cargando…</div>
        </div>
        <div class="page-actions">
          <select class="rep-range" id="rep-range">
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
    <div class="rep-body" id="rep-body">
      <div class="empty">Cargando datos…</div>
    </div>
  `;

  $('#rep-range').value = local.range;
  $('#rep-range').addEventListener('change', async (e) => {
    local.range = e.target.value;
    await loadAll();
    renderUI();
  });
  $('#btn-refresh').addEventListener('click', () => mount());
}

function renderUI() {
  const d = local.data;
  if (!d) return;
  const body = $('#rep-body');

  // Cálculos
  const validSales = d.sales.filter(s => s.status !== 'cancelada');
  const wonCount = validSales.length;
  const totalRevenue = validSales.reduce((s, x) => s + (parseFloat(x.sale_price) || 0), 0);
  const totalMargin = validSales.reduce((s, x) => s + (parseFloat(x.gross_margin) || 0), 0);
  const avgMarginPct = totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : 0;
  const avgTicket = wonCount > 0 ? totalRevenue / wonCount : 0;

  const prevValidSales = d.prevSales.filter(s => s.status !== 'cancelada');
  const prevRevenue = prevValidSales.reduce((s, x) => s + (parseFloat(x.sale_price) || 0), 0);
  const prevCount = prevValidSales.length;
  const prevMargin = prevValidSales.reduce((s, x) => s + (parseFloat(x.gross_margin) || 0), 0);

  const closedOpps = d.opps.filter(o => ['ganada', 'perdida'].includes(o.stage));
  const wonOpps = closedOpps.filter(o => o.stage === 'ganada');
  const conversion = closedOpps.length > 0 ? (wonOpps.length / closedOpps.length) * 100 : 0;
  const newLeads = d.opps.length;

  // Pipeline activo
  const pipelineValue = d.activePipeline.reduce((s, o) => s + (parseFloat(o.expected_amount) || 0), 0);
  const pipelineCount = d.activePipeline.length;

  // Targets
  const targetSales = d.targets.monthly_sales || 0;
  const targetRevenue = d.targets.monthly_revenue_usd || 0;
  const targetMargin = d.targets.target_margin_pct || 0;

  // Métricas de rotación
  const rotCur = d.rotationCurrent?.avg_days || 0;
  const rotPrev = d.rotationPrev?.avg_days || 0;
  const rotDiff = rotCur - rotPrev;
  // Si bajó (menos días) = mejora. Si subió (más días) = empeora.
  const rotImproving = rotPrev > 0 && rotCur < rotPrev;
  const rotPctChange = rotPrev > 0 ? ((rotDiff) / rotPrev) * 100 : 0;
  const rotTone = !rotPrev ? 'neutral'
    : rotImproving ? 'success'
    : Math.abs(rotPctChange) < 5 ? 'neutral'
    : 'danger';

  body.innerHTML = `
    <!-- ÍNDICE DE ROTACIÓN DE STOCK · Hero KPI para Cristian -->
    <div class="rotation-hero tone-${rotTone}">
      <div class="rh-main">
        <div class="rh-label">⏱ Índice de rotación · días promedio en venta</div>
        <div class="rh-value">
          ${rotCur > 0 ? Math.round(rotCur) + ' <span class="rh-unit">días</span>' : '—'}
        </div>
        ${rotCur > 0 && rotPrev > 0 ? `
          <div class="rh-delta tone-${rotTone}">
            ${rotImproving ? '▼ Mejorando' : (rotDiff > 0 ? '▲ Empeorando' : '— Estable')}
            <b>${rotImproving ? '-' : (rotDiff > 0 ? '+' : '')}${Math.abs(rotPctChange).toFixed(1)}%</b>
            vs período anterior (${Math.round(rotPrev)}d)
          </div>
        ` : '<div class="rh-delta">Necesitamos al menos 2 períodos con ventas para comparar</div>'}
      </div>
      <div class="rh-trend">
        <div class="rh-trend-label">Últimos 6 meses</div>
        ${renderRotationMiniTrend(d.snapshots)}
      </div>
    </div>

    <!-- COMPARATIVA POR SUCURSAL -->
    <div class="branch-compare">
      <div class="bc-hd">
        <span>Performance por sucursal</span>
        <span class="bc-meta">Caning vs Castelar · período actual</span>
      </div>
      <div class="branch-grid">
        ${renderBranchCards(d.branchMetrics, d.branchMetricsPrev)}
      </div>
    </div>

    <!-- KPIs PRINCIPALES -->
    <div class="rep-kpis">
      ${kpi('Ventas cerradas', wonCount, deltaSub(wonCount, prevCount), targetSales > 0 ? `de ${targetSales} objetivo` : '')}
      ${kpi('Ingresos', 'USD ' + fmt.compact(totalRevenue), deltaSub(totalRevenue, prevRevenue, true), targetRevenue > 0 ? `de USD ${fmt.compact(targetRevenue)} obj.` : '')}
      ${kpi('Margen bruto', 'USD ' + fmt.compact(totalMargin), `${avgMarginPct.toFixed(1)}% promedio`, targetMargin > 0 ? `vs ${targetMargin}% objetivo` : '', avgMarginPct >= targetMargin && targetMargin > 0 ? 'ok' : (avgMarginPct < targetMargin && targetMargin > 0 ? 'warn' : ''))}
      ${kpi('Ticket promedio', avgTicket > 0 ? 'USD ' + fmt.compact(avgTicket) : '—', '', '')}
      ${kpi('Conversión', conversion.toFixed(0) + '%', `${wonOpps.length} ganadas / ${closedOpps.length} cerradas`, '', conversion >= 30 ? 'ok' : '')}
      ${kpi('Pipeline activo', 'USD ' + fmt.compact(pipelineValue), `${pipelineCount} oportunidades`, '')}
    </div>

    <div class="rep-grid">
      <!-- RANKING DE VENDEDORES -->
      <div class="rep-section rep-section-wide">
        <div class="rep-section-hd">
          <span>Ranking de vendedores</span>
          <span class="rep-section-meta">${d.team.length} activos</span>
        </div>
        ${renderRanking(d.team, validSales, d.activePipeline, d.opps)}
      </div>

      <!-- FUNNEL DEL PIPELINE -->
      <div class="rep-section">
        <div class="rep-section-hd">
          <span>Funnel del pipeline</span>
          <span class="rep-section-meta">en período</span>
        </div>
        ${renderFunnel(d.opps)}
      </div>

      <!-- ORÍGENES DE LEADS -->
      <div class="rep-section">
        <div class="rep-section-hd">
          <span>Orígenes de leads</span>
          <span class="rep-section-meta">${newLeads} en período</span>
        </div>
        ${renderOrigins(d.opps, validSales, d.opps)}
      </div>

      <!-- STOCK POR ANTIGÜEDAD -->
      <div class="rep-section rep-section-wide">
        <div class="rep-section-hd">
          <span>Stock por antigüedad</span>
          <span class="rep-section-meta">${d.stock.length} disponibles</span>
        </div>
        ${renderStockAge(d.stock)}
      </div>

      <!-- MOTIVOS DE PÉRDIDA -->
      <div class="rep-section">
        <div class="rep-section-hd">
          <span>Motivos de pérdida</span>
          <span class="rep-section-meta">${d.opps.filter(o => o.stage === 'perdida').length} perdidas</span>
        </div>
        ${renderLossReasons(d.opps)}
      </div>

      <!-- EVOLUCIÓN MENSUAL · histórico de 6 meses (o completo si dueño) -->
      <div class="rep-section rep-section-wide">
        <div class="rep-section-hd">
          <span>Evolución mensual ${isOwner() && local.range === 'all_time' ? '· histórico completo' : '· últimos 6 meses'}</span>
          <span class="rep-section-meta">snapshots automáticos · cierre fin de mes</span>
        </div>
        ${renderHistoryChart(d.snapshots)}
      </div>
    </div>
  `;

  // Meta
  $('#rep-meta').innerHTML = `
    Período: <b>${escapeHtml(formatRange(d.range.start, d.range.end))}</b> ·
    <b>${wonCount}</b> ventas · <b>USD ${fmt.compact(totalRevenue)}</b> ingresos
  `;
}

// ============================================================
// COMPONENTES
// ============================================================
function kpi(label, value, delta, sub, tone = '') {
  return `
    <div class="rep-kpi ${tone}">
      <div class="rep-kpi-label">${escapeHtml(label)}</div>
      <div class="rep-kpi-value">${escapeHtml(String(value))}</div>
      ${delta ? `<div class="rep-kpi-delta">${delta}</div>` : ''}
      ${sub ? `<div class="rep-kpi-sub">${escapeHtml(sub)}</div>` : ''}
    </div>
  `;
}

function deltaSub(current, previous, isMoney = false) {
  if (previous === 0 && current === 0) return '<span class="rep-delta">— sin cambios</span>';
  if (previous === 0) return `<span class="rep-delta up">▲ Nuevo período</span>`;
  const diff = current - previous;
  const pct = (diff / previous) * 100;
  const arrow = diff > 0 ? '▲' : (diff < 0 ? '▼' : '—');
  const cls = diff > 0 ? 'up' : (diff < 0 ? 'down' : '');
  const display = isMoney ? `USD ${fmt.compact(Math.abs(diff))}` : Math.abs(diff);
  return `<span class="rep-delta ${cls}">${arrow} ${pct.toFixed(0)}% (${display}) vs período anterior</span>`;
}

// ============================================================
// RANKING DE VENDEDORES
// ============================================================
function renderRanking(team, sales, activePipeline, opps) {
  // Agrupar ventas y opps por seller
  const map = new Map();
  team.forEach(t => {
    map.set(t.id, {
      id: t.id, name: t.full_name, avatar: t.avatar_initials, role: t.role, target: t.monthly_sales_target,
      wonCount: 0, revenue: 0, margin: 0,
      pipelineValue: 0, pipelineCount: 0,
      newLeads: 0, lostCount: 0,
    });
  });
  for (const s of sales) {
    const m = map.get(s.seller?.id);
    if (!m) continue;
    m.wonCount++;
    m.revenue += parseFloat(s.sale_price) || 0;
    m.margin += parseFloat(s.gross_margin) || 0;
  }
  for (const o of activePipeline) {
    const m = map.get(o.assigned_to);
    if (!m) continue;
    m.pipelineCount++;
    m.pipelineValue += parseFloat(o.expected_amount) || 0;
  }
  for (const o of opps) {
    const m = map.get(o.assigned_to);
    if (!m) continue;
    m.newLeads++;
    if (o.stage === 'perdida') m.lostCount++;
  }

  // Ordenar por revenue
  const ranked = Array.from(map.values()).sort((a, b) => b.revenue - a.revenue || b.wonCount - a.wonCount);
  const maxRevenue = Math.max(...ranked.map(r => r.revenue), 1);

  return `
    <div class="ranking">
      ${ranked.map((r, i) => `
        <div class="rk-row">
          <div class="rk-pos">${i + 1}</div>
          <div class="rk-avatar role-${r.role}">${escapeHtml(r.avatar || fmt.initials(r.name))}</div>
          <div class="rk-name-col">
            <div class="rk-name">${escapeHtml(r.name)}</div>
            <div class="rk-meta">
              ${r.newLeads} leads · ${r.pipelineCount} activas · ${r.lostCount} perdidas
            </div>
          </div>
          <div class="rk-bar-col">
            <div class="rk-bar"><div class="rk-bar-fill" style="width: ${(r.revenue / maxRevenue) * 100}%"></div></div>
            <div class="rk-bar-meta">
              <span><b>${r.wonCount}</b> ${r.wonCount === 1 ? 'venta' : 'ventas'}</span>
              <span>·</span>
              <span><b>USD ${fmt.compact(r.revenue)}</b></span>
              <span>·</span>
              <span class="rk-margin"><b>USD ${fmt.compact(r.margin)}</b> margen</span>
            </div>
          </div>
          <div class="rk-target">
            ${r.target > 0 ? `
              <div class="rk-target-pct">${Math.min(100, (r.wonCount / r.target) * 100).toFixed(0)}%</div>
              <div class="rk-target-meta">${r.wonCount} / ${r.target}</div>
            ` : '<div class="rk-target-empty">—</div>'}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// ============================================================
// FUNNEL
// ============================================================
function renderFunnel(opps) {
  const counts = STAGES.map(stage => ({
    ...stage,
    count: opps.filter(o => o.stage === stage.id || isAtOrPastStage(o.stage, stage.id)).length,
  }));
  const max = Math.max(...counts.map(c => c.count), 1);

  return `
    <div class="funnel">
      ${counts.map((c, i) => {
        const pct = (c.count / max) * 100;
        const conversion = i > 0 && counts[i - 1].count > 0 ? (c.count / counts[i - 1].count) * 100 : null;
        return `
          <div class="fn-row">
            <div class="fn-stage">
              <span class="fn-num">${c.num}</span>
              <span class="fn-name">${escapeHtml(c.name)}</span>
            </div>
            <div class="fn-bar-col">
              <div class="fn-bar"><div class="fn-bar-fill" style="width: ${pct}%"></div></div>
              <div class="fn-count">${c.count}</div>
            </div>
            ${conversion !== null ? `<div class="fn-conv">${conversion.toFixed(0)}%</div>` : '<div class="fn-conv">—</div>'}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function isAtOrPastStage(currentStage, targetStage) {
  const order = ['nuevo', 'contactado', 'visita_test', 'presupuesto', 'negociacion', 'reserva', 'ganada'];
  if (currentStage === 'perdida') return false;
  return order.indexOf(currentStage) >= order.indexOf(targetStage);
}

// ============================================================
// ORÍGENES
// ============================================================
function renderOrigins(opps, sales, allOpps) {
  // Contar opps por origen + cuántas convirtieron
  const byOrigin = new Map();
  for (const o of opps) {
    const cur = byOrigin.get(o.origin) || { total: 0, won: 0, value: 0 };
    cur.total++;
    if (o.stage === 'ganada') cur.won++;
    cur.value += parseFloat(o.expected_amount) || 0;
    byOrigin.set(o.origin, cur);
  }

  if (!byOrigin.size) {
    return `<div class="rep-empty">Sin leads en este período</div>`;
  }

  const items = Array.from(byOrigin.entries())
    .map(([origin, stats]) => ({ origin, ...stats }))
    .sort((a, b) => b.total - a.total);

  const max = Math.max(...items.map(i => i.total), 1);

  return `
    <div class="origins">
      ${items.map(i => `
        <div class="or-row">
          <div class="or-name">${escapeHtml(ORIGIN_LABELS[i.origin] || i.origin)}</div>
          <div class="or-bar"><div class="or-bar-fill" style="width: ${(i.total / max) * 100}%"></div></div>
          <div class="or-stats">
            <b>${i.total}</b>
            <span class="or-conv">${i.won > 0 ? `${i.won} ganadas (${((i.won / i.total) * 100).toFixed(0)}%)` : '0 ganadas'}</span>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// ============================================================
// STOCK POR ANTIGÜEDAD
// ============================================================
function renderStockAge(stock) {
  const buckets = [
    { label: '0-7 días', min: 0, max: 7, units: [] },
    { label: '8-15 días', min: 8, max: 15, units: [] },
    { label: '16-30 días', min: 16, max: 30, units: [] },
    { label: '31-60 días', min: 31, max: 60, units: [] },
    { label: '+60 días', min: 61, max: Infinity, units: [] },
  ];
  const now = Date.now();
  for (const u of stock) {
    const days = Math.floor((now - new Date(u.entered_at).getTime()) / 86400000);
    const b = buckets.find(b => days >= b.min && days <= b.max);
    if (b) b.units.push({ ...u, days });
  }

  return `
    <div class="stock-age">
      <div class="sa-buckets">
        ${buckets.map(b => `
          <div class="sa-bucket ${b.min >= 31 ? 'warn' : ''} ${b.min >= 61 ? 'danger' : ''}">
            <div class="sa-bucket-count">${b.units.length}</div>
            <div class="sa-bucket-label">${escapeHtml(b.label)}</div>
            <div class="sa-bucket-value">USD ${fmt.compact(b.units.reduce((s, u) => s + (parseFloat(u.public_price) || 0), 0))}</div>
          </div>
        `).join('')}
      </div>
      ${buckets.find(b => b.min >= 31)?.units.length > 0 ? `
        <div class="sa-list">
          <div class="sa-list-hd">Unidades con +30 días en stock</div>
          ${buckets.filter(b => b.min >= 31).flatMap(b => b.units).sort((a, b) => b.days - a.days).slice(0, 5).map(u => `
            <a class="sa-row" data-route="/unidades/${escapeHtml(u.unit_code.toLowerCase())}">
              <div class="sa-row-name">${escapeHtml(u.brand)} ${escapeHtml(u.model)} '${String(u.year).slice(2)}</div>
              <div class="sa-row-meta">${escapeHtml(u.unit_code)}</div>
              <div class="sa-row-days">${u.days}d</div>
              <div class="sa-row-price">USD ${escapeHtml(fmt.usd(u.public_price))}</div>
            </a>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

// ============================================================
// ROTACIÓN: TENDENCIA MINI (últimos 6 meses)
// ============================================================
function renderRotationMiniTrend(snapshots) {
  if (!snapshots?.length) {
    return `<div class="rh-trend-empty">Sin datos históricos todavía</div>`;
  }
  // Tomar avg_days_in_stock por período (un valor por período, no por user)
  const byPeriod = new Map();
  for (const s of snapshots) {
    if (!s.avg_days_in_stock) continue;
    const key = `${s.period_year}-${String(s.period_month).padStart(2, '0')}`;
    if (!byPeriod.has(key)) {
      byPeriod.set(key, {
        year: s.period_year, month: s.period_month, key,
        avg_days: parseFloat(s.avg_days_in_stock),
      });
    }
  }
  const periods = Array.from(byPeriod.values()).sort((a, b) =>
    (a.year - b.year) || (a.month - b.month)
  ).slice(-6);

  if (!periods.length) return `<div class="rh-trend-empty">Sin datos en últimos 6 meses</div>`;

  const max = Math.max(...periods.map(p => p.avg_days), 1);
  const min = Math.min(...periods.map(p => p.avg_days), 0);
  const range = max - min || 1;

  return `
    <div class="rh-trend-bars">
      ${periods.map((p, i) => {
        const norm = (p.avg_days - min) / range;
        const height = 30 + norm * 50;  // 30%-80% para que se vea variación
        const monthLabel = new Date(p.year, p.month - 1, 1).toLocaleDateString('es-AR', { month: 'short' }).replace('.', '');
        // El primero (más viejo) debe ser referencia. Si los siguientes BAJAN (menos días) = mejorando = verde
        const tone = i > 0 && p.avg_days < periods[i - 1].avg_days ? 'good' : 'neutral';
        return `
          <div class="rh-trend-col">
            <div class="rh-trend-bar tone-${tone}" style="height: ${height}%" title="${monthLabel}: ${Math.round(p.avg_days)} días"></div>
            <div class="rh-trend-month">${escapeHtml(monthLabel)}</div>
            <div class="rh-trend-days">${Math.round(p.avg_days)}d</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// ============================================================
// COMPARATIVA POR SUCURSAL
// ============================================================
function renderBranchCards(current, previous) {
  if (!current?.length) {
    return `<div class="rep-empty">Sin sucursales configuradas</div>`;
  }
  const prevByBranch = new Map();
  (previous || []).forEach(b => prevByBranch.set(b.branch_id, b));

  return current.map(b => {
    const prev = prevByBranch.get(b.branch_id) || null;
    const sellThrough = parseFloat(b.sell_through_pct);
    const avgDays = parseFloat(b.avg_days_in_stock);
    const revenue = parseFloat(b.total_revenue);
    const prevSellThrough = prev ? parseFloat(prev.sell_through_pct) : 0;
    const prevAvgDays = prev ? parseFloat(prev.avg_days_in_stock) : 0;
    const prevRevenue = prev ? parseFloat(prev.total_revenue) : 0;

    // Tones
    const sellTone = sellThrough >= 30 ? 'good' : sellThrough >= 15 ? 'warn' : sellThrough > 0 ? 'danger' : 'neutral';
    const rotTone = avgDays > 0 && prevAvgDays > 0 && avgDays < prevAvgDays ? 'good'
      : avgDays > 0 && prevAvgDays > 0 && avgDays > prevAvgDays * 1.1 ? 'danger'
      : 'neutral';

    return `
      <div class="branch-card">
        <div class="bc-name">📍 ${escapeHtml(b.branch_name)}</div>
        <div class="bc-stats">
          <div class="bc-stat tone-${sellTone}">
            <div class="bc-stat-num">${sellThrough.toFixed(1)}%</div>
            <div class="bc-stat-label">% vendidos del stock</div>
            <div class="bc-stat-detail">${b.units_sold} de ${b.available_at_start} unidades</div>
            ${prev ? `<div class="bc-stat-delta">${formatDelta(sellThrough, prevSellThrough, '%', false)}</div>` : ''}
          </div>
          <div class="bc-stat tone-${rotTone}">
            <div class="bc-stat-num">${avgDays > 0 ? Math.round(avgDays) + 'd' : '—'}</div>
            <div class="bc-stat-label">Días promedio en venta</div>
            <div class="bc-stat-detail">${b.units_sold} unidades cerradas</div>
            ${prev && prevAvgDays > 0 && avgDays > 0 ? `<div class="bc-stat-delta">${formatDelta(avgDays, prevAvgDays, 'd', true)}</div>` : ''}
          </div>
          <div class="bc-stat">
            <div class="bc-stat-num">USD ${fmt.compact(revenue)}</div>
            <div class="bc-stat-label">Ingresos del período</div>
            ${prev ? `<div class="bc-stat-delta">${formatDelta(revenue, prevRevenue, '', false, true)}</div>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function formatDelta(curr, prev, suffix = '', invert = false, isMoney = false) {
  if (!prev || prev === 0) return '<span class="bc-delta neutral">—</span>';
  const diff = curr - prev;
  const pct = (diff / prev) * 100;
  const arrow = diff > 0 ? '▲' : (diff < 0 ? '▼' : '—');
  // invert: para "días en venta" donde menos es mejor
  const isPositive = invert ? diff < 0 : diff > 0;
  const cls = diff === 0 ? 'neutral' : (isPositive ? 'good' : 'bad');
  return `<span class="bc-delta ${cls}">${arrow} ${Math.abs(pct).toFixed(0)}% vs anterior</span>`;
}

// ============================================================
// EVOLUCIÓN MENSUAL (snapshots históricos)
// ============================================================
function renderHistoryChart(snapshots) {
  if (!snapshots?.length) {
    return `<div class="rep-empty">Sin snapshots históricos todavía. El primer cierre se genera el día 1 del próximo mes.</div>`;
  }

  // Agrupar por período (ignorando user para el agregado total)
  const byPeriod = new Map();
  for (const s of snapshots) {
    const k = `${s.period_year}-${String(s.period_month).padStart(2, '0')}`;
    const cur = byPeriod.get(k) || {
      year: s.period_year, month: s.period_month, key: k,
      sales: 0, revenue: 0, margin: 0, target: 0, leads: 0,
    };
    cur.sales += s.sales_count || 0;
    cur.revenue += parseFloat(s.total_revenue) || 0;
    cur.margin += parseFloat(s.total_margin) || 0;
    cur.target += s.monthly_target || 0;
    cur.leads += s.new_leads || 0;
    byPeriod.set(k, cur);
  }

  // Ordenar cronológicamente, agregar mes en curso si no está
  const periods = Array.from(byPeriod.values()).sort((a, b) =>
    (a.year - b.year) || (a.month - b.month)
  );

  const limit = local.range === 'all_time' ? periods.length : 6;
  const trimmed = periods.slice(-limit);

  const maxRevenue = Math.max(...trimmed.map(p => p.revenue), 1);

  const monthName = (y, m) => {
    const d = new Date(y, m - 1, 1);
    return d.toLocaleDateString('es-AR', { month: 'short', year: '2-digit' }).replace('.', '');
  };

  return `
    <div class="hist-chart">
      <div class="hist-bars">
        ${trimmed.map(p => {
          const pct = (p.revenue / maxRevenue) * 100;
          const targetPct = p.target > 0 ? (p.sales / p.target) * 100 : 0;
          const tone = targetPct >= 100 ? 'success' : targetPct >= 75 ? 'good' : targetPct >= 50 ? 'warn' : 'danger';
          return `
            <div class="hist-col">
              <div class="hist-bar-wrap">
                <div class="hist-revenue">USD ${fmt.compact(p.revenue)}</div>
                <div class="hist-bar"><div class="hist-bar-fill tone-${tone}" style="height: ${pct}%"></div></div>
              </div>
              <div class="hist-meta">
                <div class="hist-month">${escapeHtml(monthName(p.year, p.month))}</div>
                <div class="hist-stats">
                  <b>${p.sales}</b>${p.target ? ` / ${p.target}` : ''} ventas
                </div>
                ${p.target ? `<div class="hist-pct tone-${tone}">${targetPct.toFixed(0)}%</div>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
      <div class="hist-legend">
        <span class="hist-leg success">≥100% objetivo</span>
        <span class="hist-leg good">≥75%</span>
        <span class="hist-leg warn">≥50%</span>
        <span class="hist-leg danger">&lt;50%</span>
      </div>
    </div>
  `;
}

// ============================================================
// MOTIVOS DE PÉRDIDA
// ============================================================
function renderLossReasons(opps) {
  const lost = opps.filter(o => o.stage === 'perdida');
  if (!lost.length) {
    return `<div class="rep-empty">Sin oportunidades perdidas en este período 🎉</div>`;
  }
  const reasons = new Map();
  for (const o of lost) {
    const r = o.loss_reason || 'sin_motivo';
    reasons.set(r, (reasons.get(r) || 0) + 1);
  }
  const REASON_LABELS = {
    precio: 'Precio',
    no_respondio: 'No respondió',
    compro_en_competencia: 'Compró en competencia',
    no_califica_credito: 'No califica crédito',
    cambio_de_planes: 'Cambió de planes',
    producto_no_disponible: 'Producto no disponible',
    otro: 'Otro',
    sin_motivo: 'Sin motivo cargado',
  };
  const items = Array.from(reasons.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
  const max = Math.max(...items.map(i => i.count), 1);

  return `
    <div class="loss-reasons">
      ${items.map(i => `
        <div class="lr-row">
          <div class="lr-name">${escapeHtml(REASON_LABELS[i.reason] || i.reason)}</div>
          <div class="lr-bar"><div class="lr-bar-fill" style="width: ${(i.count / max) * 100}%"></div></div>
          <div class="lr-count">${i.count}</div>
        </div>
      `).join('')}
    </div>
  `;
}

// ============================================================
// HELPERS
// ============================================================
function formatRange(start, end) {
  const fmtDate = (d) => d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
  return `${fmtDate(start)} — ${fmtDate(end)}`;
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

  .rep-body { padding: 0; }

  /* HERO ROTACIÓN */
  .rotation-hero {
    display: grid; grid-template-columns: 1fr; gap: 0;
    background: var(--cc-surface);
    border-bottom: 1px solid var(--cc-line);
    border-left: 6px solid var(--cc-line);
  }
  @container app (min-width: 900px) { .rotation-hero { grid-template-columns: 1.5fr 1fr; } }
  .rotation-hero.tone-success { border-left-color: var(--cc-ok); background: linear-gradient(90deg, var(--cc-ok-soft) 0%, var(--cc-surface) 30%); }
  .rotation-hero.tone-danger { border-left-color: var(--cc-danger); background: linear-gradient(90deg, var(--cc-danger-soft) 0%, var(--cc-surface) 30%); }
  .rotation-hero.tone-neutral { border-left-color: var(--cc-champagne); }
  .rh-main { padding: 22px 28px; }
  @container app (max-width: 900px) { .rh-main { padding: 18px 20px; } }
  .rh-label { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cc-muted); font-weight: 600; margin-bottom: 8px; }
  .rh-value {
    font-family: var(--cc-font-display); font-weight: 400;
    font-size: 56px; line-height: 1; letter-spacing: -0.03em;
    color: var(--cc-ink);
  }
  .rotation-hero.tone-success .rh-value { color: var(--cc-ok); }
  .rotation-hero.tone-danger .rh-value { color: var(--cc-danger); }
  .rh-unit { font-family: var(--cc-font-mono); font-size: 18px; color: var(--cc-muted); font-weight: 400; letter-spacing: 0; }
  .rh-delta {
    font-family: var(--cc-font-mono); font-size: 12px; margin-top: 12px;
    color: var(--cc-muted); letter-spacing: 0.05em;
  }
  .rh-delta b { font-size: 14px; }
  .rh-delta.tone-success { color: var(--cc-ok); font-weight: 600; }
  .rh-delta.tone-success b { color: var(--cc-ok); }
  .rh-delta.tone-danger { color: var(--cc-danger); font-weight: 600; }
  .rh-delta.tone-danger b { color: var(--cc-danger); }

  .rh-trend { padding: 22px 28px; border-left: 1px solid var(--cc-line-soft); }
  @container app (max-width: 900px) { .rh-trend { padding: 18px 20px; border-left: none; border-top: 1px solid var(--cc-line-soft); } }
  .rh-trend-label { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--cc-muted); margin-bottom: 12px; font-weight: 600; }
  .rh-trend-bars { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 6px; align-items: end; min-height: 100px; }
  .rh-trend-col { display: flex; flex-direction: column; align-items: center; gap: 4px; min-height: 100px; justify-content: flex-end; }
  .rh-trend-bar { width: 100%; max-width: 32px; background: var(--cc-steel); transition: height 0.4s ease; min-height: 8px; }
  .rh-trend-bar.tone-good { background: var(--cc-ok); }
  .rh-trend-month { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--cc-muted); }
  .rh-trend-days { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-ink); font-weight: 600; }
  .rh-trend-empty { font-style: italic; font-size: 11px; color: var(--cc-muted); }

  /* COMPARATIVA SUCURSALES */
  .branch-compare {
    background: var(--cc-bg);
    padding: 22px 28px;
    border-bottom: 1px solid var(--cc-line);
  }
  @container app (max-width: 900px) { .branch-compare { padding: 18px 20px; } }
  .bc-hd {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-bottom: 14px; gap: 10px; flex-wrap: wrap;
    font-family: var(--cc-font-mono); font-size: 10px;
    letter-spacing: 0.22em; text-transform: uppercase; font-weight: 600;
  }
  .bc-meta { color: var(--cc-muted); font-weight: 400; letter-spacing: 0.1em; text-transform: none; font-size: 10px; }
  .branch-grid {
    display: grid; grid-template-columns: 1fr; gap: 14px;
  }
  @container app (min-width: 800px) { .branch-grid { grid-template-columns: repeat(2, 1fr); } }
  .branch-card {
    background: var(--cc-surface); border: 1px solid var(--cc-line);
    padding: 18px 20px;
  }
  .bc-name {
    font-family: var(--cc-font-display); font-weight: 500;
    font-size: 22px; letter-spacing: -0.01em; margin-bottom: 14px;
  }
  .bc-stats {
    display: grid; grid-template-columns: 1fr; gap: 1px;
    background: var(--cc-line);
    border: 1px solid var(--cc-line);
  }
  @container app (min-width: 600px) { .bc-stats { grid-template-columns: repeat(3, 1fr); } }
  .bc-stat { background: var(--cc-surface); padding: 12px 14px; }
  .bc-stat.tone-good { background: var(--cc-ok-soft); }
  .bc-stat.tone-warn { background: var(--cc-warn-soft); }
  .bc-stat.tone-danger { background: var(--cc-danger-soft); }
  .bc-stat-num {
    font-family: var(--cc-font-display); font-weight: 500;
    font-size: 26px; line-height: 1; margin-bottom: 4px;
  }
  .bc-stat.tone-good .bc-stat-num { color: var(--cc-ok); }
  .bc-stat.tone-warn .bc-stat-num { color: var(--cc-warn); }
  .bc-stat.tone-danger .bc-stat-num { color: var(--cc-danger); }
  .bc-stat-label {
    font-family: var(--cc-font-mono); font-size: 9px;
    letter-spacing: 0.18em; text-transform: uppercase;
    color: var(--cc-muted); font-weight: 600;
  }
  .bc-stat-detail { font-size: 11px; color: var(--cc-muted); margin-top: 2px; }
  .bc-stat-delta { font-family: var(--cc-font-mono); font-size: 10px; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--cc-line-soft); }
  .bc-delta.good { color: var(--cc-ok); font-weight: 600; }
  .bc-delta.bad { color: var(--cc-danger); font-weight: 600; }
  .bc-delta.neutral { color: var(--cc-muted); }

  /* KPIs */
  .rep-kpis {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1px;
    background: var(--cc-line);
    border-bottom: 1px solid var(--cc-line);
  }
  @container app (min-width: 700px) { .rep-kpis { grid-template-columns: repeat(3, 1fr); } }
  @container app (min-width: 1100px) { .rep-kpis { grid-template-columns: repeat(6, 1fr); } }

  .rep-kpi { background: var(--cc-surface); padding: 16px 18px; }
  .rep-kpi.ok { background: var(--cc-ok-soft); }
  .rep-kpi.warn { background: var(--cc-warn-soft); }
  .rep-kpi-label { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cc-muted); font-weight: 500; margin-bottom: 6px; }
  .rep-kpi-value { font-family: var(--cc-font-display); font-weight: 400; font-size: 28px; letter-spacing: -0.02em; line-height: 1; }
  .rep-kpi-delta { font-family: var(--cc-font-mono); font-size: 10px; margin-top: 6px; letter-spacing: 0.05em; }
  .rep-delta { color: var(--cc-muted); }
  .rep-delta.up { color: var(--cc-ok); font-weight: 600; }
  .rep-delta.down { color: var(--cc-danger); font-weight: 600; }
  .rep-kpi-sub { font-size: 11px; color: var(--cc-muted); margin-top: 4px; }

  /* GRID */
  .rep-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1px;
    background: var(--cc-line);
  }
  @container app (min-width: 1100px) { .rep-grid { grid-template-columns: 2fr 1fr; } }

  .rep-section {
    background: var(--cc-bg);
    padding: 18px 20px;
    min-width: 0;
  }
  @container app (min-width: 900px) { .rep-section { padding: 22px 28px; } }
  @container app (min-width: 1100px) {
    .rep-section-wide { grid-column: 1 / -1; }
  }
  .rep-section-hd {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-bottom: 14px;
    font-family: var(--cc-font-mono); font-size: 10px;
    letter-spacing: 0.22em; text-transform: uppercase;
    font-weight: 600;
  }
  .rep-section-meta { color: var(--cc-muted); font-weight: 400; letter-spacing: 0.1em; }
  .rep-empty { padding: 24px 16px; text-align: center; color: var(--cc-muted); font-style: italic; font-size: 12px; background: var(--cc-surface); border: 1px solid var(--cc-line); }

  /* RANKING */
  .ranking { background: var(--cc-surface); border: 1px solid var(--cc-line); }
  .rk-row {
    display: grid;
    grid-template-columns: 30px 36px 1fr 2fr 60px;
    gap: 12px;
    padding: 12px 14px;
    align-items: center;
    border-bottom: 1px solid var(--cc-line-soft);
  }
  .rk-row:last-child { border-bottom: none; }
  .rk-pos { font-family: var(--cc-font-mono); font-weight: 700; font-size: 14px; color: var(--cc-champagne); text-align: center; }
  .rk-avatar { width: 36px; height: 36px; border-radius: 50%; background: linear-gradient(135deg, var(--cc-graphite), var(--cc-steel)); color: var(--cc-bg); display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; }
  .rk-avatar.role-dueno { background: linear-gradient(135deg, var(--cc-champagne), #8a6f45); color: var(--cc-ink); }
  .rk-avatar.role-gerente { background: linear-gradient(135deg, var(--cc-info), #1f3a5e); }
  .rk-name-col { min-width: 0; }
  .rk-name { font-weight: 500; font-size: 13px; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rk-meta { font-family: var(--cc-font-mono); font-size: 9px; color: var(--cc-muted); margin-top: 2px; letter-spacing: 0.05em; }
  .rk-bar { height: 4px; background: var(--cc-bg-alt); margin-bottom: 6px; position: relative; overflow: hidden; }
  .rk-bar-fill { position: absolute; inset: 0; background: linear-gradient(90deg, var(--cc-champagne), var(--cc-ok)); transition: width 0.4s; }
  .rk-bar-meta { display: flex; gap: 6px; font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); flex-wrap: wrap; letter-spacing: 0.05em; }
  .rk-bar-meta b { color: var(--cc-ink); font-weight: 600; }
  .rk-margin b { color: var(--cc-ok); }
  .rk-target { text-align: center; }
  .rk-target-pct { font-family: var(--cc-font-mono); font-weight: 700; font-size: 14px; }
  .rk-target-meta { font-family: var(--cc-font-mono); font-size: 9px; color: var(--cc-muted); margin-top: 2px; letter-spacing: 0.05em; }
  .rk-target-empty { color: var(--cc-line); }

  @container app (max-width: 900px) {
    .rk-row { grid-template-columns: 24px 32px 1fr 50px; gap: 8px; }
    .rk-bar-col { grid-column: 1 / -1; padding-top: 6px; }
    .rk-target { font-size: 11px; }
  }

  /* FUNNEL */
  .funnel { background: var(--cc-surface); border: 1px solid var(--cc-line); padding: 14px; }
  .fn-row { display: grid; grid-template-columns: 110px 1fr 50px; gap: 10px; align-items: center; padding: 6px 0; }
  .fn-stage { display: flex; gap: 8px; align-items: center; font-size: 12px; }
  .fn-num { font-family: var(--cc-font-mono); font-size: 9px; color: var(--cc-champagne); font-weight: 600; letter-spacing: 0.1em; }
  .fn-name { font-weight: 500; }
  .fn-bar-col { display: flex; align-items: center; gap: 8px; }
  .fn-bar { flex: 1; height: 14px; background: var(--cc-bg-alt); position: relative; }
  .fn-bar-fill { position: absolute; inset: 0; background: var(--cc-ink); transition: width 0.4s; }
  .fn-count { font-family: var(--cc-font-mono); font-size: 11px; font-weight: 600; min-width: 24px; text-align: right; }
  .fn-conv { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); text-align: right; letter-spacing: 0.05em; }

  /* ORIGINS */
  .origins { background: var(--cc-surface); border: 1px solid var(--cc-line); padding: 4px 0; }
  .or-row { display: grid; grid-template-columns: 110px 1fr auto; gap: 10px; align-items: center; padding: 8px 14px; border-bottom: 1px solid var(--cc-line-soft); }
  .or-row:last-child { border-bottom: none; }
  .or-name { font-size: 12px; font-weight: 500; }
  .or-bar { height: 6px; background: var(--cc-bg-alt); position: relative; overflow: hidden; }
  .or-bar-fill { position: absolute; inset: 0; background: var(--cc-info); transition: width 0.4s; }
  .or-stats { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); text-align: right; letter-spacing: 0.05em; }
  .or-stats b { color: var(--cc-ink); font-size: 12px; margin-right: 6px; }
  .or-conv { display: block; }

  /* STOCK AGE */
  .sa-buckets {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 1px;
    background: var(--cc-line);
    border: 1px solid var(--cc-line);
    margin-bottom: 14px;
  }
  @container app (max-width: 700px) { .sa-buckets { grid-template-columns: repeat(2, 1fr); } }
  .sa-bucket { background: var(--cc-surface); padding: 14px 12px; text-align: center; }
  .sa-bucket.warn { background: var(--cc-warn-soft); }
  .sa-bucket.danger { background: var(--cc-danger-soft); }
  .sa-bucket-count { font-family: var(--cc-font-display); font-weight: 400; font-size: 28px; line-height: 1; }
  .sa-bucket.danger .sa-bucket-count { color: var(--cc-danger); }
  .sa-bucket-label { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--cc-muted); margin-top: 4px; }
  .sa-bucket-value { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); margin-top: 2px; letter-spacing: 0.05em; }

  .sa-list { background: var(--cc-surface); border: 1px solid var(--cc-line); }
  .sa-list-hd { padding: 10px 14px; border-bottom: 1px solid var(--cc-line-soft); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; font-weight: 600; color: var(--cc-muted); }
  .sa-row { display: grid; grid-template-columns: 1fr 100px 50px 110px; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--cc-line-soft); align-items: center; cursor: pointer; text-decoration: none; color: inherit; font-size: 12px; }
  .sa-row:last-child { border-bottom: none; }
  .sa-row:hover { background: var(--cc-bg-alt); }
  .sa-row-name { font-weight: 500; }
  .sa-row-meta { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); letter-spacing: 0.05em; }
  .sa-row-days { font-family: var(--cc-font-mono); font-weight: 600; color: var(--cc-danger); text-align: center; }
  .sa-row-price { font-family: var(--cc-font-mono); text-align: right; }

  /* HISTORY CHART (snapshots) */
  .hist-chart { background: var(--cc-surface); border: 1px solid var(--cc-line); padding: 16px; }
  .hist-bars { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 12px; align-items: end; min-height: 240px; }
  .hist-col { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .hist-bar-wrap { display: flex; flex-direction: column; align-items: center; flex: 1; min-height: 200px; justify-content: flex-end; }
  .hist-revenue { font-family: var(--cc-font-mono); font-size: 10px; font-weight: 600; margin-bottom: 4px; color: var(--cc-ink); }
  .hist-bar { width: 100%; max-width: 80px; height: 180px; background: var(--cc-bg-alt); position: relative; overflow: hidden; border: 1px solid var(--cc-line); }
  .hist-bar-fill { position: absolute; bottom: 0; left: 0; right: 0; transition: height 0.6s ease; }
  .hist-bar-fill.tone-success { background: linear-gradient(0deg, var(--cc-champagne), var(--cc-ok)); }
  .hist-bar-fill.tone-good { background: var(--cc-ok); }
  .hist-bar-fill.tone-warn { background: var(--cc-warn); }
  .hist-bar-fill.tone-danger { background: var(--cc-danger); }
  .hist-meta { text-align: center; padding-top: 6px; border-top: 1px solid var(--cc-line-soft); }
  .hist-month { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--cc-ink); font-weight: 600; }
  .hist-stats { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); margin-top: 2px; }
  .hist-stats b { color: var(--cc-ink); }
  .hist-pct { font-family: var(--cc-font-display); font-weight: 500; font-size: 16px; margin-top: 4px; }
  .hist-pct.tone-success { color: var(--cc-champagne); }
  .hist-pct.tone-good { color: var(--cc-ok); }
  .hist-pct.tone-warn { color: var(--cc-warn); }
  .hist-pct.tone-danger { color: var(--cc-danger); }
  .hist-legend { display: flex; justify-content: center; gap: 14px; padding-top: 12px; border-top: 1px solid var(--cc-line-soft); margin-top: 12px; flex-wrap: wrap; }
  .hist-leg { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.1em; padding: 3px 8px; border: 1px solid currentColor; }
  .hist-leg.success { color: var(--cc-champagne); }
  .hist-leg.good { color: var(--cc-ok); }
  .hist-leg.warn { color: var(--cc-warn); }
  .hist-leg.danger { color: var(--cc-danger); }

  /* LOSS REASONS */
  .loss-reasons { background: var(--cc-surface); border: 1px solid var(--cc-line); padding: 4px 0; }
  .lr-row { display: grid; grid-template-columns: 130px 1fr 30px; gap: 10px; align-items: center; padding: 8px 14px; border-bottom: 1px solid var(--cc-line-soft); }
  .lr-row:last-child { border-bottom: none; }
  .lr-name { font-size: 12px; }
  .lr-bar { height: 6px; background: var(--cc-bg-alt); position: relative; overflow: hidden; }
  .lr-bar-fill { position: absolute; inset: 0; background: var(--cc-danger); transition: width 0.4s; }
  .lr-count { font-family: var(--cc-font-mono); font-weight: 600; text-align: right; }
`;
