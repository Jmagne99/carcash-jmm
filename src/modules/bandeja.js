// ============================================================
// CARCASH · MÓDULO BANDEJA UNIFICADA
// Conversaciones agrupadas por contacto, cruzando todos los canales
// (WhatsApp / ML / IG / Email / Web).
//
// Ruta: /bandeja           → lista
//       /bandeja/:contactId → lista + hilo seleccionado
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { state, isAdmin, isSupervisorOrAdmin, currentUserId } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles, debounce } from '../lib/dom.js';
import { navigate } from '../lib/router.js';
import { suggestReply } from '../lib/ai.js';
import { sendWhatsApp } from '../lib/whatsapp.js';

// ============================================================
// CONFIG
// ============================================================
const CHANNEL_LABELS = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  email: 'Email',
  llamada: 'Llamada',
  sms: 'SMS',
  visita_presencial: 'Visita',
  nota_interna: 'Nota',
};
const CHANNEL_ICONS = {
  whatsapp: '●',
  instagram: '◉',
  email: '✉',
  llamada: '☎',
  sms: '✉',
  visita_presencial: '◆',
  nota_interna: '◇',
};
const CHANNEL_COLORS = {
  whatsapp: 'var(--cc-wsp)',
  instagram: 'var(--cc-ig)',
  email: 'var(--cc-info)',
  llamada: 'var(--cc-champagne)',
  sms: 'var(--cc-info)',
  nota_interna: 'var(--cc-muted)',
};

const local = {
  conversations: [],          // [{ contact, lastMessage, channels, opps, msgCount, hasUnread }]
  selectedContactId: null,
  thread: [],                 // mensajes del contacto seleccionado
  filters: {
    channel: 'todos',
    seller: 'todos',
    state: 'todos',           // todos | unread | mine
    search: '',
  },
  composer: {
    channel: 'whatsapp',
    text: '',
    oppId: null,              // oportunidad a la cual asociar el mensaje saliente
  },
  sellers: [],                // vendedores activos (para asignación · supervisor/admin)
  searchHandler: null,
  realtimeChannel: null,      // suscripción Supabase Realtime
};

let realtimeTeardownBound = false;

// ============================================================
// MOUNT
// ============================================================
export async function mount(params = {}) {
  injectStyles('bandeja-styles', styles);
  local.selectedContactId = params.contactId || null;
  if (isSupervisorOrAdmin() && !local.sellers.length) await loadSellers();
  render();
  await loadConversations();
  if (local.selectedContactId) {
    await loadThread(local.selectedContactId);
  }
  renderUI();
  subscribeRealtime();
}

export default mount;

// ============================================================
// REALTIME (mensajes en vivo)
// ============================================================
function subscribeRealtime() {
  // Limpiar suscripción anterior si la hubiera
  teardownRealtime();

  const refresh = debounce(async () => {
    await loadConversations();
    if (local.selectedContactId) await loadThread(local.selectedContactId);
    renderUI();
  }, 600);

  local.realtimeChannel = supabase
    .channel('bandeja-rt')
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'timeline_events' },
      (payload) => {
        const ev = payload.new || {};
        if (ev.event_type === 'mensaje' || ev.event_type === 'llamada') {
          // Aviso suave solo si es entrante (cliente escribió)
          if (ev.direction === 'entrante') toast('Nuevo mensaje', null, 'info');
          refresh();
        }
      })
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'opportunities' },
      () => refresh())
    .subscribe((status) => {
      const dot = document.getElementById('bl-live');
      if (dot) dot.classList.toggle('on', status === 'SUBSCRIBED');
    });

  // Teardown al salir de /bandeja (una sola vez)
  if (!realtimeTeardownBound) {
    realtimeTeardownBound = true;
    window.addEventListener('hashchange', () => {
      if (!location.hash.startsWith('#/bandeja')) teardownRealtime();
    });
  }
}

function teardownRealtime() {
  if (local.realtimeChannel) {
    supabase.removeChannel(local.realtimeChannel);
    local.realtimeChannel = null;
  }
}

