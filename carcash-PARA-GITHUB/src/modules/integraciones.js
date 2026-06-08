// ============================================================
// CARCASH · MÓDULO HUBS DE INTEGRACIONES
// Rutas:
//   /integraciones          → vista general
//   /integraciones/:hub     → configuración del hub específico
// Solo admin.
//
// Hubs soportados:
//   - whatsapp (360dialog)
//   - mercadolibre
//   - instagram
//   - meta_ads
// ============================================================

import { supabase, SUPABASE_URL } from '../lib/supabase-client.js';
import { state, isAdmin } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles } from '../lib/dom.js';
import { navigate } from '../lib/router.js';
import { fetchInstagramInsights } from '../lib/ig-insights.js';

// ============================================================
// CONFIG: Definición de cada hub
// ============================================================
const HUBS = {
  whatsapp: {
    id: 'whatsapp',
    label: 'WhatsApp (Meta + n8n)',
    provider: 'Automatizado con n8n',
    color: 'var(--cc-wsp)',
    icon: '●',
    description: 'WhatsApp ya está automatizado con Meta y n8n. n8n escribe los mensajes entrantes en el CRM (aparecen en la Bandeja) y, al responder desde la app, el mensaje sale de nuevo por n8n → Meta. Las conversaciones se ven completas dentro del CRM.',
    env_var: 'N8N_WSP_SEND_URL',
    webhook_path: '/.netlify/functions/wsp-inbound',
    webhook_label: 'URL para que n8n postee los mensajes entrantes',
    docs_url: 'https://docs.n8n.io/integrations/builtin/credentials/whatsapp/',
    setup_steps: [
      'En n8n: cuando llega un WhatsApp de Meta, agregar un nodo HTTP Request',
      'POST a https://TU-SITIO.netlify.app/.netlify/functions/wsp-inbound con { phone, name, text, direction }',
      'Mandar el header X-CarCash-Secret = N8N_SHARED_SECRET',
      'Para el envío saliente: crear un Webhook en n8n que reciba { to, text } y lo mande por la API de Meta',
      'Pegar esa URL del webhook de n8n en Netlify como N8N_WSP_SEND_URL',
      'Listo: las conversaciones entran y salen desde la Bandeja del CRM',
    ],
    config_fields: [
      { id: 'n8n_send_url', label: 'Webhook de n8n para enviar (N8N_WSP_SEND_URL)', placeholder: 'https://n8n.tu-dominio/webhook/...', env: 'N8N_WSP_SEND_URL' },
      { id: 'shared_secret', label: 'Secreto compartido CRM ↔ n8n', placeholder: 'String aleatorio', env: 'N8N_SHARED_SECRET' },
    ],
  },
  mercadolibre: {
    id: 'mercadolibre',
    label: 'Mercado Libre',
    provider: 'API oficial',
    color: 'var(--cc-ml)',
    icon: '◆',
    description: 'Sincronizá publicaciones de autos en Mercado Libre y recibí leads automáticamente como oportunidades nuevas.',
    env_var: 'ML_ACCESS_TOKEN',
    webhook_path: '/.netlify/functions/ml-webhook',
    webhook_label: 'Webhook de notificaciones ML',
    docs_url: 'https://developers.mercadolibre.com.ar/devcenter',
    setup_steps: [
      'Crear app en Developers de Mercado Libre',
      'Obtener Client ID y Secret',
      'Hacer OAuth para obtener Access Token y Refresh Token',
      'Pegar las credenciales en Netlify (ML_ACCESS_TOKEN, ML_REFRESH_TOKEN, ML_USER_ID)',
      'Configurar la URL del webhook en la app de ML',
      'Suscribirse a topics: "questions", "orders", "items"',
    ],
    config_fields: [
      { id: 'user_id', label: 'User ID de Mercado Libre', placeholder: 'Ej: 123456789', env: 'ML_USER_ID' },
      { id: 'app_id', label: 'App ID', placeholder: 'Tu App ID' },
    ],
  },
  instagram: {
    id: 'instagram',
    label: 'Instagram',
    provider: 'Meta Graph API',
    color: 'var(--cc-ig)',
    icon: '◉',
    description: 'Recibí DMs de Instagram en la bandeja y respondé desde el CRM. Requiere cuenta de empresa vinculada a Facebook.',
    env_var: 'META_ACCESS_TOKEN',
    webhook_path: '/.netlify/functions/ig-webhook',
    webhook_label: 'Webhook de Meta para Instagram',
    docs_url: 'https://developers.facebook.com/docs/instagram-api',
    setup_steps: [
      'Tener cuenta Instagram Business vinculada a una página de Facebook',
      'Crear app en developers.facebook.com',
      'Configurar permisos: instagram_basic, instagram_manage_messages, pages_manage_metadata',
      'Obtener Access Token de larga duración',
      'Pegar en Netlify (META_ACCESS_TOKEN, META_INSTAGRAM_ACCOUNT_ID)',
      'Suscribir a webhook events: messages, messaging_postbacks',
    ],
    config_fields: [
      { id: 'instagram_account_id', label: 'Instagram Account ID', env: 'META_INSTAGRAM_ACCOUNT_ID' },
      { id: 'page_id', label: 'Facebook Page ID', placeholder: 'ID de la página vinculada' },
    ],
  },
  meta_ads: {
    id: 'meta_ads',
    label: 'Meta Ads (Facebook + Instagram)',
    provider: 'Meta Marketing API',
    color: 'var(--cc-meta)',
    icon: '▲',
    description: 'Sincronizá leads de campañas de Lead Ads de Meta directamente al pipeline.',
    env_var: 'META_ACCESS_TOKEN',
    webhook_path: '/.netlify/functions/meta-leads-webhook',
    webhook_label: 'Webhook de Lead Ads',
    docs_url: 'https://developers.facebook.com/docs/marketing-api/guides/lead-ads',
    setup_steps: [
      'En Business Manager, asociar tu cuenta de Ads a la app',
      'Configurar formularios de Lead Ads',
      'Crear webhook subscription para topic "leadgen"',
      'Pegar en Netlify (META_ACCESS_TOKEN, META_AD_ACCOUNT_ID)',
      'El webhook recibe automáticamente cada lead nuevo',
    ],
    config_fields: [
      { id: 'ad_account_id', label: 'Ad Account ID', placeholder: 'act_xxxxxxxxx', env: 'META_AD_ACCOUNT_ID' },
      { id: 'lead_form_ids', label: 'Lead Form IDs (CSV)', placeholder: 'form1,form2,form3' },
    ],
  },
};

