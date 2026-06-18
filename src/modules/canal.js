// ============================================================
// CARCASH · MÓDULOS DE CANAL  (ruta /canal/:channel)
// Un centro de control por canal: WhatsApp, Instagram y Mercado
// Libre. Reúne en un solo lugar las conversaciones/publicaciones,
// los leads y las métricas de ese canal. La Bandeja sigue siendo
// la vista unificada de todos los canales juntos.
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { state, isSupervisorOrAdmin, currentUserId } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles } from '../lib/dom.js';
import { navigate } from '../lib/router.js';
import { fetchInstagramInsights, fetchCompetitorInsights, fetchInstagramInbox, fetchInstagramComments, suggestCompetitors, analyzePost } from '../lib/ig-insights.js';

const CFG = {
  whatsapp:     { label: 'WhatsApp',      channel: 'whatsapp',      origin: 'whatsapp',      num: 'C1', kind: 'chat' },
  instagram:    { label: 'Instagram',     channel: 'instagram',     origin: 'instagram',     num: 'C2', kind: 'chat' },
  mercadolibre: { label: 'Mercado Libre', channel: 'mercado_libre', origin: 'mercado_libre', num: 'C3', kind: 'market' },
};

export async function mount(params = {}) {
  injectStyles('canal-styles', styles);
  const cfg = CFG[params.channel];
  if (!cfg) { navigate('/tablero'); return; }
  renderShell(cfg, params.channel);
  try {
    if (cfg.kind === 'market') await renderMarket(cfg);
    else if (params.channel === 'instagram') await renderInstagram(cfg);
    else await renderChat(cfg, params.channel);
  } catch (err) {
    console.error('canal', err);
    $('#canal-body').innerHTML = `<div class="empty-rich"><div class="er-title">No se pudo cargar el canal</div><div class="er-desc">${escapeHtml(err.message)}</div></div>`;
  }
}
export default mount;

function renderShell(cfg, key) {
  $('#view').innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">CANAL ${cfg.num}</div>
          <div class="page-title canal-title canal-${key}">${escapeHtml(cfg.label)}</div>
          <div class="page-sub" id="canal-sub">Cargando…</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-ghost" onclick="location.hash='#/bandeja'">Ver bandeja unificada</button>
          <button class="btn btn-ghost" id="canal-refresh">Actualizar</button>
        </div>
      </div>
      <div class="kpi-grid" id="canal-kpis"></div>
    </div>
    <div class="page-body" id="canal-body"><div class="empty">Cargando…</div></div>
  `;
  $('#canal-refresh').addEventListener('click', () => mount({ channel: key }));
}

// ============================================================
// CHAT (WhatsApp / Instagram)
// ============================================================
async function renderChat(cfg, key) {
  // WhatsApp → Chatwoot embebido
  if (key === 'whatsapp') {
    $('#canal-sub').innerHTML = 'Bandeja de mensajes en tiempo real';
    $('#canal-kpis').innerHTML = '';
    const body = $('#canal-body');
    body.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:calc(100vh - 200px);gap:24px;">
        <div style="font-size:48px;">💬</div>
        <div style="font-size:20px;font-weight:600;color:var(--cc-text)">Chatwoot — Bandeja de WhatsApp</div>
        <div style="color:var(--cc-muted);text-align:center;max-width:400px">Abrí Chatwoot en una ventana separada para gestionar tus conversaciones de WhatsApp.</div>
        <button class="btn btn-primary" id="open-chatwoot-btn" style="padding:12px 32px;font-size:16px;">
          Abrir Chatwoot
        </button>
      </div>`;
    $('#open-chatwoot-btn').addEventListener('click', () => {
      window.open('https://carcash.juanmagne.com/app', 'chatwoot', 'width=1200,height=800,left=100,top=100');
    });
    return;
  }

  // Conversaciones del canal (Instagram / otros)
  const { data: evs, error } = await supabase
    .from('timeline_events')
    .select('id, channel, direction, body, title, event_at, opportunity:opportunities!opportunity_id(id, opp_code, stage, assigned_to, contact:contacts!contact_id(id, full_name, phone))')
    .eq('channel', cfg.channel)
    .order('event_at', { ascending: false })
    .limit(300);
  if (error) throw error;

  // Agrupar por contacto
  const byC = new Map();
  let today = new Date(); today.setHours(0, 0, 0, 0);
  let msgsToday = 0;
  for (const ev of evs || []) {
    const c = ev.opportunity?.contact; if (!c) continue;
    if (new Date(ev.event_at) >= today) msgsToday++;
    if (!byC.has(c.id)) byC.set(c.id, { contact: c, last: ev, count: 0, oppCode: ev.opportunity?.opp_code, stage: ev.opportunity?.stage });
    byC.get(c.id).count++;
  }
  const convs = Array.from(byC.values());
  const unread = convs.filter(c => c.last?.direction === 'entrante').length;

  // Leads del canal
  const { count: leadsCount } = await supabase.from('opportunities')
    .select('id', { count: 'exact', head: true }).eq('origin', cfg.origin).is('deleted_at', null);
  const { count: wonCount } = await supabase.from('opportunities')
    .select('id', { count: 'exact', head: true }).eq('origin', cfg.origin).eq('stage', 'ganada').is('deleted_at', null);

  $('#canal-sub').innerHTML = `<b>${convs.length}</b> conversaciones · <b>${leadsCount || 0}</b> leads por este canal`;
  $('#canal-kpis').innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Conversaciones</div><div class="kpi-value">${convs.length}</div><div class="kpi-sub">con actividad</div></div>
    <div class="kpi-card ${unread ? 'warn' : ''}"><div class="kpi-label">Sin responder</div><div class="kpi-value">${unread}</div><div class="kpi-sub">esperan respuesta</div></div>
    <div class="kpi-card"><div class="kpi-label">Mensajes hoy</div><div class="kpi-value">${msgsToday}</div><div class="kpi-sub">entrada + salida</div></div>
    <div class="kpi-card ok"><div class="kpi-label">Leads / ventas</div><div class="kpi-value">${leadsCount || 0}<span style="font-size:14px;color:var(--cc-muted)"> / ${wonCount || 0}</span></div><div class="kpi-sub">generados por el canal</div></div>
  `;

  const body = $('#canal-body');
  body.innerHTML = '';

  // Lista de conversaciones
  const listHost = el('div', { class: 'canal-section' },
    el('div', { class: 'canal-section-hd' }, 'Conversaciones recientes'),
    el('div', { class: 'canal-section-body', id: 'canal-convs' }));
  body.appendChild(listHost);

  const host = $('#canal-convs');
  if (!convs.length) {
    host.innerHTML = `<div class="empty-rich"><div class="er-icon">${key === 'instagram' ? '◉' : '●'}</div><div class="er-title">Sin conversaciones todavía</div><div class="er-desc">Cuando entren mensajes por ${escapeHtml(cfg.label)} van a aparecer acá y en la Bandeja.</div></div>`;
    return;
  }
  host.innerHTML = `<div class="cc-table-wrap"><table class="cc-table">
    <thead><tr><th>Contacto</th><th>Último mensaje</th><th>Etapa</th><th class="num">Msgs</th><th></th></tr></thead>
    <tbody>${convs.map(c => `
      <tr class="clickable" data-cid="${c.contact.id}">
        <td class="t-strong">${escapeHtml(c.contact.full_name || 'Sin nombre')}${c.last?.direction === 'entrante' ? ' <span class="chip sm warn">sin responder</span>' : ''}</td>
        <td class="text-muted">${escapeHtml(fmt.truncate(c.last?.body || c.last?.title || '—', 48))}<div class="text-muted mono" style="font-size:10px">${escapeHtml(fmt.relative(c.last?.event_at))}</div></td>
        <td><span class="chip sm">${escapeHtml(fmt.humanize(c.stage || '—'))}</span></td>
        <td class="num">${c.count}</td>
        <td style="text-align:right"><button class="ag-mini" data-open="${c.contact.id}">Abrir</button></td>
      </tr>`).join('')}</tbody></table></div>`;
  host.querySelectorAll('[data-cid], [data-open]').forEach(elm => elm.addEventListener('click', (e) => {
    const id = elm.dataset.open || elm.dataset.cid; if (id) navigate('/bandeja/' + id);
  }));
}

let igData = null;
const ig = { feed: [], tab: 'stats', cfg: null };

async function renderInstagram(cfg) {
  ig.cfg = cfg; ig.tab = 'stats';
  const d = await fetchInstagramInsights('28d').catch(() => null);
  igData = d; ig.feed = (d && d.feed) ? d.feed.slice() : [];
  const p = d?.profile || {}, t = d?.totals || {};
  $('#canal-sub').innerHTML = d?._mock ? 'Datos de demostración · se vuelven reales al conectar la cuenta' : `@${escapeHtml(p.username || '')}`;
  $('#canal-kpis').innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Seguidores</div><div class="kpi-value">${fmt.compact(p.followers || 0)}</div><div class="kpi-sub">+${fmt.compact(t.new_followers || 0)} ${t.period || '28d'}</div></div>
    <div class="kpi-card"><div class="kpi-label">Alcance</div><div class="kpi-value">${fmt.compact(t.reach || 0)}</div><div class="kpi-sub">${t.period || '28d'}</div></div>
    <div class="kpi-card"><div class="kpi-label">Engagement</div><div class="kpi-value">${t.engagement_rate ?? 0}%</div><div class="kpi-sub">promedio</div></div>
    <div class="kpi-card ok"><div class="kpi-label">Leads desde IG</div><div class="kpi-value">${fmt.compact(t.leads_from_ig || 0)}</div><div class="kpi-sub">al pipeline</div></div>`;
  const body = $('#canal-body');
  body.innerHTML = `
    ${d?._mock ? '<div class="note" style="margin-bottom:12px">◉ Módulo de Instagram en modo demostración. Al conectar la cuenta (Integraciones) las métricas, posts e inbox pasan a ser reales.</div>' : ''}
    <div class="seg ig-tabs">
      <button data-t="stats" class="active">Estadísticas</button>
      <button data-t="posts">Posts</button>
      <button data-t="inbox">Inbox</button>
      <button data-t="comments">Comentarios</button>
      <button data-t="comp">Competencia</button>
    </div>
    <div id="ig-tab"></div>`;
  body.querySelector('.ig-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-t]'); if (!b) return;
    ig.tab = b.dataset.t;
    body.querySelectorAll('.ig-tabs button').forEach(x => x.classList.toggle('active', x === b));
    igSwitch();
  });
  igSwitch();
}