// ============================================================
// FETCH
// ============================================================
async function loadConversations() {
  // Trae los últimos N eventos tipo mensaje/llamada con sus oportunidades y contactos.
  // Como las RLS del backend ya limitan a las opps del usuario actual (o todas si admin),
  // el volumen es manejable. Limitamos a 500 para acotar memoria.
  // TODO post-MVP: reemplazar por una vista SQL que devuelva el último mensaje
  // por contacto, eliminando el agrupamiento en cliente.
  const { data, error } = await supabase
    .from('timeline_events')
    .select(`
      id, event_type, channel, direction, title, body, event_at, user_id,
      opportunity:opportunities!opportunity_id(
        id, opp_code, stage, assigned_to,
        contact:contacts!contact_id(id, full_name, phone, email)
      )
    `)
    .in('event_type', ['mensaje', 'llamada'])
    .order('event_at', { ascending: false })
    .limit(500);

  if (error) {
    console.error(error);
    toast('Error cargando bandeja', error.message, 'error');
    return;
  }

  // Agrupar por contact_id
  const byContact = new Map();
  for (const ev of data || []) {
    const c = ev.opportunity?.contact;
    if (!c) continue;
    if (!byContact.has(c.id)) {
      byContact.set(c.id, {
        contact: c,
        lastMessage: ev,
        channels: new Set(),
        opps: new Set(),
        oppsList: [],
        msgCount: 0,
        unreadCount: 0,
        assignedTo: ev.opportunity.assigned_to,
      });
    }
    const conv = byContact.get(c.id);
    if (ev.channel) conv.channels.add(ev.channel);
    if (ev.opportunity) {
      if (!conv.opps.has(ev.opportunity.id)) {
        conv.opps.add(ev.opportunity.id);
        conv.oppsList.push({
          id: ev.opportunity.id,
          opp_code: ev.opportunity.opp_code,
          stage: ev.opportunity.stage,
        });
      }
    }
    conv.msgCount++;
    // "unread" heuristic: último mensaje del contacto fue ENTRANTE y no hay un saliente posterior
    // Como ya están ordenados desc, el primer evento es el más reciente
  }

  // Calcular hasUnread real recorriendo de nuevo (último mensaje de cada conversación)
  for (const conv of byContact.values()) {
    const last = conv.lastMessage;
    conv.hasUnread = last?.direction === 'entrante';
  }

  local.conversations = Array.from(byContact.values()).sort((a, b) =>
    new Date(b.lastMessage.event_at) - new Date(a.lastMessage.event_at)
  );
}

async function loadThread(contactId) {
  // Optimización: en vez de traer todos los timeline_events del sistema y
  // filtrar por contact_id en cliente, primero traemos los IDs de las
  // oportunidades del contacto y filtramos en server con .in()
  const { data: opps, error: oppsErr } = await supabase
    .from('opportunities')
    .select('id')
    .eq('contact_id', contactId)
    .is('deleted_at', null);

  if (oppsErr) {
    console.error(oppsErr);
    toast('Error cargando hilo', oppsErr.message, 'error');
    local.thread = [];
    return;
  }

  const oppIds = (opps || []).map(o => o.id);
  if (!oppIds.length) {
    local.thread = [];
    return;
  }

  const { data, error } = await supabase
    .from('timeline_events')
    .select(`
      id, event_type, channel, direction, title, body, event_at, is_system, user_id, metadata,
      user:users_profile!user_id(full_name, avatar_initials),
      opportunity:opportunities!opportunity_id(
        id, opp_code, stage, contact_id,
        contact:contacts!contact_id(id, full_name)
      )
    `)
    .in('opportunity_id', oppIds)
    .order('event_at', { ascending: true });

  if (error) {
    console.error(error);
    toast('Error cargando hilo', error.message, 'error');
    return;
  }

  local.thread = data || [];
  // Detectar oportunidad por defecto para responder (la más reciente activa)
  const conv = local.conversations.find(c => c.contact.id === contactId);
  if (conv?.oppsList?.length) {
    // Por defecto: responder a la más reciente
    local.composer.oppId = conv.oppsList[0].id;
    if (conv.lastMessage?.channel) {
      local.composer.channel = conv.lastMessage.channel;
    }
  }
}

async function loadSellers() {
  const { data } = await supabase
    .from('users_profile')
    .select('id, full_name')
    .eq('role', 'vendedor')
    .eq('active', true)
    .is('deleted_at', null)
    .order('full_name');
  local.sellers = data || [];
}

/** Asigna (o reasigna) todas las oportunidades de la conversación a un vendedor. */
async function assignConversation(conv, sellerId) {
  const oppIds = conv.oppsList.map(o => o.id);
  if (!oppIds.length) { toast('Esta conversación no tiene oportunidad para asignar', null, 'warn'); return; }
  const value = sellerId || null;
  const { error } = await supabase
    .from('opportunities')
    .update({ assigned_to: value })
    .in('id', oppIds);
  if (error) { toast('Error al asignar', error.message, 'error'); return; }
  conv.assignedTo = value;
  const seller = local.sellers.find(s => s.id === value);
  toast(value ? 'Asignado' : 'Sin asignar', value ? `→ ${seller?.full_name || ''}` : 'La conversación volvió a la cola', 'ok');
  await loadConversations();
  renderUI();
}

