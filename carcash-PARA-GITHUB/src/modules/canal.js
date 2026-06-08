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
  // Conversaciones del canal
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
  const posts = (d.feed || []).map(m => ({ m, a: analyzePost(m) })).sort((x, y) => y.a.engagement - x.a.engagement).slice(0, 6);
  host.innerHTML = `
    <div class="ig-best-hd">Mejores publicaciones · qué funcionó y por qué</div>
    <div class="ig-best">
      ${posts.map((x, i) => `
        <div class="ig-post-card">
          <div class="ig-post-rank">#${i + 1}</div>
          <div class="ig-post-info">
            <div class="ig-post-cap">${mediaIcon(x.m.media_type)} ${escapeHtml(fmt.truncate(x.m.caption, 70))}</div>
            <div class="ig-post-metrics"><span>♥ ${fmt.compact(x.m.like_count)}</span><span>✎ ${fmt.compact(x.m.comments_count)}</span><span>⤓ ${fmt.compact(x.m.saved || 0)}</span><span>↗ ${fmt.compact(x.m.reach)}</span><span class="ig-eng">${x.a.engagement}% eng.</span></div>
            <div class="ig-post-why"><b>Por qué funcionó:</b> ${escapeHtml(x.a.reasons.join('; '))}.</div>
          </div>
        </div>`).join('')}
    </div>`;
}

function igPosts(host) {
  host.innerHTML = `
    <div class="ig-posts-bar">
      <div class="canal-section-hd" style="margin:0">Feed · ${ig.feed.length} publicaciones</div>
      <button class="btn" id="ig-newpost">＋ Nuevo posteo</button>
    </div>
    <div class="ig-grid">
      ${ig.feed.map((m, i) => `
        <div class="ig-tile">
          <div class="ig-tile-img" style="background:linear-gradient(135deg, ${postThumb(i)}, #1a1a1a)">
            <span class="ig-tile-type">${mediaIcon(m.media_type)}</span>
            ${m._new ? '<span class="ig-tile-new">NUEVO</span>' : `<span class="ig-tile-eng">${analyzePost(m).engagement}%</span>`}
          </div>
          <div class="ig-tile-cap">${escapeHtml(fmt.truncate(m.caption, 60))}</div>
          <div class="ig-tile-metrics"><span>♥ ${fmt.compact(m.like_count || 0)}</span><span>✎ ${fmt.compact(m.comments_count || 0)}</span><span>↗ ${fmt.compact(m.reach || 0)}</span></div>
          ${m.date ? `<div class="ig-tile-date">${fmt.dateShortAR(m.date)}</div>` : ''}
        </div>`).join('')}
    </div>`;
  $('#ig-newpost').addEventListener('click', openPostComposer);
}

async function openPostComposer() {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', style: { maxWidth: '560px' } });
  modal.appendChild(el('div', { class: 'modal-hd' }, el('h3', {}, 'Nuevo posteo de Instagram'), el('button', { class: 'modal-close', onClick: () => close() }, '×')));
  const mb = el('div', { class: 'modal-body' });
  mb.innerHTML = `
    <div class="note" style="margin-bottom:12px">Armá el posteo. En la demo se publica de forma simulada; al conectar la cuenta sale directo a Instagram.</div>
    <div class="field" style="margin-bottom:12px"><label class="inp-label">Tomar fotos y datos de una unidad (opcional)</label>
      <select class="sel" id="np-unit"><option value="">— Posteo libre —</option></select></div>
    <div class="field" style="margin-bottom:12px"><label class="inp-label">Texto del posteo</label>
      <textarea class="ta" id="np-caption" rows="6" placeholder="Escribí el texto…"></textarea></div>`;
  modal.appendChild(mb);
  modal.appendChild(el('div', { class: 'modal-actions' },
    el('button', { class: 'btn btn-ghost', onClick: () => close() }, 'Cancelar'),
    el('button', { class: 'btn btn-ok', id: 'np-pub', onClick: () => publish() }, 'Publicar (demo)')));
  backdrop.appendChild(modal); document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  function close() { backdrop.remove(); }

  const { data: units } = await supabase.from('units')
    .select('id, brand, model, year, public_price, featured_equipment')
    .eq('status', 'disponible').is('deleted_at', null).limit(50);
  const sel = $('#np-unit');
  (units || []).forEach(u => sel.appendChild(new Option(`${u.brand} ${u.model} ${u.year} · USD ${fmt.usd(u.public_price)}`, u.id)));
  sel.addEventListener('change', () => {
    const u = (units || []).find(x => x.id === sel.value);
    if (!u) return;
    const eq = (u.featured_equipment || []).slice(0, 3).join(' · ');
    $('#np-caption').value = `🚗 ${u.brand} ${u.model} ${u.year}\n💵 USD ${fmt.usd(u.public_price)}${eq ? '\n✔ ' + eq : ''}\n\n📩 Escribinos por DM\n#autos #usados #${(u.brand || '').replace(/\s/g, '')}`;
  });

  function publish() {
    const cap = $('#np-caption').value.trim();
    if (!cap) { toast('Escribí el texto del posteo', null, 'warn'); return; }
    ig.feed.unshift({ id: 'new' + Date.now(), caption: cap, media_type: 'IMAGE', like_count: 0, comments_count: 0, saved: 0, reach: 0, _new: true, date: new Date().toISOString().slice(0, 10) });
    toast('Posteo publicado (demo)', 'Aparece en tu feed', 'ok');
    close();
    if (ig.tab === 'posts') igSwitch();
  }
}