function igSwitch() {
  const host = $('#ig-tab');
  if (ig.tab === 'stats') igStats(host);
  else if (ig.tab === 'posts') igPosts(host);
  else if (ig.tab === 'inbox') igInbox(host);
  else if (ig.tab === 'comments') igComentarios(host);
  else igCompetencia(host);
}

function mediaIcon(t) { return ({ IMAGE: '▣', VIDEO: '▶', REELS: '▶', CAROUSEL_ALBUM: '❑' })[t] || '▣'; }
function postThumb(i) { const pal = ['#E1306C', '#F58529', '#8134AF', '#515BD4', '#2F6B3E', '#C99A2E']; return pal[i % pal.length]; }

function igStats(host) {
  const d = igData || {};
  const t = d.totals || {};
  const feed = d.feed || [];
  const series = d.series || [];
  const an = analyzeAccount(feed, (d.profile && d.profile.followers) || 0);
  const avg = (k) => feed.length ? feed.reduce((a, m) => a + (m[k] || 0), 0) / feed.length : 0;
  const ctx = { avgLikes: avg('like_count'), avgComments: avg('comments_count'), avgSaved: avg('saved'), avgReach: avg('reach'), bestType: an.bestType ? an.bestType.type : null };
  const posts = feed.slice()
    .map(m => ({ m, eng: m.reach ? +(((m.like_count || 0) + (m.comments_count || 0) + (m.saved || 0)) / m.reach * 100).toFixed(1) : 0 }))
    .sort((a, b) => b.eng - a.eng).slice(0, 6);

  const maxReach = Math.max(1, ...series.map(s => s.reach || 0));
  const chart = series.length > 1
    ? `<div class="ig-chart">${series.map(s => `<div class="ig-chart-bar" style="height:${Math.max(4, Math.round((s.reach || 0) / maxReach * 100))}%" title="${(s.date || '')}: ${fmt.compact(s.reach || 0)} de alcance"></div>`).join('')}</div>
       <div class="ig-chart-x"><span>${(series[0].date || '').slice(5)}</span><span>alcance por día</span><span>${(series[series.length - 1].date || '').slice(5)}</span></div>`
    : '<div class="text-muted" style="font-size:12px">Serie no disponible.</div>';

  const metrics = [
    ['Visualizaciones', fmt.compact(t.impressions || 0)],
    ['Visitas al perfil', fmt.compact(t.profile_views || 0)],
    ['Clics a la web', fmt.compact(t.website_clicks || 0)],
    ['Nuevos seguidores', '+' + fmt.compact(t.new_followers || 0)],
    ['Posts / semana', an.perWeek || '—'],
    ['Mejor formato', an.bestType ? igTypeLabel(an.bestType.type) : '—'],
  ];

  host.innerHTML = `
    <div class="ig-best-hd">Alcance · últimos 28 días</div>
    ${chart}
    <div class="ig-best-hd" style="margin-top:16px">Métricas del período</div>
    <div class="ig-cp-grid">${metrics.map(([l, v]) => `<div><span>${l}</span><b>${v}</b></div>`).join('')}</div>
    ${an.topDays.length ? `<div class="note" style="margin-top:8px;border-left:3px solid var(--cc-ig)">📅 Tu mejor momento para postear: <b>${an.topDays.join(' · ')}</b>${an.topHours.length ? ` a las <b>${an.topHours.join('/')}</b>` : ''}. Formato más fuerte: <b>${an.bestType ? igTypeLabel(an.bestType.type) : '—'}</b> (${an.bestType ? an.bestType.engAvg : 0}% eng).</div>` : ''}
    <div class="ig-best-hd" style="margin-top:16px">Mejores publicaciones · qué funcionó y por qué</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${posts.map((x, i) => { const why = postInsights(x.m, ctx); return `
        <a href="${escapeHtml(x.m.permalink || '#')}" target="_blank" rel="noopener" style="display:flex;gap:10px;align-items:flex-start;background:var(--cc-surface);border:1px solid var(--cc-line);padding:8px;border-radius:8px;text-decoration:none;color:inherit">
          ${x.m.image ? `<img src="${escapeHtml(x.m.image)}" loading="lazy" style="width:62px;height:62px;object-fit:cover;border-radius:6px;flex-shrink:0">` : `<div style="width:62px;height:62px;border-radius:6px;flex-shrink:0;background:linear-gradient(135deg,#E1306C,#1a1a1a);display:flex;align-items:center;justify-content:center;color:#fff">${mediaIcon(x.m.media_type)}</div>`}
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:600;line-height:1.3">#${i + 1} · ${escapeHtml(fmt.truncate(x.m.caption || '(sin texto)', 60))}</div>
            <div class="ig-post-metrics" style="margin:3px 0"><span>♥ ${fmt.compact(x.m.like_count)}</span><span>✎ ${fmt.compact(x.m.comments_count)}</span><span>⤓ ${fmt.compact(x.m.saved || 0)}</span><span>↗ ${fmt.compact(x.m.reach)}</span><span class="ig-eng">${x.eng}% eng</span></div>
            <div class="ig-post-why"><b>Por qué funcionó:</b> ${escapeHtml(why.join(' · '))}.</div>
          </div>
        </a>`; }).join('')}
    </div>`;
}