// ============================================================
// RENDER
// ============================================================
function render() {
  const view = $('#view');
  view.innerHTML = `
    <div class="bandeja-wrap">
      <div class="bandeja-list" id="bandeja-list">
        <div class="bl-hd">
          <div class="bl-hd-row">
            <div class="page-num">MÓDULO 03 · BANDEJA</div>
            <div class="bl-hd-meta-wrap">
              <span class="bl-live" id="bl-live" title="Mensajes en vivo">● en vivo</span>
              <div class="bl-hd-meta" id="bl-hd-meta">cargando…</div>
            </div>
          </div>
          <div class="bl-title">Bandeja <i>unificada</i></div>
          <div class="bl-filters">
            <select id="filter-channel" class="bl-filter">
              <option value="todos">Todos los canales</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="instagram">Instagram</option>
              <option value="email">Email</option>
              <option value="llamada">Llamadas</option>
            </select>
            <select id="filter-state" class="bl-filter">
              <option value="todos">Todas</option>
              <option value="unread">Sin responder</option>
              ${isSupervisorOrAdmin() ? '<option value="unassigned">Sin asignar</option>' : ''}
              <option value="mine">Solo mías</option>
            </select>
          </div>
        </div>
        <div class="bl-items" id="bl-items">
          <div class="empty">Cargando…</div>
        </div>
      </div>
      <div class="bandeja-thread" id="bandeja-thread">
        ${renderEmptyThread()}
      </div>
    </div>
  `;
  attachListHandlers();
}

function renderEmptyThread() {
  return `
    <div class="bt-empty">
      <div class="bt-empty-icon">✉</div>
      <div class="bt-empty-title">Seleccioná una conversación</div>
      <div class="bt-empty-desc">Elegí un contacto de la lista para ver el hilo completo y responder.</div>
    </div>
  `;
}

function renderUI() {
  renderConversationList();
  if (local.selectedContactId) {
    renderThread();
  }
}