const local = {
  hubId: null,
  status: {},   // { hubId: { configured: bool, hint, length } }
  metrics: {},  // métricas por hub
  fetchError: null,
};

// ============================================================
// MOUNT
// ============================================================
export async function mount(params = {}) {
  injectStyles('integraciones-styles', styles);

  if (!isAdmin()) {
    $('#view').innerHTML = `<div class="placeholder"><div class="placeholder-content">
      <div class="placeholder-num">×</div>
      <div class="placeholder-title">Acceso <i>restringido</i></div>
      <div class="placeholder-status">NO AUTORIZADO</div>
    </div></div>`;
    return;
  }

  local.hubId = params.hub || null;
  await loadStatus();
  await loadMetrics();

  if (local.hubId) {
    if (!HUBS[local.hubId]) {
      navigate('/integraciones');
      return;
    }
    renderHubDetail();
  } else {
    renderOverview();
  }
}

export default mount;

// ============================================================
// FETCH
// ============================================================
async function loadStatus() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    const res = await fetch('/.netlify/functions/integrations-status', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const json = await res.json();
    const map = {};
    (json.integrations || []).forEach(i => { map[i.id] = i; });
    local.status = map;
    local.fetchError = null;
  } catch (err) {
    console.warn('integrations-status fallo', err);
    local.status = {};
    local.fetchError = err.message;
  }
}

async function loadMetrics() {
  // Métricas básicas: leads recibidos por origen en últimos 30 días
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const { data } = await supabase
    .from('opportunities')
    .select('origin, stage')
    .gte('created_at', since)
    .is('deleted_at', null);

  const ORIGIN_TO_HUB = {
    whatsapp: 'whatsapp',
    mercado_libre: 'mercadolibre',
    instagram: 'instagram',
    meta_ads: 'meta_ads',
  };

  const m = {};
  for (const o of data || []) {
    const hub = ORIGIN_TO_HUB[o.origin];
    if (!hub) continue;
    if (!m[hub]) m[hub] = { leads: 0, won: 0 };
    m[hub].leads++;
    if (o.stage === 'ganada') m[hub].won++;
  }
  local.metrics = m;

  // Publicaciones activas (para ML)
  const { data: pubs } = await supabase
    .from('publications')
    .select('id, channel, status')
    .eq('status', 'activa');
  if (pubs) {
    const mlPubs = pubs.filter(p => p.channel === 'mercado_libre').length;
    if (mlPubs > 0) {
      local.metrics.mercadolibre = local.metrics.mercadolibre || { leads: 0, won: 0 };
      local.metrics.mercadolibre.publications = mlPubs;
    }
  }
}