function igTypeLabel(t) { return ({ IMAGE: 'Fotos', VIDEO: 'Videos/Reels', CAROUSEL_ALBUM: 'Carruseles' })[t] || t; }

function postInsights(m, ctx) {
  const r = [];
  const likes = m.like_count || 0, comments = m.comments_count || 0, saved = m.saved || 0, reach = m.reach || 0;
  if (ctx.avgLikes && likes >= ctx.avgLikes * 1.4) r.push(`${(likes / ctx.avgLikes).toFixed(1)}× tus likes promedio`);
  if (ctx.avgComments > 0.5 && comments >= Math.max(3, ctx.avgComments * 1.6)) r.push(`mucha conversación (${comments} comentarios)`);
  if (reach && saved / Math.max(reach, 1) >= 0.012) r.push(`muy guardado (${(saved / reach * 100).toFixed(1)}% de quienes lo vieron)`);
  if (reach && ctx.avgReach && reach >= ctx.avgReach * 1.5) r.push(`alcanzó ${(reach / ctx.avgReach).toFixed(1)}× tu alcance habitual`);
  const ty = (m.media_type === 'REELS' ? 'VIDEO' : m.media_type);
  if (ctx.bestType && ctx.bestType === ty) r.push(`es ${igTypeLabel(ty)}, tu formato más fuerte`);
  else if (ty === 'VIDEO') r.push('el video/reel amplifica el alcance');
  else if (ty === 'CAROUSEL_ALBUM') r.push('el carrusel retiene (más slides)');
  if (!r.length) r.push('rendimiento parejo y sólido');
  return r.slice(0, 3);
}

function igPosts(host) {
  host.innerHTML = `
    <div class="ig-posts-bar">
      <div class="canal-section-hd" style="margin:0">Feed · ${ig.feed.length} publicaciones</div>
      <button class="btn" id="ig-newpost">＋ Nuevo posteo</button>
    </div>
    <div class="ig-grid">
      ${ig.feed.map((m, i) => {
        const link = m.permalink && !m._new;
        const T = link ? 'a' : 'div';
        const attrs = link ? ` href="${escapeHtml(m.permalink)}" target="_blank" rel="noopener" title="Abrir en Instagram"` : '';
        const fallback = `background:linear-gradient(135deg, ${postThumb(i)}, #1a1a1a)`;
        const corner = m._new
          ? '<span class="ig-tile-new">NUEVO</span>'
          : `<span class="ig-tile-eng">${analyzePost(m).engagement}%</span>`;
        return `
        <${T} class="ig-tile${link ? ' link' : ''}"${attrs}>
          <div class="ig-tile-img" style="${fallback}">
            ${m.image ? `<img class="ig-tile-photo" src="${escapeHtml(m.image)}" alt="" loading="lazy">` : ''}
            <span class="ig-tile-${m.image ? 'badge' : 'type'}">${mediaIcon(m.media_type)}</span>
            ${corner}
          </div>
          <div class="ig-tile-cap">${escapeHtml(fmt.truncate(m.caption, 60))}</div>
          <div class="ig-tile-metrics"><span>♥ ${fmt.compact(m.like_count || 0)}</span><span>✎ ${fmt.compact(m.comments_count || 0)}</span><span>↗ ${fmt.compact(m.reach || 0)}</span></div>
          ${m.date ? `<div class="ig-tile-date">${fmt.dateShortAR(m.date)}</div>` : ''}
        </${T}>`;
      }).join('')}
    </div>`;
  $('#ig-newpost').addEventListener('click', openPostComposer);
}

async function openPostComposer() {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', style: { maxWidth: '560px' } });
  modal.appendChild(el('div', { class: 'modal-hd' }, el('h3', {}, 'Nuevo posteo de Instagram'), el('button', { class: 'modal-close', onClick: () => close() }, '×')));
  const mb = el('div', { class: 'modal-body' });
  mb.innerHTML = `
    <div class="note" style="margin-bottom:12px">Elegí una unidad: su <b>foto principal</b> y datos arman el posteo, que sale <b>directo a tu Instagram</b> (@carcash_arg). Instagram necesita una imagen, por eso hace falta una unidad con foto.</div>
    <div class="field" style="margin-bottom:12px"><label class="inp-label">Unidad a publicar</label>
      <select class="sel" id="np-unit"><option value="">— Elegí una unidad —</option></select></div>
    <div id="np-preview" style="margin-bottom:12px"></div>
    <div class="field" style="margin-bottom:12px"><label class="inp-label">Texto del posteo</label>
      <textarea class="ta" id="np-caption" rows="6" placeholder="Elegí una unidad para autocompletar, o escribí…"></textarea></div>`;
  modal.appendChild(mb);
  modal.appendChild(el('div', { class: 'modal-actions' },
    el('button', { class: 'btn btn-ghost', onClick: () => close() }, 'Cancelar'),
    el('button', { class: 'btn btn-ok', id: 'np-pub', onClick: () => publish() }, 'Publicar en Instagram')));
  backdrop.appendChild(modal); document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  function close() { backdrop.remove(); }

  const { data: units } = await supabase.from('units')
    .select('id, brand, model, year, public_price, featured_equipment, main_photo_url, photos')
    .eq('status', 'disponible').is('deleted_at', null).limit(50);
  const sel = $('#np-unit');
  (units || []).forEach(u => sel.appendChild(new Option(`${u.brand} ${u.model} ${u.year} · USD ${fmt.usd(u.public_price)}`, u.id)));
  const photoOf = (u) => u && (u.main_photo_url || (Array.isArray(u.photos) ? u.photos[0] : null));
  sel.addEventListener('change', () => {
    const u = (units || []).find(x => x.id === sel.value);
    const prev = $('#np-preview');
    if (!u) { prev.innerHTML = ''; return; }
    const eq = (u.featured_equipment || []).slice(0, 3).join(' · ');
    $('#np-caption').value = `🚗 ${u.brand} ${u.model} ${u.year}\n💵 USD ${fmt.usd(u.public_price)}${eq ? '\n✔ ' + eq : ''}\n\n📩 Escribinos por DM\n#autos #usados #${(u.brand || '').replace(/\s/g, '')}`;
    const img = photoOf(u);
    prev.innerHTML = img
      ? `<img src="${escapeHtml(img)}" alt="" style="width:100%;max-height:220px;object-fit:cover;border-radius:8px;display:block">`
      : `<div class="note" style="border-left:3px solid var(--cc-warn,#d97706)">⚠ Esta unidad no tiene foto cargada — Instagram no permite publicar sin imagen.</div>`;
  });

  async function publish() {
    const u = (units || []).find(x => x.id === sel.value);
    const cap = $('#np-caption').value.trim();
    if (!u) { toast('Elegí una unidad para publicar', 'La foto sale de la unidad', 'warn'); return; }
    if (!photoOf(u)) { toast('Esa unidad no tiene foto', 'Cargá una foto a la unidad primero', 'warn'); return; }
    if (!cap) { toast('Escribí el texto del posteo', null, 'warn'); return; }
    if (!confirm(`¿Publicar en Instagram (@carcash_arg) ahora?\n\n${u.brand} ${u.model} ${u.year || ''}`)) return;
    const btn = $('#np-pub'); if (btn) { btn.disabled = true; btn.textContent = 'Publicando…'; }
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/.netlify/functions/publish-to-ig', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ unit_id: u.id, caption: cap, action: 'publish' }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.error) throw new Error(j.error || ('HTTP ' + res.status));
      toast('¡Publicado en Instagram! 🎉', 'Ya aparece en tu feed', 'ok');
      close();
      const fresh = await fetchInstagramInsights('28d').catch(() => null);
      if (fresh && !fresh._mock) { igData = fresh; ig.feed = (fresh.feed || []).slice(); }
      if (ig.tab === 'posts') igSwitch();
    } catch (err) {
      toast('No se pudo publicar', String(err.message || err).slice(0, 90), 'warn');
      const b = $('#np-pub'); if (b) { b.disabled = false; b.textContent = 'Publicar en Instagram'; }
    }
  }
}

