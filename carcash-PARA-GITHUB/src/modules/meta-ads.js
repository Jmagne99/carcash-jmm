// ============================================================
// CARCASH · META ADS + LEAD ADS  (ruta /meta-ads)
// Performance de campañas de Meta (Facebook/Instagram) + los leads
// que entran por Lead Ads. Mide costo por lead (CPL) y ROI.
// Métricas de campaña: demo hasta conectar la Marketing API.
// Lead Ads: reales (oportunidades con origen meta_ads).
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { isSupervisorOrAdmin } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles } from '../lib/dom.js';
import { navigate } from '../lib/router.js';
import { fetchMetaAds } from '../lib/meta-ads.js';

export async function mount() {
  injectStyles('metaads-styles', styles);
  if (!isSupervisorOrAdmin()) {
    $('#view').innerHTML = `<div class="placeholder"><div class="placeholder-content">
      <div class="placeholder-num">×</div><div class="placeholder-title">Acceso <i>restringido</i></div>
      <div class="placeholder-desc">Reportes de inversión publicitaria para dueño / gerente / supervisor.</div>
      <div class="placeholder-status">NO AUTORIZADO</div></div></div>`;
    return;
  }
  render();
  await load();
}
export default mount;

function render() {
  $('#view').innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">MARKETING · META ADS</div>
          <div class="page-title">Meta Ads &amp; <i>Lead Ads</i></div>
          <div class="page-sub" id="ma-sub">Cargando…</div>
        </div>
        <div class="page-actions"><button class="btn btn-ghost" id="ma-refresh">Actualizar</button></div>
      </div>
      <div class="kpi-grid" id="ma-kpis"></div>
    </div>
    <div class="page-body" id="ma-body"><div class="empty">Cargando…</div></div>
  `;
  $('#ma-refresh').addEventListener('click', () => mount());
}

async function load() {
  const ads = await fetchMetaAds('30d').catch(() => null);
  // Lead Ads reales (oportunidades origen meta_ads)
  const { data: leads } = await supabase.from('opportunities')
    .select('id, opp_code, stage, expected_amount, source_campaign, created_at, contact:contacts!contact_id(full_name), assignee:users_profile!assigned_to(full_name)')
    .eq('origin', 'meta_ads').is('deleted_at', null)
    .order('created_at', { ascending: false }).limit(50);

  const t = ads?.totals || {};
  $('#ma-sub').innerHTML = ads?._mock
    ? 'Inversión últimos 30 días · datos de demostración'
    : 'Inversión últimos 30 días';
  $('#ma-kpis').innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Inversión (USD)</div><div class="kpi-value">USD ${fmt.compact(t.spend || 0)}</div><div class="kpi-sub">${t.period || '30d'}</div></div>
    <div class="kpi-card"><div class="kpi-label">Leads</div><div class="kpi-value">${fmt.compact(t.leads || 0)}</div><div class="kpi-sub">${(t.ctr ?? 0)}% CTR</div></div>
    <div class="kpi-card ${t.cpl ? 'warn' : ''}"><div class="kpi-label">Costo por lead</div><div class="kpi-value">USD ${fmt.compact(t.cpl || 0)}</div><div class="kpi-sub">CPL promedio</div></div>
    <div class="kpi-card ok"><div class="kpi-label">Retorno (ROAS)</div><div class="kpi-value">${t.roas ?? 0}x</div><div class="kpi-sub">${t.sales || 0} ventas · USD ${fmt.compact(t.revenue_usd || 0)} facturado</div></div>
  `;

  const body = $('#ma-body');
  body.innerHTML = '';
  if (ads?._mock) body.appendChild(el('div', { class: 'note', html: '◉ Métricas de campañas en modo demostración. Se vuelven reales al conectar la <b>Marketing API</b> de Meta (Ad Account). Los <b>Lead Ads</b> entran solos como leads vía el webhook de Meta + n8n.' }));

  // Campañas
  const campHost = el('div', { class: 'ma-section' }, el('div', { class: 'ma-hd' }, 'Campañas'), el('div', { id: 'ma-camps' }));
  body.appendChild(campHost);
  const ch = $('#ma-camps');
  const camps = ads?.campaigns || [];
  if (!camps.length) {
    ch.innerHTML = `<div class="empty">Sin campañas para mostrar</div>`;
  } else {
    ch.innerHTML = `<div class="cc-table-wrap"><table class="cc-table">
      <thead><tr><th>Campaña</th><th>Estado</th><th class="num">Inversión</th><th class="num">Impres.</th><th class="num">Clics</th><th class="num">Leads</th><th class="num">CPL</th></tr></thead>
      <tbody>${camps.map(c => `
        <tr><td class="t-strong">${escapeHtml(c.name)}<div class="text-muted" style="font-size:10px">${escapeHtml(c.objective || '')}</div></td>
        <td><span class="chip sm ${c.status === 'activa' ? 'ok' : 'warn'}">${escapeHtml(c.status)}</span></td>
        <td class="num">$${fmt.compact(c.spend)}</td>
        <td class="num">${fmt.compact(c.impressions)}</td>
        <td class="num">${fmt.compact(c.clicks)}</td>
        <td class="num t-strong">${c.leads}</td>
        <td class="num">$${fmt.compact(c.cpl)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // Lead Ads recientes (reales)
  const leadHost = el('div', { class: 'ma-section' }, el('div', { class: 'ma-hd' }, 'Lead Ads recientes (entran al pipeline)'), el('div', { id: 'ma-leads' }));
  body.appendChild(leadHost);
  const lh = $('#ma-leads');
  if (!(leads || []).length) {
    lh.innerHTML = `<div class="empty-rich"><div class="er-icon">▲</div><div class="er-title">Todavía no hay Lead Ads</div><div class="er-desc">Cuando conectes los formularios de Lead Ads de Meta, cada lead entra acá y al pipeline con su campaña de origen.</div></div>`;
  } else {
    lh.innerHTML = `<div class="cc-table-wrap"><table class="cc-table">
      <thead><tr><th>Contacto</th><th>Campaña</th><th>Etapa</th><th class="num">Monto</th><th>Vendedor</th><th></th></tr></thead>
      <tbody>${leads.map(o => `
        <tr class="clickable" data-go="${escapeHtml(o.opp_code)}">
          <td class="t-strong">${escapeHtml(o.contact?.full_name || 'Sin nombre')}<div class="text-muted mono" style="font-size:10px">${escapeHtml(o.opp_code)}</div></td>
          <td class="text-muted">${escapeHtml(o.source_campaign || '—')}</td>
          <td><span class="chip sm">${escapeHtml(fmt.humanize(o.stage))}</span></td>
          <td class="num">USD ${escapeHtml(fmt.compact(o.expected_amount || 0))}</td>
          <td class="text-muted">${escapeHtml(o.assignee?.full_name || '— sin asignar —')}</td>
          <td style="text-align:right"><button class="ag-mini" data-go="${escapeHtml(o.opp_code)}">Abrir</button></td>
        </tr>`).join('')}</tbody></table></div>`;
    lh.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => navigate('/pipeline/' + b.dataset.go.toLowerCase())));
  }
}

const styles = `
  #ma-kpis { margin-top: 4px; }
  .ma-section { margin-bottom: 22px; }
  .ma-hd { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; font-weight: 600; color: var(--cc-muted); margin-bottom: 10px; }
`;