async function igInbox(host) {
  host.innerHTML = `<div class="empty">Cargando inbox…</div>`;
  const { data: evs } = await supabase.from('timeline_events')
    .select('direction, body, title, event_at, opportunity:opportunities!opportunity_id(contact:contacts!contact_id(id, full_name))')
    .eq('channel', 'instagram').order('event_at', { ascending: false }).limit(200);
  const byC = new Map();
  for (const ev of evs || []) { const c = ev.opportunity?.contact; if (!c) continue; if (!byC.has(c.id)) byC.set(c.id, { id: c.id, name: c.full_name, last: ev.body || ev.title, when: ev.event_at, unread: ev.direction === 'entrante' }); }
  let convs = Array.from(byC.values()), demo = false;
  if (!convs.length) { demo = true; convs = (await fetchInstagramInbox()).map(m => ({ ...m, id: null })); }
  host.innerHTML = `
    ${demo ? '<div class="note" style="margin-bottom:12px">◉ Inbox de demostración. Al conectar Instagram, los DMs reales entran acá y a la Bandeja.</div>' : ''}
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
    <div class="note" style="margin-bottom:12px">Moderá los comentarios de tus posts: respondé o ocultá. (Demo — real al conectar Instagram). <b>${pend}</b> visibles.</div>
    <div class="ig-comments">${igComments.map(commentRow).join('')}</div>`;
  host.querySelectorAll('[data-hide]').forEach(b => b.addEventListener('click', () => {
    const c = igComments.find(x => x.id === b.dataset.hide); if (c) { c.hidden = !c.hidden; toast(c.hidden ? 'Comentario ocultado' : 'Comentario visible', null, 'ok'); renderComments(host); }
  }));
  host.querySelectorAll('[data-reply]').forEach(b => b.addEventListener('click', () => {
    host.querySelector(`[data-replybox="${b.dataset.reply}"]`)?.classList.toggle('hidden');
  }));
  host.querySelectorAll('[data-send]').forEach(b => b.addEventListener('click', () => {
    const inp = host.querySelector(`[data-replyinput="${b.dataset.send}"]`);
    if (inp && inp.value.trim()) { toast('Respuesta enviada (demo)', null, 'ok'); inp.value = ''; host.querySelector(`[data-replybox="${b.dataset.send}"]`)?.classList.add('hidden'); }
  }));
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
    <div class="note" style="margin-bottom:10px">Analizamos un competidor con datos públicos: seguidores, engagement, <b>cada cuánto postea</b>, <b>cuánto tarda en responder</b>, <b>qué tono usa</b> y si tiene <b>errores de escritura</b>.</div>
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
  const mine = igData?.profile || {}, mineT = igData?.totals || {};
  const myEng = mineT.engagement_rate ?? 0, coEng = c.avg_engagement ?? 0;
  const row = (label, a, b, better) => `
    <tr><td class="t-strong">${label}</td>
      <td class="num ${better === 'a' ? 'ig-win' : ''}">${a}</td>
      <td class="num ${better === 'b' ? 'ig-win' : ''}">${b}</td></tr>`;
  const verdict = coEng > myEng
    ? `La competencia tiene <b>mejor engagement</b> (${coEng}% vs ${myEng}%). Mirá sus formatos top y replicá lo que les funciona.`
    : `Tu cuenta tiene <b>mejor o igual engagement</b> (${myEng}% vs ${coEng}%). Buen trabajo — sostené la frecuencia.`;
  const rm = c.avg_response_minutes || 0;
  const respLabel = rm < 60 ? `${rm} min` : `${(rm / 60).toFixed(1)} h`;
  const cu = (c.profile?.username || username).replace(/^@/, '');
  out.innerHTML = `
    ${c._mock ? '<div class="note" style="margin:8px 0">◉ Análisis de demostración. Real al conectar Instagram (Business Discovery + análisis de sus textos públicos).</div>' : ''}
    <div class="ig-comp-prof">
      <div class="ig-cp-head"><div class="ig-dm-ava">${escapeHtml(cu.slice(0, 1).toUpperCase())}</div>
        <div><div class="ig-cp-name">@${escapeHtml(cu)}</div><div class="text-muted" style="font-size:11px">${fmt.compact(c.profile?.followers || 0)} seguidores · ${fmt.compact(c.profile?.media_count || 0)} posts</div></div></div>
      <div class="ig-cp-grid">
        <div><span>Frecuencia</span><b>${c.posting_per_week} posts/sem</b><small>${escapeHtml(c.posting_pattern || '')}</small></div>
        <div><span>Tiempo de respuesta</span><b>${respLabel}</b><small>a comentarios / DM</small></div>
        <div><span>Engagement</span><b>${coEng}%</b><small>por publicación</small></div>
        <div><span>Ortografía</span><b>${c.typos_count ? c.typos_count + ' errores' : 'OK'}</b><small>${escapeHtml((c.typos_examples || []).join(', ') || 'sin errores notables')}</small></div>
      </div>
      <div class="ig-cp-tone"><b>Tono:</b> ${escapeHtml(c.tone || '—')}</div>
      <div class="ig-cp-sw">
        <div class="note ok" style="margin:0">✔ <b>Fortalezas:</b> ${escapeHtml((c.strengths || []).join('; '))}.</div>
        <div class="note warn" style="margin:0">➜ <b>Cómo superarlos:</b> ${escapeHtml((c.weaknesses || []).join('; '))}.</div>
      </div>
    </div>
    <div class="ig-best-hd" style="margin-top:14px">Comparación con tu cuenta</div>
    <div class="cc-table-wrap"><table class="cc-table">
      <thead><tr><th>Métrica</th><th class="num">Nosotros</th><th class="num">@${escapeHtml((c.profile?.username || username).replace(/^@/, ''))}</th></tr></thead>
      <tbody>
        ${row('Seguidores', fmt.compact(mine.followers || 0), fmt.compact(c.profile?.followers || 0), (mine.followers || 0) >= (c.profile?.followers || 0) ? 'a' : 'b')}
        ${row('Engagement promedio', myEng + '%', coEng + '%', myEng >= coEng ? 'a' : 'b')}
        ${row('Publicaciones', fmt.compact(mine.media_count || 0), fmt.compact(c.profile?.media_count || 0), 'a')}
        ${row('Posts / semana', '~5', '~' + (c.posting_per_week || '—'), '')}
      </tbody></table></div>
    <div class="note" style="margin-top:10px">${verdict}</div>
    <div class="ig-best-hd" style="margin-top:14px">Top de la competencia</div>
    <div class="ig-best">
      ${(c.top_media || []).map(m => { const a = analyzePost(m); return `
        <div class="ig-post-card">
          <div class="ig-post-info">
            <div class="ig-post-cap">${({ IMAGE: '▣', VIDEO: '▶', CAROUSEL_ALBUM: '❑' })[m.media_type] || '▣'} ${escapeHtml(fmt.truncate(m.caption, 70))}</div>
            <div class="ig-post-metrics"><span>♥ ${fmt.compact(m.like_count)}</span><span>✎ ${fmt.compact(m.comments_count)}</span><span class="ig-eng">${a.engagement}% eng.</span></div>
            <div class="ig-post-why"><b>Aprendizaje:</b> ${escapeHtml(a.reasons.join('; '))}.</div>
          </div>
        </div>`; }).join('')}
    </div>`;
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
  .ig-posts-bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .ig-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
  @container app (min-width: 700px) { .ig-grid { grid-template-columns: repeat(3, 1fr); } }
  @container app (min-width: 1100px) { .ig-grid { grid-template-columns: repeat(4, 1fr); } }
  .ig-tile { background: var(--cc-surface); border: 1px solid var(--cc-line); }
  .ig-tile-img { aspect-ratio: 1/1; position: relative; display: flex; align-items: center; justify-content: center; }
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