async function igInbox(host) {
  host.innerHTML = `<div class="empty">Cargando inbox…</div>`;
  const { data: evs } = await supabase.from('timeline_events')
    .select('direction, body, title, event_at, opportunity:opportunities!opportunity_id(contact:contacts!contact_id(id, full_name))')
    .eq('channel', 'instagram').order('event_at', { ascending: false }).limit(200);
  const byC = new Map();
  for (const ev of evs || []) { const c = ev.opportunity?.contact; if (!c) continue; if (!byC.has(c.id)) byC.set(c.id, { id: c.id, name: c.full_name, last: ev.body || ev.title, when: ev.event_at, unread: ev.direction === 'entrante' }); }
  const convs = Array.from(byC.values());
  if (!convs.length) {
    host.innerHTML = `<div class="empty" style="padding:44px 20px;text-align:center">
      <div style="font-size:34px;margin-bottom:10px">📭</div>
      <div style="font-weight:600;margin-bottom:4px">Todavía no hay DMs</div>
      <div class="text-muted" style="font-size:13px;max-width:360px;margin:0 auto">Los mensajes nuevos que reciba <b>@carcash_arg</b> por Instagram entran acá y a la <b>Bandeja</b> automáticamente.</div>
    </div>`;
    return;
  }
  host.innerHTML = `
    <div class="ig-inbox">
      ${convs.map(c => `
        <div class="ig-dm ${c.unread ? 'unread' : ''}" ${c.id ? `data-cid="${c.id}"` : ''}>
          <div class="ig-dm-ava">${escapeHtml((c.name || '?').slice(0, 1).toUpperCase())}</div>
          <div class="ig-dm-main"><div class="ig-dm-name">${escapeHtml(c.name || 'Usuario')}${c.unread ? ' <span class="chip sm warn">nuevo</span>' : ''}</div>
            <div class="ig-dm-last">${escapeHtml(fmt.truncate(c.last || '—', 56))}</div></div>
          <div class="ig-dm-when mono">${escapeHtml(fmt.relative(c.when))}</div>
        </div>`).join('')}
    </div>
    <div class="note" style="margin-top:10px">Para responder un DM, abrilo en la <b>Bandeja</b> (centraliza todos los canales).</div>`;
  host.querySelectorAll('[data-cid]').forEach(elm => elm.addEventListener('click', () => navigate('/bandeja/' + elm.dataset.cid)));
}

let igComments = [];
async function igComentarios(host) {
  host.innerHTML = `<div class="empty">Cargando comentarios…</div>`;
  igComments = await fetchInstagramComments().catch(() => []);
  renderComments(host);
}
function renderComments(host) {
  const pend = igComments.filter(c => !c.hidden).length;
  host.innerHTML = `
    <div class="note" style="margin-bottom:12px">Moderá los comentarios de tus posts: respondé u ocultá — sale directo a Instagram. <b>${pend}</b> visibles.</div>
    <div class="ig-comments">${igComments.length ? igComments.map(commentRow).join('') : '<div class="empty text-muted" style="padding:28px;text-align:center">No hay comentarios recientes para moderar.</div>'}</div>`;
  host.querySelectorAll('[data-hide]').forEach(b => b.addEventListener('click', async () => {
    const c = igComments.find(x => x.id === b.dataset.hide); if (!c) return;
    b.disabled = true;
    const res = await igCommentAction({ comment_id: c.id, action: c.hidden ? 'unhide' : 'hide' });
    b.disabled = false;
    if (res.ok) { c.hidden = !c.hidden; toast(c.hidden ? 'Comentario ocultado en Instagram' : 'Comentario visible de nuevo', null, 'ok'); renderComments(host); }
    else toast('No se pudo ocultar', res.error, 'warn');
  }));
  host.querySelectorAll('[data-reply]').forEach(b => b.addEventListener('click', () => {
    host.querySelector(`[data-replybox="${b.dataset.reply}"]`)?.classList.toggle('hidden');
  }));
  host.querySelectorAll('[data-send]').forEach(b => b.addEventListener('click', async () => {
    const inp = host.querySelector(`[data-replyinput="${b.dataset.send}"]`);
    const msg = inp && inp.value.trim();
    if (!msg) return;
    b.disabled = true; b.textContent = 'Enviando…';
    const res = await igCommentAction({ comment_id: b.dataset.send, action: 'reply', message: msg });
    b.disabled = false; b.textContent = 'Enviar';
    if (res.ok) { toast('Respuesta publicada en Instagram ✓', null, 'ok'); inp.value = ''; host.querySelector(`[data-replybox="${b.dataset.send}"]`)?.classList.add('hidden'); }
    else toast('No se pudo responder', res.error, 'warn');
  }));
}