// ============================================================
// VISTA: OVERVIEW
// ============================================================
function renderOverview() {
  const hubs = Object.values(HUBS);
  $('#view').innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">MÓDULO 15 · DIRECCIÓN</div>
          <div class="page-title">Hubs de <i>integraciones</i></div>
          <div class="page-sub">Conectá WhatsApp, Mercado Libre, Instagram y Meta Ads · Los leads entran solos al pipeline</div>
        </div>
      </div>
    </div>

    ${local.fetchError ? `
      <div class="int-warning">
        <b>⚠ La Edge Function de estado todavía no está deployada.</b> Mostrando todos los hubs como "no configurados". Cuando deployes el repo a Netlify con las env vars correspondientes, esta vista refleja el estado real.
      </div>
    ` : ''}

    <div class="hubs-grid">
      ${hubs.map(hubCard).join('')}
    </div>
  `;

  $('.hubs-grid').addEventListener('click', (e) => {
    const card = e.target.closest('.hub-card');
    if (!card) return;
    navigate(`/integraciones/${card.dataset.hub}`);
  });
}

function hubCard(h) {
  const status = local.status[h.id];
  const configured = status?.configured;
  const metrics = local.metrics[h.id] || { leads: 0, won: 0 };

  return `
    <div class="hub-card" data-hub="${h.id}" style="--hub-color: ${h.color}">
      <div class="hub-card-hd">
        <div class="hub-icon" style="color: ${h.color}">${h.icon}</div>
        <div class="hub-status status-${configured ? 'ok' : 'pending'}">
          ${configured ? '✓ Conectado' : '○ Pendiente'}
        </div>
      </div>
      <div class="hub-label">${escapeHtml(h.label)}</div>
      <div class="hub-provider">${escapeHtml(h.provider)}</div>
      <div class="hub-desc">${escapeHtml(h.description)}</div>
      <div class="hub-stats">
        <div class="hub-stat">
          <div class="hub-stat-value">${metrics.leads}</div>
          <div class="hub-stat-label">leads (30d)</div>
        </div>
        <div class="hub-stat">
          <div class="hub-stat-value">${metrics.won}</div>
          <div class="hub-stat-label">ventas</div>
        </div>
        ${metrics.publications !== undefined ? `
          <div class="hub-stat">
            <div class="hub-stat-value">${metrics.publications}</div>
            <div class="hub-stat-label">publicaciones</div>
          </div>
        ` : ''}
      </div>
      <div class="hub-action">
        Configurar →
      </div>
    </div>
  `;
}

// ============================================================
// VISTA: HUB DETALLE
// ============================================================
function renderHubDetail() {
  const h = HUBS[local.hubId];
  const status = local.status[h.id];
  const configured = status?.configured;
  const webhookFullUrl = window.location.origin + h.webhook_path;

  $('#view').innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="hub-back"><a data-route="/integraciones">← Hubs</a></div>
          <div class="page-num" style="color: ${h.color}">${h.icon} ${escapeHtml(h.provider.toUpperCase())}</div>
          <div class="page-title"><i>${escapeHtml(h.label)}</i></div>
          <div class="page-sub">${escapeHtml(h.description)}</div>
        </div>
        <div class="page-actions">
          <span class="hub-status-big status-${configured ? 'ok' : 'pending'}">
            ${configured ? '✓ Conectado' : '○ No configurado'}
          </span>
        </div>
      </div>
    </div>

    <div class="hub-detail">
      <!-- ESTADO Y WEBHOOK -->
      <div class="hub-section">
        <div class="hub-section-hd">Estado de conexión</div>
        <div class="hub-section-body">
          <div class="status-rows">
            <div class="status-row">
              <span>API Key (env var <code>${escapeHtml(h.env_var)}</code>)</span>
              <b>${configured ? `✓ Configurada · ${escapeHtml(status.hint || '••••')}` : '✗ No configurada en Netlify'}</b>
            </div>
            <div class="status-row">
              <span>Webhook URL</span>
              <b class="webhook-url" id="webhook-url">${escapeHtml(webhookFullUrl)}</b>
            </div>
          </div>
          <div class="webhook-actions">
            <button class="btn btn-ghost btn-sm" id="btn-copy-webhook">⧉ Copiar URL</button>
            <a class="btn btn-ghost btn-sm" href="${escapeHtml(h.docs_url)}" target="_blank" rel="noopener">📖 Documentación oficial →</a>
            ${configured ? `<button class="btn btn-sm" id="btn-test">Probar conexión</button>` : ''}
          </div>
        </div>
      </div>

      <!-- PASOS DE CONFIGURACIÓN -->
      <div class="hub-section">
        <div class="hub-section-hd">Cómo conectar</div>
        <div class="hub-section-body">
          <ol class="setup-steps">
            ${h.setup_steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}
          </ol>
        </div>
      </div>

      <!-- CAMPOS ADICIONALES -->
      <div class="hub-section">
        <div class="hub-section-hd">Variables adicionales</div>
        <div class="hub-section-body">
          <div class="config-fields">
            ${h.config_fields.map(f => `
              <div class="cfg-field-row">
                <div class="cff-info">
                  <div class="cff-label">${escapeHtml(f.label)}</div>
                  ${f.env ? `<div class="cff-env">env: <code>${escapeHtml(f.env)}</code></div>` : ''}
                  ${f.placeholder ? `<div class="cff-hint">${escapeHtml(f.placeholder)}</div>` : ''}
                </div>
                <div class="cff-status">
                  ${f.env && local.status[f.env]?.configured ? '✓ OK' : (f.env ? '○ Pendiente' : 'Manual')}
                </div>
              </div>
            `).join('')}
          </div>
          <div class="cfg-help">
            Agregá las env vars en Netlify → Site settings → Environment variables.
            Después tirá un nuevo deploy para que las Edge Functions tomen los valores.
          </div>
        </div>
      </div>

      <!-- MÉTRICAS DEL HUB -->
      <div class="hub-section">
        <div class="hub-section-hd">Performance · últimos 30 días</div>
        <div class="hub-section-body">
          <div class="hub-perf">
            <div class="hub-perf-stat">
              <div class="hub-perf-num">${local.metrics[h.id]?.leads || 0}</div>
              <div class="hub-perf-lbl">Leads recibidos</div>
            </div>
            <div class="hub-perf-stat">
              <div class="hub-perf-num">${local.metrics[h.id]?.won || 0}</div>
              <div class="hub-perf-lbl">Ventas cerradas</div>
            </div>
            <div class="hub-perf-stat">
              <div class="hub-perf-num">${local.metrics[h.id]?.leads > 0 ? Math.round((local.metrics[h.id].won / local.metrics[h.id].leads) * 100) : 0}%</div>
              <div class="hub-perf-lbl">Tasa de conversión</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  $('#btn-copy-webhook').addEventListener('click', () => {
    navigator.clipboard?.writeText(webhookFullUrl);
    toast('URL copiada', null, 'ok');
  });
  $('#btn-test')?.addEventListener('click', () => testHub(h.id));

  // Panel de estadísticas de Instagram (Meta Graph API · mock si no hay deploy)
  if (h.id === 'instagram') renderInstagramInsights();
}

// ============================================================
// INSTAGRAM INSIGHTS
// ============================================================
let igPeriod = '28d';
async function renderInstagramInsights() {
  const detail = document.querySelector('.hub-detail');
  if (!detail) return;
  let host = document.getElementById('ig-insights');
  if (!host) {
    host = el('div', { class: 'hub-section', id: 'ig-insights' });
    detail.insertBefore(host, detail.firstChild);
  }
  host.innerHTML = `
    <div class="hub-section-hd">
      Estadísticas de Instagram
      <span class="ig-seg seg" style="float:right;margin-top:-3px">
        <button data-p="7d" class="${igPeriod==='7d'?'active':''}">7 días</button>
        <button data-p="28d" class="${igPeriod==='28d'?'active':''}">28 días</button>
      </span>
    </div>
    <div class="hub-section-body" id="ig-body"><div class="empty">Cargando insights…</div></div>
  `;
  host.querySelector('.ig-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-p]'); if (!b) return;
    igPeriod = b.dataset.p; renderInstagramInsights();
  });

  let data;
  try { data = await fetchInstagramInsights(igPeriod); }
  catch (err) { document.getElementById('ig-body').innerHTML = `<div class="int-warning">No se pudieron traer las estadísticas: ${escapeHtml(err.message)}</div>`; return; }

  const t = data.totals || {};
  const p = data.profile || {};
  const series = data.series || [];
  const body = document.getElementById('ig-body');
  body.innerHTML = `
    ${data._mock ? `<div class="ig-mock-note">◉ Datos de demostración. Conectá la cuenta (env vars de Meta + deploy de la function <code>ig-insights</code>) para ver métricas reales.</div>` : ''}
    <div class="ig-profile">
      <div class="ig-ava">${escapeHtml((p.username||'ig').slice(0,2).toUpperCase())}</div>
      <div>
        <div class="ig-username">@${escapeHtml(p.username||'—')}</div>
        <div class="ig-pmeta">${fmt.compact(p.followers||0)} seguidores · ${fmt.compact(p.media_count||0)} posts</div>
      </div>
    </div>
    <div class="ig-kpis">
      ${igKpi('Alcance', fmt.compact(t.reach||0), t.period)}
      ${igKpi('Impresiones', fmt.compact(t.impressions||0), t.period)}
      ${igKpi('Visitas al perfil', fmt.compact(t.profile_views||0), t.period)}
      ${igKpi('Nuevos seguidores', '+'+fmt.compact(t.new_followers||0), t.period)}
      ${igKpi('Engagement', (t.engagement_rate??0)+'%', 'promedio')}
      ${igKpi('Leads desde IG', fmt.compact(t.leads_from_ig||0), 'al pipeline')}
    </div>
    ${series.length ? `<div class="ig-chart">${sparkline(series.map(s=>s.followers))}<div class="ig-chart-lbl">Crecimiento de seguidores · ${t.period}</div></div>` : ''}
    ${(data.top_media||[]).length ? `
      <div class="ig-top-hd">Posts con mejor rendimiento</div>
      <div class="ig-top">
        ${data.top_media.map(m => `
          <div class="ig-post">
            <div class="ig-post-type">${({IMAGE:'▣',VIDEO:'▶',CAROUSEL_ALBUM:'❑'})[m.media_type]||'▣'}</div>
            <div class="ig-post-cap">${escapeHtml(fmt.truncate(m.caption,60))}</div>
            <div class="ig-post-stats"><span>♥ ${fmt.compact(m.like_count)}</span><span>✎ ${fmt.compact(m.comments_count)}</span><span>⤓ ${fmt.compact(m.saved||0)}</span><span>↗ ${fmt.compact(m.reach)}</span></div>
          </div>
        `).join('')}
      </div>
    ` : ''}
  `;
}

function igKpi(label, value, sub) {
  return `<div class="ig-kpi"><div class="ig-kpi-val">${value}</div><div class="ig-kpi-lbl">${escapeHtml(label)}</div>${sub?`<div class="ig-kpi-sub">${escapeHtml(sub)}</div>`:''}</div>`;
}

function sparkline(values) {
  if (!values.length) return '';
  const w=520, h=70, min=Math.min(...values), max=Math.max(...values), span=(max-min)||1;
  const pts=values.map((v,i)=>{const x=(i/(values.length-1))*w; const y=h-((v-min)/span)*(h-8)-4; return `${x.toFixed(1)},${y.toFixed(1)}`;});
  const area=`0,${h} ${pts.join(' ')} ${w},${h}`;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="ig-svg"><polygon points="${area}" fill="rgba(225,48,108,0.08)"/><polyline points="${pts.join(' ')}" fill="none" stroke="var(--cc-ig)" stroke-width="2"/></svg>`;
}

