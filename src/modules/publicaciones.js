// ============================================================
// CARCASH · MÓDULO PUBLICACIONES  (ruta /publicaciones)
// ------------------------------------------------------------
// Estado de las publicaciones de cada unidad en los canales
// externos (Mercado Libre, Instagram). Muestra vistas, consultas,
// estado de sincronización y errores. Permite pausar/republicar
// (vía Edge Functions; si no están deployadas, avisa).
// Además sugiere unidades disponibles aún sin publicar.
// Roles: back office / gerente / dueño.
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles } from '../lib/dom.js';
import { navigate } from '../lib/router.js';
import { CHANNELS, publishUnit } from '../lib/publish.js';

const CH_LABEL = { mercado_libre: 'Mercado Libre', instagram: 'Instagram', web: 'Web', otro: 'Otro' };
const CH_CLASS = { mercado_libre: 'ml', instagram: 'ig', web: 'web' };
const STATUS_CHIP = { activa: 'ok', pausada: 'warn', error: 'danger', finalizada: '' };

const local = { pubs: [], unpublished: [], filter: 'all' };

export async function mount() {
  injectStyles('pub-styles', styles);
  render();
  await load();
  renderUI();
}
export default mount;

async function load() {
  const { data: pubs, error } = await supabase
    .from('publications')
    .select('id, unit_id, channel, external_id, url, status, views, inquiries, published_at, last_synced_at, error_message, auto_publish, unit:units!unit_id(unit_code, brand, model, year, status, main_photo_url)')
    .order('published_at', { ascending: false });
  if (error) { toast('Error cargando publicaciones', error.message, 'error'); local.pubs = []; }
  else local.pubs = pubs || [];

  // Unidades disponibles sin ninguna publicación
  const { data: units } = await supabase
    .from('units')
    .select('id, unit_code, brand, model, year, public_price, auto_publish_channels')
    .eq('status', 'disponible')
    .is('deleted_at', null);
  const publishedIds = new Set(local.pubs.map(p => p.unit_id));
  local.unpublished = (units || []).filter(u => !publishedIds.has(u.id));
}

function render() {
  $('#view').innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">MÓDULO 07 · STOCK</div>
          <div class="page-title">Publicaciones &amp; <i>canales</i></div>
          <div class="page-sub" id="pub-meta">Cargando…</div>
        </div>
        <div class="page-actions">
          <div class="seg" id="pub-filter">
            <button data-f="all" class="active">Todas</button>
            <button data-f="mercado_libre">Mercado Libre</button>
            <button data-f="instagram">Instagram</button>
            <button data-f="error">Con error</button>
          </div>
          <button class="btn btn-ghost" id="pub-refresh">Actualizar</button>
        </div>
      </div>
      <div class="kpi-grid" id="pub-kpis"></div>
    </div>
    <div class="page-body">
      <div id="pub-list"><div class="empty">Cargando…</div></div>
      <div id="pub-gap"></div>
    </div>
  `;
  $('#pub-refresh').addEventListener('click', () => mount());
  $('#pub-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]'); if (!b) return;
    local.filter = b.dataset.f;
    $$('#pub-filter button').forEach(x => x.classList.toggle('active', x === b));
    renderList();
  });
}

function renderUI() { renderKpis(); renderList(); renderGap(); }

function renderKpis() {
  const activas = local.pubs.filter(p => p.status === 'activa').length;
  const views = local.pubs.reduce((a, p) => a + (p.views || 0), 0);
  const inq = local.pubs.reduce((a, p) => a + (p.inquiries || 0), 0);
  const errs = local.pubs.filter(p => p.status === 'error' || p.error_message).length;
  $('#pub-meta').innerHTML = `<b>${local.pubs.length}</b> publicaciones · <b>${local.unpublished.length}</b> sin publicar`;
  $('#pub-kpis').innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Activas</div><div class="kpi-value">${activas}</div><div class="kpi-sub">en línea</div></div>
    <div class="kpi-card"><div class="kpi-label">Vistas totales</div><div class="kpi-value">${fmt.compact(views)}</div><div class="kpi-sub">acumuladas</div></div>
    <div class="kpi-card ok"><div class="kpi-label">Consultas</div><div class="kpi-value">${fmt.compact(inq)}</div><div class="kpi-sub">leads generados</div></div>
    <div class="kpi-card ${errs ? 'danger' : ''}"><div class="kpi-label">Con error</div><div class="kpi-value">${errs}</div><div class="kpi-sub">${errs ? 'revisar sync' : 'sin errores'}</div></div>
  `;
}

function filtered() {
  if (local.filter === 'error') return local.pubs.filter(p => p.status === 'error' || p.error_message);
  if (local.filter === 'all') return local.pubs;
  return local.pubs.filter(p => p.channel === local.filter);
}

function renderList() {
  const host = $('#pub-list');
  const rows = filtered();
  if (!rows.length) {
    const msg = local.pubs.length
      ? 'No hay publicaciones para este filtro.'
      : 'Todavía no hay publicaciones. Conectá Mercado Libre e Instagram en Integraciones para empezar a publicar el stock automáticamente.';
    host.innerHTML = `<div class="empty-rich"><div class="er-icon">⇪</div><div class="er-title">Sin publicaciones</div><div class="er-desc">${msg}</div>${local.pubs.length ? '' : '<button class="btn" id="pub-go-int">Ir a Integraciones</button>'}</div>`;
    $('#pub-go-int')?.addEventListener('click', () => navigate('/integraciones'));
    return;
  }
  host.innerHTML = `<div class="cc-table-wrap"><table class="cc-table">
    <thead><tr><th>Unidad</th><th>Canal</th><th>Estado</th><th class="num">Vistas</th><th class="num">Consultas</th><th>Sync</th><th></th></tr></thead>
    <tbody>${rows.map(pubRow).join('')}</tbody></table></div>`;
  host.querySelectorAll('[data-open-unit]').forEach(b => b.addEventListener('click', () => navigate('/unidades/' + b.dataset.openUnit)));
  host.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => togglePublication(b.dataset.toggle, b.dataset.action, b.dataset.channel)));
}