async function igCommentAction(body) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const r = await fetch('/.netlify/functions/ig-comment-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) return { ok: false, error: String(j.error || ('HTTP ' + r.status)).slice(0, 90) };
    return { ok: true, data: j };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 90) }; }
}
function commentRow(c) {
  return `<div class="ig-cmt ${c.hidden ? 'hidden-cmt' : ''}">
    <div class="ig-cmt-ava">${escapeHtml((c.user || '?').slice(0, 1).toUpperCase())}</div>
    <div class="ig-cmt-main">
      <div class="ig-cmt-top"><b>@${escapeHtml(c.user)}</b> <span class="text-muted mono" style="font-size:10px">${escapeHtml(fmt.relative(c.when))}</span>${c.hidden ? ' <span class="chip sm">oculto</span>' : ''}</div>
      <div class="ig-cmt-text">${escapeHtml(c.text)}</div>
      <div class="ig-cmt-post">en: ${escapeHtml(fmt.truncate(c.post, 44))}</div>
      <div class="ig-cmt-actions">
        <button class="ag-mini" data-reply="${c.id}">Responder</button>
        <button class="ag-mini danger" data-hide="${c.id}">${c.hidden ? 'Mostrar' : 'Ocultar'}</button>
      </div>
      <div class="ig-reply hidden" data-replybox="${c.id}">
        <input class="inp" data-replyinput="${c.id}" placeholder="Escribí una respuesta…">
        <button class="btn btn-sm" data-send="${c.id}">Enviar</button>
      </div>
    </div>
  </div>`;
}

function igCompetencia(host) {
  const sug = suggestCompetitors();
  host.innerHTML = `
    <div class="ig-best-hd">Comparar con la competencia</div>
    <div class="note" style="margin-bottom:10px">Analizamos un competidor con datos públicos: seguidores, <b>engagement real</b>, <b>frecuencia</b>, <b>qué formato le funciona</b>, <b>hashtags</b>, <b>CTAs y precios</b>, <b>cuándo postea</b> y sus <b>mejores posts</b> — todo comparado con tu cuenta.</div>
    <div class="ig-sug">
      <span class="ig-sug-lbl">Sugeridos:</span>
      ${sug.map(s => `<button class="chip ig-sug-chip" data-u="${escapeHtml(s.username)}" title="${escapeHtml(s.reason)}">@${escapeHtml(s.username)}</button>`).join('')}
    </div>
    <div class="ig-comp-form">
      <input class="inp" id="ig-comp-user" placeholder="@otro_competidor" style="max-width:280px">
      <button class="btn" id="ig-comp-go">Analizar</button>
    </div>
    <div id="ig-comp-result"></div>`;
  $('#ig-comp-go').addEventListener('click', () => {
    const u = $('#ig-comp-user').value.trim();
    if (!u) { toast('Ingresá el usuario del competidor', null, 'warn'); return; }
    compareCompetitor(u);
  });
  host.querySelectorAll('.ig-sug-chip').forEach(b => b.addEventListener('click', () => compareCompetitor(b.dataset.u)));
}
async function compareCompetitor(username) {
  const out = $('#ig-comp-result');
  out.innerHTML = `<div class="empty">Analizando @${escapeHtml(username.replace(/^@/, ''))}…</div>`;
  const c = await fetchCompetitorInsights(username).catch(() => null);
  if (!c) { out.innerHTML = `<div class="empty">No se pudo obtener la cuenta</div>`; return; }
  const co = analyzeAccount(c.media || c.top_media || [], c.profile?.followers || 0);
  const me = analyzeAccount((igData && igData.feed) || [], (igData && igData.profile && igData.profile.followers) || 0);
  const cu = (c.profile?.username || username).replace(/^@/, '');
  const tLabel = (t) => ({ IMAGE: 'Fotos', VIDEO: 'Videos/Reels', CAROUSEL_ALBUM: 'Carruseles' })[t] || t;
  const winA = (a, b) => (a >= b ? 'a' : 'b');
  const row = (label, a, b, w) => `<tr><td class="t-strong">${label}</td><td class="num ${w === 'a' ? 'ig-win' : ''}">${a}</td><td class="num ${w === 'b' ? 'ig-win' : ''}">${b}</td></tr>`;

  // Recomendaciones computadas a partir del head-to-head
  const recs = [];
  if (co.perWeek && co.perWeek > me.perWeek * 1.4) recs.push(`Postean <b>${co.perWeek}/sem</b> vs tus <b>${me.perWeek || 0}/sem</b> — subí la frecuencia para no perder alcance.`);
  if (co.bestType) recs.push(`Su formato más fuerte es <b>${tLabel(co.bestType.type)}</b> (${co.bestType.engAvg}% eng. promedio)${me.bestType && me.bestType.type !== co.bestType.type ? ` — vos rendís más en ${tLabel(me.bestType.type)}, pero sumá ${tLabel(co.bestType.type)}` : ''}.`);
  const newTags = co.topTags.filter(t => !me.topTags.includes(t)).slice(0, 6);
  if (newTags.length) recs.push(`Hashtags que usan y vos no: ${newTags.map(escapeHtml).join('  ')}`);
  if (co.ctaPct >= me.ctaPct + 15) recs.push(`El <b>${co.ctaPct}%</b> de sus posts tiene llamado a la acción (DM/consultá) vs tu <b>${me.ctaPct}%</b> — cerrá cada post con un CTA.`);
  if (co.pricePct >= me.pricePct + 15) recs.push(`Muestran precio/financiación en el <b>${co.pricePct}%</b> de los posts vs tu ${me.pricePct}%.`);
  if (me.engAvg >= co.engAvg && co.engAvg) recs.push(`Tu engagement (<b>${me.engAvg}%</b>) ya es ≥ al de ellos (${co.engAvg}%). Buen trabajo — sostené la calidad.`);
  if (!recs.length) recs.push('Cuentas parejas — la diferencia la hace la constancia y la calidad de la foto.');

  const typeBars = (an) => an.types.map(t => `<div style="display:flex;align-items:center;gap:8px;margin:4px 0;font-size:11px"><span style="width:90px;color:var(--cc-muted)">${tLabel(t.type)}</span><div style="flex:1;height:8px;background:var(--cc-line);border-radius:4px;overflow:hidden"><div style="width:${t.pct}%;height:100%;background:var(--cc-ig)"></div></div><span class="mono" style="width:104px;text-align:right">${t.pct}% · ${t.engAvg}% eng</span></div>`).join('');
  const thumb = (m) => m.image ? `<img src="${escapeHtml(m.image)}" alt="" loading="lazy" style="width:56px;height:56px;object-fit:cover;border-radius:6px;flex-shrink:0">` : `<div style="width:56px;height:56px;border-radius:6px;flex-shrink:0;background:linear-gradient(135deg,#8134AF,#1a1a1a);display:flex;align-items:center;justify-content:center;color:#fff">${({ IMAGE: '▣', VIDEO: '▶', CAROUSEL_ALBUM: '❑' })[m.media_type] || '▣'}</div>`;

  out.innerHTML = `
    ${c._mock ? `<div class="note warn" style="margin:8px 0">No pude traer datos reales de <b>@${escapeHtml(cu)}</b> (¿es una cuenta Business/Creator pública?). Mostrando datos de ejemplo.</div>` : ''}
    <div class="ig-comp-prof">
      <div class="ig-cp-head"><div class="ig-dm-ava">${escapeHtml(cu.slice(0, 1).toUpperCase())}</div>
        <div><div class="ig-cp-name">@${escapeHtml(cu)}</div><div class="text-muted" style="font-size:11px">${fmt.compact(co.followers)} seguidores · ${fmt.compact(c.profile?.media_count || 0)} posts · ${co.n} analizados</div></div></div>

      <div class="ig-best-hd" style="margin:4px 0 8px">Head to head</div>
      <div class="cc-table-wrap"><table class="cc-table">
        <thead><tr><th>Métrica</th><th class="num">Vos</th><th class="num">@${escapeHtml(cu)}</th></tr></thead>
        <tbody>
          ${row('Seguidores', fmt.compact(me.followers), fmt.compact(co.followers), winA(me.followers, co.followers))}
          ${row('Engagement x post', me.engAvg + '%', co.engAvg + '%', winA(me.engAvg, co.engAvg))}
          ${row('Posts / semana', me.perWeek || '—', co.perWeek || '—', '')}
          ${row('Hashtags x post', me.avgHashtags, co.avgHashtags, '')}
          ${row('Posts con CTA', me.ctaPct + '%', co.ctaPct + '%', winA(me.ctaPct, co.ctaPct))}
          ${row('Muestran precio', me.pricePct + '%', co.pricePct + '%', '')}
        </tbody></table></div>
      <div class="text-muted" style="font-size:10px;margin-top:4px">Engagement = (likes + comentarios) ÷ seguidores, por post — la métrica para comparar cuentas (en Estadísticas el engagement es sobre el alcance, por eso da distinto).</div>

      <div class="ig-best-hd" style="margin:14px 0 6px">Qué formato les funciona</div>
      ${typeBars(co)}
      ${co.bestType ? `<div class="note" style="margin-top:8px;border-left:3px solid var(--cc-ig)">Su formato más fuerte: <b>${tLabel(co.bestType.type)}</b> con <b>${co.bestType.engAvg}%</b> de engagement promedio.</div>` : ''}

      <div class="ig-best-hd" style="margin:14px 0 6px">Playbook de contenido</div>
      <div class="ig-cp-grid">
        <div><span>Hashtags por post</span><b>${co.avgHashtags}</b><small>vos: ${me.avgHashtags}</small></div>
        <div><span>Llamado a la acción</span><b>${co.ctaPct}%</b><small>de sus posts</small></div>
        <div><span>Muestran precio</span><b>${co.pricePct}%</b><small>de sus posts</small></div>
        <div><span>Cuándo postean</span><b>${co.topDays.join(' · ') || '—'}</b><small>${co.topHours.join(' / ') || ''}</small></div>
      </div>
      ${co.topTags.length ? `<div style="margin-top:10px;font-size:11px"><span class="text-muted">Hashtags top:</span> ${co.topTags.slice(0, 10).map(t => `<span class="chip sm" style="margin:2px">${escapeHtml(t)}</span>`).join('')}</div>` : ''}

      <div class="ig-best-hd" style="margin:14px 0 6px">Sus mejores posts</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${co.topPosts.map(m => `
          <a href="${escapeHtml(m.permalink || '#')}" target="_blank" rel="noopener" style="display:flex;gap:10px;align-items:center;text-decoration:none;color:inherit;background:var(--cc-surface);border:1px solid var(--cc-line);padding:8px;border-radius:8px">
            ${thumb(m)}
            <div style="flex:1;min-width:0">
              <div style="font-size:12px;line-height:1.3;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${escapeHtml(fmt.truncate(m.caption || '(sin texto)', 90))}</div>
              <div class="ig-post-metrics" style="margin-top:3px"><span>♥ ${fmt.compact(m.like_count)}</span><span>✎ ${fmt.compact(m.comments_count)}</span><span class="ig-eng">${m.eng}% eng</span></div>
            </div>
          </a>`).join('')}
      </div>

      <div class="ig-best-hd" style="margin:14px 0 6px">Recomendaciones</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${recs.map(r => `<div class="note" style="margin:0;border-left:3px solid var(--cc-ig)">→ ${r}</div>`).join('')}
      </div>
    </div>`;
}