function getFilteredConversations() {
  const me = currentUserId();
  return local.conversations.filter(c => {
    if (local.filters.channel !== 'todos' && !c.channels.has(local.filters.channel)) return false;
    if (local.filters.state === 'unread' && !c.hasUnread) return false;
    if (local.filters.state === 'unassigned' && c.assignedTo) return false;
    if (local.filters.state === 'mine' && c.assignedTo !== me) return false;
    if (local.filters.search) {
      const q = local.filters.search.toLowerCase();
      const hay = [c.contact.full_name, c.lastMessage?.body, c.contact.phone, c.contact.email]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderConversationList() {
  const filtered = getFilteredConversations();
  const list = $('#bl-items');
  const meta = $('#bl-hd-meta');

  const unassignedCount = local.conversations.filter(c => !c.assignedTo).length;
  meta.innerHTML = `<b>${filtered.length}</b> de ${local.conversations.length} · <b>${local.conversations.filter(c => c.hasUnread).length}</b> sin responder${isSupervisorOrAdmin() && unassignedCount ? ` · <b>${unassignedCount}</b> sin asignar` : ''}`;

  if (!local.conversations.length) {
    list.innerHTML = `<div class="empty">Sin mensajes todavía</div>`;
    return;
  }
  if (!filtered.length) {
    list.innerHTML = `<div class="empty">Ningún resultado</div>`;
    return;
  }

  list.innerHTML = filtered.map(c => convItemHTML(c)).join('');

  // Marcar selected
  if (local.selectedContactId) {
    const sel = list.querySelector(`[data-contact-id="${local.selectedContactId}"]`);
    sel?.classList.add('selected');
  }
}

function convItemHTML(c) {
  const last = c.lastMessage;
  const lastBody = last?.body || last?.title || '—';
  const isOutgoing = last?.direction === 'saliente';
  const channel = last?.channel || 'nota_interna';
  const channelIcon = CHANNEL_ICONS[channel] || '·';
  const channelColor = CHANNEL_COLORS[channel] || 'var(--cc-muted)';

  return `
    <div class="bl-item ${c.hasUnread ? 'unread' : ''}" data-contact-id="${c.contact.id}">
      <div class="bli-channel" style="color: ${channelColor}">${channelIcon}</div>
      <div class="bli-body">
        <div class="bli-top">
          <div class="bli-name">${escapeHtml(c.contact.full_name)}</div>
          <div class="bli-time">${escapeHtml(fmt.relative(last.event_at))}</div>
        </div>
        <div class="bli-preview">
          ${isOutgoing ? '<span class="bli-out">tú: </span>' : ''}${escapeHtml(fmt.truncate(lastBody, 80))}
        </div>
        <div class="bli-meta">
          <span class="bli-channel-tag">${escapeHtml(CHANNEL_LABELS[channel] || channel)}</span>
          ${c.oppsList[0] ? `<span class="bli-opp">${escapeHtml(c.oppsList[0].opp_code)}</span>` : ''}
          ${isSupervisorOrAdmin() && !c.assignedTo ? '<span class="bli-unassigned">SIN ASIGNAR</span>' : ''}
          ${c.msgCount > 1 ? `<span class="bli-count">${c.msgCount} msgs</span>` : ''}
          ${c.hasUnread ? '<span class="bli-dot">●</span>' : ''}
        </div>
      </div>
    </div>
  `;
}

function renderThread() {
  const thread = $('#bandeja-thread');
  if (!local.selectedContactId) {
    thread.innerHTML = renderEmptyThread();
    return;
  }
  const conv = local.conversations.find(c => c.contact.id === local.selectedContactId);
  if (!conv) {
    thread.innerHTML = renderEmptyThread();
    return;
  }

  const messages = local.thread.filter(m => m.event_type === 'mensaje' || m.event_type === 'llamada');

  thread.innerHTML = `
    <div class="bt-hd">
      <div class="bt-hd-row">
        <button class="btn btn-ghost btn-sm bt-back" id="bt-back">← Volver</button>
        <div class="bt-hd-info">
          <div class="bt-hd-name">${escapeHtml(conv.contact.full_name)}</div>
          <div class="bt-hd-meta">
            ${conv.contact.phone ? `<span>${escapeHtml(fmt.phone(conv.contact.phone))}</span>` : ''}
            ${conv.contact.email ? `<span>· ${escapeHtml(conv.contact.email)}</span>` : ''}
          </div>
        </div>
        <div class="bt-hd-actions">
          ${isSupervisorOrAdmin() ? `
            <div class="bt-assign ${conv.assignedTo ? '' : 'is-unassigned'}">
              <label>Vendedor</label>
              <select id="bt-assign-select">
                <option value="">— Sin asignar —</option>
                ${local.sellers.map(s => `<option value="${s.id}" ${s.id === conv.assignedTo ? 'selected' : ''}>${escapeHtml(s.full_name)}</option>`).join('')}
              </select>
            </div>
          ` : ''}
          ${conv.oppsList.length > 0 ? `
            <button class="btn btn-ghost btn-sm" id="bt-go-opp">
              Ver ${escapeHtml(conv.oppsList[0].opp_code)} →
            </button>
          ` : ''}
        </div>
      </div>
      <div class="bt-hd-opps">
        ${conv.oppsList.map(o => `
          <a class="bt-opp-pill" data-route="/pipeline/${o.opp_code.toLowerCase()}">
            ${escapeHtml(o.opp_code)} · ${escapeHtml(o.stage)}
          </a>
        `).join('')}
      </div>
    </div>

    <div class="bt-messages" id="bt-messages">
      ${messages.length ? messages.map(messageBubbleHTML).join('') : '<div class="empty">Sin mensajes</div>'}
    </div>

    <div class="bt-composer">
      <div class="btc-tabs">
        ${['whatsapp', 'instagram', 'email', 'llamada', 'nota_interna'].map(ch => `
          <div class="btc-tab ${local.composer.channel === ch ? 'active' : ''}" data-ch="${ch}">
            ${CHANNEL_ICONS[ch]} ${CHANNEL_LABELS[ch]}
          </div>
        `).join('')}
      </div>
      ${conv.oppsList.length > 1 ? `
        <div class="btc-opp-select">
          <label>Asociar a:</label>
          <select id="btc-opp">
            ${conv.oppsList.map(o => `
              <option value="${o.id}" ${o.id === local.composer.oppId ? 'selected' : ''}>${o.opp_code} · ${o.stage}</option>
            `).join('')}
          </select>
        </div>
      ` : ''}
      <textarea id="btc-text" placeholder="${composerPlaceholder()}" rows="4"></textarea>
      <div id="btc-audio" class="btc-audio"></div>
      <div class="btc-actions">
        <button class="btn btn-ghost btn-sm" id="btc-mic" title="Grabar nota de voz">🎤 Audio</button>
        <button class="btn btn-ghost btn-sm" id="btc-suggest">◆ Sugerir respuesta</button>
        <button class="btn btn-sm" id="btc-send">Registrar</button>
      </div>
    </div>
  `;

  attachThreadHandlers();

  // Auto-scroll al final
  const msgsEl = $('#bt-messages');
  if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
}

function messageBubbleHTML(ev) {
  const isIn = ev.direction === 'entrante';
  const isSys = ev.is_system;
  const channel = ev.channel || 'nota_interna';

  if (isSys) {
    return `
      <div class="bt-msg-system">
        <div class="bt-msg-system-line">${escapeHtml(ev.title)}</div>
        <div class="bt-msg-system-time">${escapeHtml(fmt.datetime(ev.event_at))}</div>
      </div>
    `;
  }

  return `
    <div class="bt-msg ${isIn ? 'in' : 'out'}">
      <div class="bt-msg-bubble">
        <div class="bt-msg-meta">
          <span class="bt-msg-channel">${CHANNEL_ICONS[channel]} ${escapeHtml(CHANNEL_LABELS[channel] || channel)}</span>
          ${ev.user?.full_name && !isIn ? `<span class="bt-msg-author">· ${escapeHtml(ev.user.full_name)}</span>` : ''}
        </div>
        ${ev.metadata?.audio_url
          ? `<audio class="bt-audio" controls preload="none" src="${escapeHtml(ev.metadata.audio_url)}"></audio>`
          : `<div class="bt-msg-body">${escapeHtml(ev.body || ev.title || '—').replace(/\n/g, '<br>')}</div>`}
        <div class="bt-msg-time">${escapeHtml(fmt.datetime(ev.event_at))}</div>
      </div>
    </div>
  `;
}

function composerPlaceholder() {
  const ch = local.composer.channel;
  if (ch === 'nota_interna') return 'Anotar algo (no se manda al cliente)…';
  return `Escribir mensaje por ${CHANNEL_LABELS[ch].toLowerCase()}…`;
}

// ============================================================
// HANDLERS
// ============================================================
function attachListHandlers() {
  // Filtros
  $('#filter-channel').addEventListener('change', (e) => {
    local.filters.channel = e.target.value;
    renderConversationList();
  });
  $('#filter-state').addEventListener('change', (e) => {
    local.filters.state = e.target.value;
    renderConversationList();
  });

  // Click en item de la lista
  $('#bl-items').addEventListener('click', (e) => {
    const item = e.target.closest('.bl-item');
    if (!item) return;
    const cid = item.dataset.contactId;
    navigate(`/bandeja/${cid}`);
  });

  // Búsqueda con topbar
  const searchInput = $('#search');
  if (searchInput) {
    if (local.searchHandler) searchInput.removeEventListener('input', local.searchHandler);
    local.searchHandler = debounce((e) => {
      local.filters.search = e.target.value.trim();
      renderConversationList();
    }, 200);
    searchInput.addEventListener('input', local.searchHandler);
    searchInput.value = local.filters.search || '';
  }
}

function attachThreadHandlers() {
  $('#bt-back')?.addEventListener('click', () => navigate('/bandeja'));

  const conv = local.conversations.find(c => c.contact.id === local.selectedContactId);

  $('#bt-go-opp')?.addEventListener('click', () => {
    if (conv?.oppsList?.[0]) {
      navigate(`/pipeline/${conv.oppsList[0].opp_code.toLowerCase()}`);
    }
  });

  // Asignación de vendedor (supervisor/admin)
  $('#bt-assign-select')?.addEventListener('change', (e) => {
    if (conv) assignConversation(conv, e.target.value || null);
  });

  // Composer tabs
  $$('.btc-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      local.composer.channel = tab.dataset.ch;
      $$('.btc-tab').forEach(t => t.classList.toggle('active', t === tab));
      const ta = $('#btc-text');
      if (ta) ta.placeholder = composerPlaceholder();
    });
  });

  // Composer opp selector
  $('#btc-opp')?.addEventListener('change', (e) => {
    local.composer.oppId = e.target.value;
  });

  // Sugerir respuesta IA
  $('#btc-suggest')?.addEventListener('click', async () => {
    const btn = $('#btc-suggest');
    btn.disabled = true;
    btn.textContent = 'Pensando…';
    try {
      const conv = local.conversations.find(c => c.contact.id === local.selectedContactId);
      const result = await suggestReply({
        contact: conv?.contact,
        last_messages: local.thread.slice(-5),
        goal: 'avanzar',
      });
      $('#btc-text').value = result.reply || '';
      if (result._mock) toast('Sugerencia (mock)', 'Edge function aún no deployada', 'info');
    } catch (err) {
      toast('Error generando sugerencia', err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '◆ Sugerir respuesta';
    }
  });

  // Enviar / registrar mensaje
  $('#btc-send')?.addEventListener('click', sendComposer);

  // Grabar / enviar audio
  $('#btc-mic')?.addEventListener('click', toggleRecording);
}

// ============================================================
// AUDIO (nota de voz)
// ============================================================
const audioRec = { recorder: null, chunks: [], stream: null, timer: null, seconds: 0, blob: null };

async function toggleRecording() {
  if (audioRec.recorder && audioRec.recorder.state === 'recording') {
    stopRecording();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    toast('Audio no soportado', 'Tu navegador no permite grabar audio', 'warn');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioRec.stream = stream;
    audioRec.chunks = [];
    audioRec.blob = null;
    const rec = new MediaRecorder(stream);
    audioRec.recorder = rec;
    rec.ondataavailable = (e) => { if (e.data.size) audioRec.chunks.push(e.data); };
    rec.onstop = () => {
      audioRec.blob = new Blob(audioRec.chunks, { type: rec.mimeType || 'audio/webm' });
      renderAudioPreview();
    };
    rec.start();
    audioRec.seconds = 0;
    const mic = $('#btc-mic');
    mic.classList.add('recording');
    mic.innerHTML = '■ Detener 0:00';
    audioRec.timer = setInterval(() => {
      audioRec.seconds++;
      const m = Math.floor(audioRec.seconds / 60), s = audioRec.seconds % 60;
      mic.innerHTML = `■ Detener ${m}:${String(s).padStart(2, '0')}`;
      if (audioRec.seconds >= 120) stopRecording(); // tope 2 min
    }, 1000);
  } catch (err) {
    toast('No se pudo acceder al micrófono', err.message, 'error');
  }
}

function stopRecording() {
  if (audioRec.timer) { clearInterval(audioRec.timer); audioRec.timer = null; }
  if (audioRec.recorder && audioRec.recorder.state !== 'inactive') audioRec.recorder.stop();
  audioRec.stream?.getTracks().forEach(t => t.stop());
  const mic = $('#btc-mic');
  if (mic) { mic.classList.remove('recording'); mic.innerHTML = '🎤 Audio'; }
}

function discardAudio() {
  audioRec.blob = null; audioRec.chunks = [];
  const host = $('#btc-audio'); if (host) host.innerHTML = '';
}

function renderAudioPreview() {
  const host = $('#btc-audio');
  if (!host || !audioRec.blob) return;
  const url = URL.createObjectURL(audioRec.blob);
  host.innerHTML = `
    <div class="btc-audio-prev">
      <audio controls src="${url}"></audio>
      <button class="btn btn-ok btn-sm" id="btc-audio-send">Enviar audio</button>
      <button class="btn btn-ghost btn-sm" id="btc-audio-del">Descartar</button>
    </div>`;
  $('#btc-audio-del').addEventListener('click', discardAudio);
  $('#btc-audio-send').addEventListener('click', sendAudio);
}

async function sendAudio() {
  const conv = local.conversations.find(c => c.contact.id === local.selectedContactId);
  if (!conv) { toast('Conversación no encontrada', null, 'error'); return; }
  let oppId = local.composer.oppId || conv.oppsList[0]?.id;
  if (!oppId) { toast('Vinculá la conversación a una oportunidad primero', null, 'warn'); return; }
  if (!audioRec.blob) return;

  const sendBtn = $('#btc-audio-send');
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Subiendo…'; }
  try {
    const path = `${oppId}/${Date.now()}.webm`;
    const { error: upErr } = await supabase.storage.from('whatsapp-media')
      .upload(path, audioRec.blob, { contentType: audioRec.blob.type || 'audio/webm', upsert: false });
    if (upErr) throw upErr;
    const { data: pub } = supabase.storage.from('whatsapp-media').getPublicUrl(path);
    const audioUrl = pub?.publicUrl;

    const { error: evErr } = await supabase.from('timeline_events').insert({
      opportunity_id: oppId,
      event_type: 'mensaje',
      channel: 'whatsapp',
      direction: 'saliente',
      title: 'Nota de voz · WhatsApp',
      body: '🎤 Audio',
      user_id: currentUserId(),
      is_system: false,
      metadata: { audio_url: audioUrl, kind: 'audio' },
    });
    if (evErr) throw evErr;

    // Despachar a WhatsApp vía n8n
    if (conv.contact?.phone) {
      const r = await sendWhatsApp({ to: conv.contact.phone, audioUrl, opportunityId: oppId, contactId: conv.contact.id });
      if (r.ok) toast('Audio enviado', null, 'ok');
      else if (r.mock) toast('Audio guardado', 'WhatsApp aún no conectado', 'warn');
      else toast('Guardado, envío falló', r.error, 'warn');
    } else {
      toast('Audio guardado', null, 'ok');
    }

    discardAudio();
    await loadThread(local.selectedContactId);
    await loadConversations();
    renderUI();
  } catch (err) {
    console.error(err);
    toast('Error con el audio', err.message, 'error');
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Enviar audio'; }
  }
}

async function sendComposer() {
  const text = $('#btc-text').value.trim();
  if (!text) {
    toast('Escribí algo primero', null, 'warn');
    return;
  }

  const btn = $('#btc-send');
  btn.disabled = true;
  btn.textContent = 'Guardando…';

  try {
    const conv = local.conversations.find(c => c.contact.id === local.selectedContactId);
    if (!conv) throw new Error('Conversación no encontrada');

    let oppId = local.composer.oppId;
    // Si no hay opp seleccionada pero hay alguna en la conversación, tomar la primera
    if (!oppId && conv.oppsList[0]) oppId = conv.oppsList[0].id;
    if (!oppId) throw new Error('Necesitás vincular el mensaje a una oportunidad');

    const ch = local.composer.channel;
    const evType = ch === 'nota_interna' ? 'nota' :
                   ch === 'llamada' ? 'llamada' : 'mensaje';
    const channel = ch;

    const { error } = await supabase.from('timeline_events').insert({
      opportunity_id: oppId,
      event_type: evType,
      channel,
      direction: ch === 'nota_interna' ? null : 'saliente',
      title: ch === 'nota_interna' ? 'Nota interna' : `Mensaje · ${CHANNEL_LABELS[ch]}`,
      body: text,
      user_id: currentUserId(),
      is_system: false,
    });
    if (error) throw error;

    $('#btc-text').value = '';

    // Si es WhatsApp, despachar a través de n8n (Meta). El mensaje ya
    // quedó en el historial; el envío real es responsabilidad de n8n.
    if (ch === 'whatsapp' && conv.contact?.phone) {
      const r = await sendWhatsApp({
        to: conv.contact.phone,
        text,
        opportunityId: oppId,
        contactId: conv.contact.id,
      });
      if (r.ok) toast('Enviado por WhatsApp', null, 'ok');
      else if (r.mock) toast('Registrado', 'WhatsApp aún no conectado · guardado en el historial', 'warn');
      else toast('Registrado, pero el envío falló', r.error, 'warn');
    } else {
      toast('Registrado', null, 'ok');
    }

    // Recargar hilo y lista
    await loadThread(local.selectedContactId);
    await loadConversations();
    renderUI();
  } catch (err) {
    console.error(err);
    toast('Error', err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Registrar';
  }
}

// ============================================================
// STYLES
// ============================================================
const styles = `
  .bandeja-wrap {
    display: grid;
    grid-template-columns: 1fr;
    height: calc(100vh - 56px);
    background: var(--cc-line);
    gap: 1px;
  }
  @container app (min-width: 800px) {
    .bandeja-wrap { grid-template-columns: 380px 1fr; }
  }

  /* LIST */
  .bandeja-list { background: var(--cc-bg); display: flex; flex-direction: column; min-height: 0; }
  .bl-hd { padding: 18px 18px 12px; border-bottom: 1px solid var(--cc-line); flex-shrink: 0; }
  .bl-hd-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .bl-hd-meta { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); letter-spacing: 0.05em; }
  .bl-hd-meta b { color: var(--cc-ink); font-weight: 600; }
  .bl-hd-meta-wrap { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .bl-live { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--cc-muted); display: inline-flex; align-items: center; gap: 4px; opacity: 0.6; }
  .bl-live::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--cc-steel); }
  .bl-live.on { color: var(--cc-ok); opacity: 1; }
  .bl-live.on::before { background: var(--cc-ok); animation: bl-pulse 1.6s ease-in-out infinite; }
  @keyframes bl-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .bl-title { font-family: var(--cc-font-display); font-weight: 300; font-size: 26px; letter-spacing: -0.02em; line-height: 1; margin-bottom: 14px; }
  .bl-title i { font-style: italic; font-weight: 500; }
  .bl-filters { display: flex; gap: 6px; }
  .bl-filter { flex: 1; padding: 6px 8px; border: 1px solid var(--cc-line); background: var(--cc-surface); font-family: inherit; font-size: 11px; }
  .bl-items { flex: 1; overflow-y: auto; min-height: 0; }
  .bl-items::-webkit-scrollbar { width: 4px; }
  .bl-items::-webkit-scrollbar-thumb { background: var(--cc-line); }

  .bl-item { display: flex; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--cc-line-soft); cursor: pointer; transition: background 0.1s; }
  .bl-item:hover { background: var(--cc-bg-alt); }
  .bl-item.selected { background: var(--cc-ink); color: var(--cc-bg); }
  .bl-item.selected .bli-name,
  .bl-item.selected .bli-preview,
  .bl-item.selected .bli-time { color: var(--cc-bg); }
  .bl-item.selected .bli-channel-tag,
  .bl-item.selected .bli-opp,
  .bl-item.selected .bli-count { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.2); color: var(--cc-platinum); }
  .bl-item.unread { background: var(--cc-warn-soft); }
  .bl-item.unread.selected { background: var(--cc-ink); }

  .bli-channel { font-size: 16px; flex-shrink: 0; padding-top: 2px; }
  .bli-body { flex: 1; min-width: 0; }
  .bli-top { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 2px; }
  .bli-name { font-weight: 500; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bli-time { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); flex-shrink: 0; }
  .bli-preview { font-size: 12px; color: var(--cc-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.4; margin-bottom: 4px; }
  .bli-out { color: var(--cc-steel); font-style: italic; }
  .bli-meta { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
  .bli-channel-tag, .bli-opp, .bli-count { font-family: var(--cc-font-mono); font-size: 9px; padding: 1px 6px; background: var(--cc-bg-alt); border: 1px solid var(--cc-line); letter-spacing: 0.05em; color: var(--cc-muted); }
  .bli-dot { color: var(--cc-warn); font-size: 12px; margin-left: auto; }
  .bli-unassigned { font-family: var(--cc-font-mono); font-size: 8px; letter-spacing: 0.12em; padding: 1px 6px; background: var(--cc-danger-soft); border: 1px solid var(--cc-danger); color: var(--cc-danger); font-weight: 700; }
  .bl-item.selected .bli-unassigned { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.3); color: #fff; }

  .bt-assign { display: flex; align-items: center; gap: 6px; }
  .bt-assign label { font-family: var(--cc-font-mono); font-size: 8px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--cc-muted); }
  .bt-assign select { font-family: inherit; font-size: 12px; padding: 6px 8px; border: 1px solid var(--cc-line); background: var(--cc-surface); color: var(--cc-ink); }
  .bt-assign.is-unassigned select { border-color: var(--cc-danger); color: var(--cc-danger); background: var(--cc-danger-soft); }

  .btc-audio { margin-top: 8px; }
  .btc-audio-prev { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; background: var(--cc-bg-alt); border: 1px solid var(--cc-line); padding: 8px; }
  .btc-audio-prev audio { height: 34px; flex: 1; min-width: 160px; }
  #btc-mic.recording { background: var(--cc-danger); color: #fff; border-color: var(--cc-danger); animation: bl-pulse 1.2s ease-in-out infinite; }
  .bt-audio { width: 230px; max-width: 100%; height: 38px; margin: 2px 0 4px; }
  .bt-msg.out .bt-audio { filter: invert(0); }

  /* THREAD */
  .bandeja-thread { background: var(--cc-bg); display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .bt-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; padding: 60px 20px; text-align: center; color: var(--cc-muted); }
  .bt-empty-icon { font-size: 40px; margin-bottom: 14px; opacity: 0.3; }
  .bt-empty-title { font-family: var(--cc-font-display); font-weight: 300; font-size: 22px; color: var(--cc-ink); margin-bottom: 6px; }
  .bt-empty-desc { font-size: 13px; max-width: 320px; line-height: 1.5; }

  .bt-hd { padding: 14px 20px 10px; border-bottom: 1px solid var(--cc-line); background: var(--cc-surface); flex-shrink: 0; }
  .bt-hd-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .bt-back { flex-shrink: 0; }
  @container app (min-width: 800px) { .bt-back { display: none; } }
  .bt-hd-info { flex: 1; min-width: 0; }
  .bt-hd-name { font-family: var(--cc-font-display); font-weight: 400; font-size: 22px; line-height: 1.1; }
  .bt-hd-meta { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); margin-top: 2px; letter-spacing: 0.05em; display: flex; gap: 6px; flex-wrap: wrap; }
  .bt-hd-actions { display: flex; gap: 6px; }
  .bt-hd-opps { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
  .bt-opp-pill { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; padding: 3px 10px; background: var(--cc-bg-alt); border: 1px solid var(--cc-line); color: var(--cc-ink); cursor: pointer; text-decoration: none; }
  .bt-opp-pill:hover { background: var(--cc-ink); color: var(--cc-bg); border-color: var(--cc-ink); }

  .bt-messages { flex: 1; overflow-y: auto; padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
  .bt-messages::-webkit-scrollbar { width: 6px; }
  .bt-messages::-webkit-scrollbar-thumb { background: var(--cc-line); }

  .bt-msg { display: flex; }
  .bt-msg.in { justify-content: flex-start; }
  .bt-msg.out { justify-content: flex-end; }
  .bt-msg-bubble { max-width: 75%; padding: 10px 14px; border: 1px solid var(--cc-line); background: var(--cc-surface); }
  .bt-msg.in .bt-msg-bubble { border-left: 3px solid var(--cc-info); }
  .bt-msg.out .bt-msg-bubble { background: var(--cc-ink); color: var(--cc-bg); border-color: var(--cc-ink); }
  .bt-msg-meta { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--cc-muted); margin-bottom: 4px; display: flex; gap: 4px; }
  .bt-msg.out .bt-msg-meta { color: var(--cc-platinum); }
  .bt-msg-author { font-style: normal; }
  .bt-msg-body { font-size: 13px; line-height: 1.5; word-wrap: break-word; }
  .bt-msg-time { font-family: var(--cc-font-mono); font-size: 9px; color: var(--cc-muted); margin-top: 6px; letter-spacing: 0.05em; }
  .bt-msg.out .bt-msg-time { color: var(--cc-platinum); }

  .bt-msg-system { text-align: center; padding: 6px 0; }
  .bt-msg-system-line { display: inline-block; padding: 4px 12px; font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--cc-muted); background: var(--cc-bg-alt); border: 1px solid var(--cc-line-soft); }
  .bt-msg-system-time { font-family: var(--cc-font-mono); font-size: 9px; color: var(--cc-steel); margin-top: 2px; }

  /* COMPOSER */
  .bt-composer { border-top: 1px solid var(--cc-line); background: var(--cc-surface); flex-shrink: 0; }
  .btc-tabs { display: flex; border-bottom: 1px solid var(--cc-line-soft); }
  .btc-tab { padding: 10px 14px; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--cc-muted); cursor: pointer; border-right: 1px solid var(--cc-line-soft); font-weight: 500; flex: 1; text-align: center; }
  .btc-tab:last-child { border-right: none; }
  .btc-tab.active { background: var(--cc-ink); color: var(--cc-bg); }
  .btc-opp-select { padding: 8px 14px; border-bottom: 1px solid var(--cc-line-soft); display: flex; align-items: center; gap: 8px; font-size: 11px; }
  .btc-opp-select label { color: var(--cc-muted); font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase; }
  .btc-opp-select select { flex: 1; padding: 4px 8px; border: 1px solid var(--cc-line); font-family: inherit; font-size: 11px; background: var(--cc-bg); }
  #btc-text { width: 100%; padding: 12px 14px; border: none; background: transparent; font-family: inherit; font-size: 13px; resize: vertical; min-height: 80px; color: var(--cc-ink); }
  #btc-text:focus { outline: none; }
  .btc-actions { display: flex; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--cc-line-soft); justify-content: flex-end; }

  /* En mobile, cuando hay thread seleccionado, esconder la lista */
  @container app (max-width: 799px) {
    .bandeja-list:not(:has(+ .bandeja-thread > .bt-empty)):has(+ .bandeja-thread > .bt-hd) {
      display: none;
    }
  }
`;