function pubRow(p) {
  const u = p.unit || {};
  const paused = p.status === 'pausada';
  return `
    <tr class="${p.error_message ? 'row-danger' : ''}">
      <td>
        <div class="t-strong clickable" data-open-unit="${escapeHtml(u.unit_code || '')}" style="cursor:pointer">${escapeHtml([u.brand, u.model, u.year].filter(Boolean).join(' ') || 'Unidad')}</div>
        <div class="text-muted mono" style="font-size:10px">${escapeHtml(u.unit_code || '')}</div>
      </td>
      <td><span class="ch-tag ${CH_CLASS[p.channel] || ''}">${escapeHtml(CH_LABEL[p.channel] || p.channel)}</span></td>
      <td><span class="chip sm ${STATUS_CHIP[p.status] || ''}">${escapeHtml(fmt.humanize(p.status || ''))}</span>${p.error_message ? `<div class="text-muted" style="font-size:10px;margin-top:2px">${escapeHtml(fmt.truncate(p.error_message, 40))}</div>` : ''}</td>
      <td class="num">${fmt.compact(p.views || 0)}</td>
      <td class="num">${fmt.compact(p.inquiries || 0)}</td>
      <td class="text-muted mono" style="font-size:10px">${p.last_synced_at ? escapeHtml(fmt.relative(p.last_synced_at)) : '—'}</td>
      <td style="white-space:nowrap;text-align:right">
        ${p.url ? `<a class="ag-mini" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Ver</a>` : ''}
        <button class="ag-mini" data-toggle="${p.unit_id}" data-channel="${escapeHtml(p.channel)}" data-action="${paused ? 'publish' : 'pause'}">${paused ? 'Republicar' : 'Pausar'}</button>
      </td>
    </tr>
  `;
}

function renderGap() {
  const host = $('#pub-gap');
  if (!local.unpublished.length) { host.innerHTML = ''; return; }
  host.innerHTML = `
    <div class="pub-gap-block">
      <div class="pub-gap-hd">Unidades disponibles sin publicar <span>${local.unpublished.length}</span></div>
      <div class="pub-gap-list">
        ${local.unpublished.map(u => `
          <div class="pub-gap-item">
            <div>
              <div class="t-strong">${escapeHtml([u.brand, u.model, u.year].filter(Boolean).join(' '))}</div>
              <div class="text-muted mono" style="font-size:10px">${escapeHtml(u.unit_code)} · USD ${escapeHtml(fmt.usd(u.public_price))}</div>
            </div>
            <div style="display:flex;gap:6px">
              <button class="ag-mini" data-pub-ml="${u.id}">+ ML</button>
              <button class="ag-mini" data-pub-ig="${u.id}">+ IG</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  host.querySelectorAll('[data-pub-ml]').forEach(b => b.addEventListener('click', () => publishNew(b.dataset.pubMl, 'mercado_libre')));
  host.querySelectorAll('[data-pub-ig]').forEach(b => b.addEventListener('click', () => publishNew(b.dataset.pubIg, 'instagram')));
}

async function publishNew(unitId, channel) {
  toast('Publicando…', CHANNELS[channel]?.label, 'info');
  const r = await publishUnit(unitId, channel, 'publish');
  if (r.ok) { toast('Publicado', CHANNELS[channel]?.label, 'ok'); await load(); renderUI(); }
  else toast('No se pudo publicar', r.error || 'Edge Function no disponible', 'warn');
}

async function togglePublication(unitId, action, channel) {
  const ch = channel || filtered().find(p => p.unit_id === unitId)?.channel || 'mercado_libre';
  const r = await publishUnit(unitId, ch, action);
  if (r.ok) { toast(action === 'pause' ? 'Pausada' : 'Republicada', null, 'ok'); await load(); renderUI(); }
  else toast('Acción no aplicada', r.error || 'Edge Function no disponible', 'warn');
}

const styles = `
  .ch-tag { display: inline-flex; align-items: center; gap: 5px; font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; padding: 2px 7px; border: 1px solid var(--cc-line); }
  .ch-tag::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--cc-steel); }
  .ch-tag.ml::before { background: var(--cc-ml); }
  .ch-tag.ig::before { background: var(--cc-ig); }
  .cc-table .row-danger td { background: var(--cc-danger-soft); }
  a.ag-mini { text-decoration: none; display: inline-block; }

  .pub-gap-block { margin-top: 26px; background: var(--cc-surface); border: 1px solid var(--cc-line); }
  .pub-gap-hd { padding: 12px 16px; border-bottom: 1px solid var(--cc-line); background: var(--cc-bg-alt); font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; font-weight: 600; }
  .pub-gap-hd span { color: var(--cc-champagne); margin-left: 6px; }
  .pub-gap-item { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--cc-line-soft); }
  .pub-gap-item:last-child { border-bottom: none; }
`;