// Motor de análisis a partir de la media pública (sirve para la competencia y para tu propia cuenta).
function analyzeAccount(media, followers) {
  const posts = media || [];
  const n = posts.length;
  const fol = followers || 0;
  const totalInt = posts.reduce((a, m) => a + (m.like_count || 0) + (m.comments_count || 0), 0);
  const engAvg = n && fol ? +((totalInt / n / fol) * 100).toFixed(2) : 0;
  const engOf = (m) => fol ? +(((m.like_count || 0) + (m.comments_count || 0)) / fol * 100).toFixed(2) : 0;
  const norm = (t) => (t === 'REELS' ? 'VIDEO' : (t || 'IMAGE'));
  const types = {};
  posts.forEach(m => { const t = norm(m.media_type); (types[t] = types[t] || { n: 0, int: 0 }); types[t].n++; types[t].int += (m.like_count || 0) + (m.comments_count || 0); });
  const typeArr = Object.entries(types).map(([t, v]) => ({ type: t, n: v.n, pct: n ? Math.round(v.n / n * 100) : 0, engAvg: fol ? +((v.int / v.n / fol) * 100).toFixed(2) : 0 })).sort((a, b) => b.n - a.n);
  const bestType = typeArr.slice().sort((a, b) => b.engAvg - a.engAvg)[0] || null;
  let totalTags = 0, withCTA = 0, withPrice = 0, totalLen = 0; const tagFreq = {};
  posts.forEach(m => {
    const cap = m.caption || ''; totalLen += cap.length;
    const tags = cap.match(/#[\p{L}\p{N}_]+/gu) || []; totalTags += tags.length;
    tags.forEach(t => { const k = t.toLowerCase(); tagFreq[k] = (tagFreq[k] || 0) + 1; });
    if (/(\bdm\b|mensaje|escrib[ií]|whats|wpp|cotiz|consult|link\s*en\s*bio)/i.test(cap)) withCTA++;
    if (/(\$|usd|u\$s|precio|financ|cuota)/i.test(cap)) withPrice++;
  });
  const topTags = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => t);
  const dn = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const dayC = [0, 0, 0, 0, 0, 0, 0]; const hourC = {}; const times = [];
  posts.forEach(m => { const d = new Date(m.timestamp || m.date); if (!isNaN(d.getTime())) { dayC[d.getDay()]++; hourC[d.getHours()] = (hourC[d.getHours()] || 0) + 1; times.push(d.getTime()); } });
  const topDays = dayC.map((c, i) => ({ d: dn[i], c })).filter(x => x.c).sort((a, b) => b.c - a.c).slice(0, 3).map(x => x.d);
  const topHours = Object.entries(hourC).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([h]) => h + 'h');
  times.sort((a, b) => b - a);
  let perWeek = 0;
  if (times.length >= 2) { const weeks = Math.max((times[0] - times[times.length - 1]) / (7 * 86400000), 0.14); perWeek = +(times.length / weeks).toFixed(1); }
  const topPosts = posts.slice().sort((a, b) => ((b.like_count || 0) + (b.comments_count || 0)) - ((a.like_count || 0) + (a.comments_count || 0))).slice(0, 4).map(m => ({ ...m, eng: engOf(m) }));
  return { n, followers: fol, engAvg, types: typeArr, bestType, avgHashtags: n ? +(totalTags / n).toFixed(1) : 0, topTags, ctaPct: n ? Math.round(withCTA / n * 100) : 0, pricePct: n ? Math.round(withPrice / n * 100) : 0, avgLen: n ? Math.round(totalLen / n) : 0, perWeek, topDays, topHours, topPosts };
}