async function testHub(hubId) {
  toast('Probando…', hubId, 'info');
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    const res = await fetch(`/.netlify/functions/test-integration?name=${hubId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      toast('Test no disponible', 'La Edge Function de test todavía no está deployada', 'warn');
      return;
    }
    const json = await res.json();
    if (json.ok) toast('✓ Conectado', json.message || 'OK', 'ok');
    else toast('✗ Error', json.error || 'No se pudo conectar', 'error');
  } catch (err) {
    toast('Test no disponible', err.message, 'warn');
  }
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
  .page-sub { font-size: 12px; color: var(--cc-muted); margin-top: 6px; line-height: 1.5; max-width: 600px; }
  .page-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

  .hub-back { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.18em; margin-bottom: 8px; }
  .hub-back a { color: var(--cc-muted); text-decoration: none; cursor: pointer; }
  .hub-back a:hover { color: var(--cc-ink); }

  .int-warning {
    background: var(--cc-warn-soft); border: 1px solid var(--cc-warn); color: var(--cc-warn);
    padding: 12px 20px; font-size: 12px; margin: 16px 20px 0; line-height: 1.5;
  }
  @container app (min-width: 900px) { .int-warning { margin: 18px 32px 0; } }

  /* OVERVIEW */
  .hubs-grid {
    padding: 22px 20px 32px;
    display: grid;
    grid-template-columns: 1fr;
    gap: 14px;
  }
  @container app (min-width: 700px) { .hubs-grid { grid-template-columns: repeat(2, 1fr); padding: 22px 32px 40px; } }
  @container app (min-width: 1100px) { .hubs-grid { grid-template-columns: repeat(2, 1fr); } }

  .hub-card {
    background: var(--cc-surface);
    border: 1px solid var(--cc-line);
    padding: 18px 20px;
    cursor: pointer;
    transition: all 0.15s;
    position: relative;
    overflow: hidden;
  }
  .hub-card::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--hub-color);
  }
  .hub-card:hover { border-color: var(--cc-ink); transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.06); }
  .hub-card-hd { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .hub-icon { font-size: 28px; line-height: 1; }
  .hub-status, .hub-status-big {
    font-family: var(--cc-font-mono); font-size: 9px;
    padding: 3px 8px; letter-spacing: 0.18em; text-transform: uppercase; font-weight: 600;
  }
  .hub-status.status-ok, .hub-status-big.status-ok { background: var(--cc-ok-soft); color: var(--cc-ok); border: 1px solid var(--cc-ok); }
  .hub-status.status-pending, .hub-status-big.status-pending { background: var(--cc-bg-alt); color: var(--cc-muted); border: 1px solid var(--cc-line); }
  .hub-status-big { font-size: 11px; padding: 6px 14px; }
  .hub-label { font-family: var(--cc-font-display); font-weight: 400; font-size: 22px; letter-spacing: -0.01em; }
  .hub-provider { font-family: var(--cc-font-mono); font-size: 9px; color: var(--cc-champagne); letter-spacing: 0.2em; text-transform: uppercase; margin-top: 2px; margin-bottom: 10px; font-weight: 600; }
  .hub-desc { font-size: 12px; color: var(--cc-muted); line-height: 1.5; margin-bottom: 14px; }
  .hub-stats { display: flex; gap: 18px; padding: 12px 0; border-top: 1px solid var(--cc-line-soft); border-bottom: 1px solid var(--cc-line-soft); margin-bottom: 12px; }
  .hub-stat-value { font-family: var(--cc-font-mono); font-weight: 600; font-size: 16px; }
  .hub-stat-label { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--cc-muted); margin-top: 2px; }
  .hub-action { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--cc-ink); font-weight: 600; }

  /* DETAIL */
  .hub-detail { padding: 22px 20px 32px; max-width: 920px; }
  @container app (min-width: 900px) { .hub-detail { padding: 22px 32px 40px; } }
  .hub-section { background: var(--cc-surface); border: 1px solid var(--cc-line); margin-bottom: 16px; }
  .hub-section-hd { padding: 12px 16px; border-bottom: 1px solid var(--cc-line-soft); font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; font-weight: 600; }
  .hub-section-body { padding: 16px; }

  .status-rows { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
  .status-row { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; font-size: 12px; flex-wrap: wrap; }
  .status-row span { color: var(--cc-muted); }
  .status-row b { font-weight: 500; }
  .status-row code { font-family: var(--cc-font-mono); background: var(--cc-bg-alt); padding: 1px 6px; font-size: 11px; }
  .webhook-url { font-family: var(--cc-font-mono); font-size: 11px; padding: 4px 8px; background: var(--cc-bg-alt); border: 1px solid var(--cc-line); word-break: break-all; }
  .webhook-actions { display: flex; gap: 8px; flex-wrap: wrap; padding-top: 10px; border-top: 1px solid var(--cc-line-soft); }

  .setup-steps { padding-left: 22px; margin: 0; }
  .setup-steps li { padding: 5px 0; font-size: 13px; line-height: 1.5; color: var(--cc-ink-soft); }

  .config-fields { display: flex; flex-direction: column; }
  .cfg-field-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--cc-line-soft); align-items: center; gap: 14px; }
  .cfg-field-row:last-child { border-bottom: none; }
  .cff-info { flex: 1; min-width: 0; }
  .cff-label { font-weight: 500; font-size: 13px; }
  .cff-env { font-size: 11px; color: var(--cc-muted); margin-top: 2px; }
  .cff-env code { font-family: var(--cc-font-mono); background: var(--cc-bg-alt); padding: 1px 5px; font-size: 10px; }
  .cff-hint { font-size: 11px; color: var(--cc-muted); margin-top: 2px; font-style: italic; }
  .cff-status { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.1em; padding: 4px 10px; background: var(--cc-bg-alt); border: 1px solid var(--cc-line); white-space: nowrap; }
  .cfg-help { padding-top: 14px; margin-top: 14px; border-top: 1px solid var(--cc-line-soft); font-size: 11px; color: var(--cc-muted); line-height: 1.5; }

  .hub-perf { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--cc-line); border: 1px solid var(--cc-line); }
  .hub-perf-stat { background: var(--cc-bg-alt); padding: 14px; text-align: center; }
  .hub-perf-num { font-family: var(--cc-font-display); font-weight: 400; font-size: 26px; line-height: 1; }
  .hub-perf-lbl { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--cc-muted); margin-top: 4px; }

  /* INSTAGRAM INSIGHTS */
  #ig-insights .seg button { padding: 5px 10px; font-size: 9px; }
  .ig-mock-note { font-size: 11px; color: var(--cc-muted); background: var(--cc-bg-alt); border-left: 2px solid var(--cc-ig); padding: 8px 10px; margin-bottom: 14px; line-height: 1.5; }
  .ig-mock-note code { font-family: var(--cc-font-mono); font-size: 10px; }
  .ig-profile { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .ig-ava { width: 46px; height: 46px; border-radius: 50%; background: linear-gradient(135deg, #F58529, var(--cc-ig), #8134AF); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; }
  .ig-username { font-weight: 600; font-size: 14px; }
  .ig-pmeta { font-size: 11px; color: var(--cc-muted); font-family: var(--cc-font-mono); }
  .ig-kpis { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1px; background: var(--cc-line); border: 1px solid var(--cc-line); margin-bottom: 18px; }
  @container app (min-width: 640px) { .ig-kpis { grid-template-columns: repeat(3, 1fr); } }
  .ig-kpi { background: var(--cc-surface); padding: 13px 14px; }
  .ig-kpi-val { font-family: var(--cc-font-display); font-weight: 400; font-size: 24px; line-height: 1; }
  .ig-kpi-lbl { font-size: 11px; color: var(--cc-ink-soft); margin-top: 5px; font-weight: 500; }
  .ig-kpi-sub { font-family: var(--cc-font-mono); font-size: 8px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--cc-muted); margin-top: 2px; }
  .ig-chart { margin-bottom: 18px; }
  .ig-svg { width: 100%; height: 70px; display: block; background: var(--cc-bg); border: 1px solid var(--cc-line-soft); }
  .ig-chart-lbl { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--cc-muted); margin-top: 6px; text-align: center; }
  .ig-top-hd { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--cc-muted); font-weight: 600; margin-bottom: 10px; }
  .ig-top { display: grid; grid-template-columns: 1fr; gap: 1px; background: var(--cc-line); border: 1px solid var(--cc-line); }
  @container app (min-width: 700px) { .ig-top { grid-template-columns: 1fr 1fr; } }
  .ig-post { background: var(--cc-surface); padding: 12px 14px; display: flex; gap: 10px; align-items: flex-start; }
  .ig-post-type { font-size: 16px; color: var(--cc-ig); flex-shrink: 0; }
  .ig-post-cap { font-size: 12px; line-height: 1.4; flex: 1; }
  .ig-post-stats { display: flex; gap: 10px; flex-wrap: wrap; font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); margin-top: 4px; }
  .ig-post { flex-wrap: wrap; }
`;