// ============================================================
// MARKET (Mercado Libre)
// ============================================================
async function renderMarket(cfg) {
  const { data: pubs, error } = await supabase
    .from('publications')
    .select('id, status, views, inquiries, url, last_synced_at, error_message, published_at, unit:units!unit_id(unit_code, brand, model, year, public_price, status)')
    .eq('channel', 'mercado_libre')
    .order('published_at', { ascending: false });
  if (error) throw error;

  const activas = (pubs || []).filter(p => p.status === 'activa').length;
  const vistas = (pubs || []).reduce((a, p) => a + (p.views || 0), 0);
  const consultas = (pubs || []).reduce((a, p) => a + (p.inquiries || 0), 0);

  const { count: leadsCount } = await supabase.from('opportunities')
    .select('id', { count: 'exact', head: true }).eq('origin', 'mercado_libre').is('deleted_at', null);

  const { data: leads } = await supabase.from('opportunities')
    .select('id, opp_code, stage, expected_amount, created_at, contact:contacts!contact_id(full_name), assignee:users_profile!assigned_to(full_name)')
    .eq('origin', 'mercado_libre').is('deleted_at', null)
    .order('created_at', { ascending: false }).limit(50);

  $('#canal-sub').innerHTML = `<b>${(pubs || []).length}</b> publicaciones · <b>${leadsCount || 0}</b> leads de Mercado Libre`;
  $('#canal-kpis').innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Publicaciones activas</div><div class="kpi-value">${activas}</div><div class="kpi-sub">de ${(pubs || []).length}</div></div>
    <div class="kpi-card"><div class="kpi-label">Vistas</div><div class="kpi-value">${fmt.compact(vistas)}</div><div class="kpi-sub">acumuladas</div></div>
    <div class="kpi-card ok"><div class="kpi-label">Consultas</div><div class="kpi-value">${fmt.compact(consultas)}</div><div class="kpi-sub">recibidas</div></div>
    <div class="kpi-card"><div class="kpi-label">Leads ML</div><div class="kpi-value">${leadsCount || 0}</div><div class="kpi-sub">al pipeline</div></div>
  `;

  const body = $('#canal-body');
  body.innerHTML = '';
  body.appendChild(el('div', { class: 'note', html: 'Para <b>publicar y sincronizar</b> el stock con Mercado Libre hay que conectar la cuenta (Integraciones). Las preguntas de ML entran como leads vía n8n.' }));

  // Publicaciones
  const pubHost = el('div', { class: 'canal-section' }, el('div', { class: 'canal-section-hd' }, 'Publicaciones en Mercado Libre'), el('div', { class: 'canal-section-body', id: 'canal-pubs' }));
  body.appendChild(pubHost);
  const ph = $('#canal-pubs');
  if (!(pubs || []).length) {
    ph.innerHTML = `<div class="empty-rich"><div class="er-icon">◆</div><div class="er-title">Sin publicaciones</div><div class="er-desc">Cuando publiques unidades en Mercado Libre van a aparecer acá con sus vistas y consultas.</div><button class="btn" onclick="location.hash='#/publicaciones'">Ir a Publicaciones</button></div>`;
  } else {
    ph.innerHTML = `<div class="cc-table-wrap"><table class="cc-table">
      <thead><tr><th>Unidad</th><th>Estado</th><th class="num">Vistas</th><th class="num">Consultas</th><th>Sync</th></tr></thead>
      <tbody>${pubs.map(p => { const u = p.unit || {}; return `
        <tr><td class="t-strong">${escapeHtml([u.brand, u.model, u.year].filter(Boolean).join(' ') || 'Unidad')}<div class="text-muted mono" style="font-size:10px">${escapeHtml(u.unit_code || '')}</div></td>
        <td><span class="chip sm ${p.status === 'activa' ? 'ok' : (p.error_message ? 'danger' : 'warn')}">${escapeHtml(fmt.humanize(p.status || ''))}</span></td>
        <td class="num">${fmt.compact(p.views || 0)}</td><td class="num">${fmt.compact(p.inquiries || 0)}</td>
        <td class="text-muted mono" style="font-size:10px">${p.last_synced_at ? escapeHtml(fmt.relative(p.last_synced_at)) : '—'}</td></tr>`; }).join('')}</tbody></table></div>`;
  }

  // Leads ML
  const leadHost = el('div', { class: 'canal-section' }, el('div', { class: 'canal-section-hd' }, 'Leads de Mercado Libre'), el('div', { class: 'canal-section-body', id: 'canal-leads' }));
  body.appendChild(leadHost);
  const lh = $('#canal-leads');
  if (!(leads || []).length) {
    lh.innerHTML = `<div class="empty">Sin leads de Mercado Libre todavía</div>`;
  } else {
    lh.innerHTML = `<div class="cc-table-wrap"><table class="cc-table">
      <thead><tr><th>Contacto</th><th>Etapa</th><th class="num">Monto</th><th>Vendedor</th><th></th></tr></thead>
      <tbody>${leads.map(o => `
        <tr class="clickable" data-code="${escapeHtml(o.opp_code)}">
          <td class="t-strong">${escapeHtml(o.contact?.full_name || 'Sin nombre')}<div class="text-muted mono" style="font-size:10px">${escapeHtml(o.opp_code)}</div></td>
          <td><span class="chip sm">${escapeHtml(fmt.humanize(o.stage))}</span></td>
          <td class="num">USD ${escapeHtml(fmt.compact(o.expected_amount || 0))}</td>
          <td class="text-muted">${escapeHtml(o.assignee?.full_name || '— sin asignar —')}</td>
          <td style="text-align:right"><button class="ag-mini" data-go="${escapeHtml(o.opp_code)}">Abrir</button></td>
        </tr>`).join('')}</tbody></table></div>`;
    lh.querySelectorAll('[data-code],[data-go]').forEach(elm => elm.addEventListener('click', () => {
      const code = elm.dataset.go || elm.dataset.code; if (code) navigate('/pipeline/' + code.toLowerCase());
    }));
  }
}

const styles = `
  .canal-title.canal-whatsapp { color: var(--cc-ink); }
  .canal-section { margin-bottom: 22px; }
  .canal-section-hd { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; font-weight: 600; color: var(--cc-muted); margin-bottom: 10px; }
  .canal-section-body { }
  #canal-kpis { margin-top: 4px; }

  .ig-best-hd { font-family: var(--cc-font-display); font-weight: 400; font-size: 17px; margin: 18px 0 10px; }
  .ig-best { display: grid; grid-template-columns: 1fr; gap: 1px; background: var(--cc-line); border: 1px solid var(--cc-line); }
  @container app (min-width: 760px) { .ig-best { grid-template-columns: 1fr 1fr; } }
  .ig-post-card { background: var(--cc-surface); padding: 12px 14px; display: flex; gap: 10px; }
  .ig-post-rank { font-family: var(--cc-font-display); font-size: 20px; color: var(--cc-ig); flex-shrink: 0; }
  .ig-post-info { flex: 1; min-width: 0; }
  .ig-post-cap { font-size: 13px; font-weight: 500; line-height: 1.35; }
  .ig-post-metrics { display: flex; gap: 10px; flex-wrap: wrap; font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); margin: 5px 0; }
  .ig-post-metrics .ig-eng { color: var(--cc-ig); font-weight: 600; }
  .ig-post-why { font-size: 11.5px; color: var(--cc-ink-soft); line-height: 1.5; background: var(--cc-bg-alt); padding: 6px 8px; border-left: 2px solid var(--cc-ig); }
  .ig-comp { margin-top: 8px; }
  .ig-comp-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
  .cc-table td.ig-win { color: var(--cc-ok); font-weight: 700; }

  .ig-tabs { margin-bottom: 16px; flex-wrap: wrap; }
  .ig-chart { display: flex; align-items: flex-end; gap: 2px; height: 92px; padding: 8px; background: var(--cc-surface); border: 1px solid var(--cc-line); border-radius: 8px; }
  .ig-chart-bar { flex: 1; background: var(--cc-ig); border-radius: 2px 2px 0 0; min-height: 3px; opacity: 0.82; transition: opacity .1s; }
  .ig-chart-bar:hover { opacity: 1; }
  .ig-chart-x { display: flex; justify-content: space-between; font-family: var(--cc-font-mono); font-size: 9px; color: var(--cc-muted); margin-top: 4px; }
  .ig-posts-bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .ig-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
  @container app (min-width: 700px) { .ig-grid { grid-template-columns: repeat(3, 1fr); } }
  @container app (min-width: 1100px) { .ig-grid { grid-template-columns: repeat(4, 1fr); } }
  .ig-tile { background: var(--cc-surface); border: 1px solid var(--cc-line); }
  .ig-tile.link { cursor: pointer; display: block; text-decoration: none; color: inherit; transition: transform .12s, box-shadow .12s, border-color .12s; }
  .ig-tile.link:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(0,0,0,0.18); border-color: var(--cc-ig); }
  .ig-tile-img { aspect-ratio: 1/1; position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .ig-tile-photo { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
  .ig-tile-badge { position: absolute; top: 8px; left: 8px; z-index: 1; background: rgba(0,0,0,0.55); color: #fff; font-size: 12px; line-height: 1; padding: 3px 6px; border-radius: 4px; backdrop-filter: blur(2px); }
  .ig-tile-img .ig-tile-eng { z-index: 1; }
  .ig-tile-img .ig-tile-type { font-size: 26px; color: rgba(255,255,255,0.85); }
  .ig-tile-new { position: absolute; top: 8px; left: 8px; background: var(--cc-ok); color: #fff; font-family: var(--cc-font-mono); font-size: 8px; letter-spacing: 0.12em; padding: 2px 6px; }
  .ig-tile-eng { position: absolute; top: 8px; right: 8px; background: rgba(0,0,0,0.55); color: #fff; font-family: var(--cc-font-mono); font-size: 8.5px; letter-spacing: 0.08em; padding: 2px 6px; backdrop-filter: blur(2px); }
  .ig-tile-cap { font-size: 11.5px; line-height: 1.35; padding: 8px 10px 4px; }
  .ig-tile-metrics { display: flex; gap: 8px; flex-wrap: wrap; font-family: var(--cc-font-mono); font-size: 9px; color: var(--cc-muted); padding: 0 10px 6px; }
  .ig-tile-date { font-family: var(--cc-font-mono); font-size: 8.5px; letter-spacing: 0.08em; color: var(--cc-muted); padding: 0 10px 10px; opacity: 0.7; }

  .ig-inbox { background: var(--cc-surface); border: 1px solid var(--cc-line); }
  .ig-dm { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--cc-line-soft); cursor: pointer; }
  .ig-dm:last-child { border-bottom: none; }
  .ig-dm:hover { background: var(--cc-bg-alt); }
  .ig-dm.unread { background: var(--cc-warn-soft); }
  .ig-dm-ava { width: 38px; height: 38px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; background: linear-gradient(135deg, #F58529, #E1306C, #8134AF); }
  .ig-dm-main { flex: 1; min-width: 0; }
  .ig-dm-name { font-weight: 600; font-size: 13px; }
  .ig-dm-last { font-size: 12px; color: var(--cc-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ig-dm-when { font-size: 10px; color: var(--cc-steel); flex-shrink: 0; }

  .ig-comments { background: var(--cc-surface); border: 1px solid var(--cc-line); }
  .ig-cmt { display: flex; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--cc-line-soft); }
  .ig-cmt:last-child { border-bottom: none; }
  .ig-cmt.hidden-cmt { opacity: 0.45; }
  .ig-cmt-ava { width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; font-size: 12px; background: linear-gradient(135deg, #F58529, #E1306C, #8134AF); }
  .ig-cmt-main { flex: 1; min-width: 0; }
  .ig-cmt-text { font-size: 13px; margin: 3px 0; }
  .ig-cmt-post { font-size: 10px; color: var(--cc-muted); font-style: italic; }
  .ig-cmt-actions { display: flex; gap: 6px; margin-top: 6px; }
  .ig-reply { display: flex; gap: 6px; margin-top: 8px; }
  .ig-reply .inp { flex: 1; }

  .ig-sug { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
  .ig-sug-lbl { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--cc-muted); }
  .ig-sug-chip { cursor: pointer; }
  .ig-sug-chip:hover { border-color: var(--cc-ig); color: var(--cc-ig); }
  .ig-comp-prof { background: var(--cc-surface); border: 1px solid var(--cc-line); padding: 14px; }
  .ig-cp-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .ig-cp-name { font-weight: 700; font-size: 15px; }
  .ig-cp-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1px; background: var(--cc-line); border: 1px solid var(--cc-line); }
  @container app (min-width: 760px) { .ig-cp-grid { grid-template-columns: repeat(4, 1fr); } }
  .ig-cp-grid > div { background: var(--cc-bg); padding: 10px; }
  .ig-cp-grid span { display: block; font-family: var(--cc-font-mono); font-size: 8px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--cc-muted); }
  .ig-cp-grid b { font-size: 16px; display: block; margin: 2px 0; }
  .ig-cp-grid small { font-size: 10px; color: var(--cc-muted); }
  .ig-cp-tone { margin: 12px 0; font-size: 13px; background: var(--cc-bg-alt); padding: 8px 10px; border-left: 2px solid var(--cc-ig); }
  .ig-cp-sw { display: grid; gap: 8px; }
  @container app (min-width: 760px) { .ig-cp-sw { grid-template-columns: 1fr 1fr; } }
`;
