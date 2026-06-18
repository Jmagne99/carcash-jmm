// ============================================================
// CARCASH · NOTIFICATIONS HELPER
// Lifecycle: poll cada 30s + actualiza badge en topbar.
// Click en una notificación → mark read + navega al link.
// ============================================================

import { supabase } from './supabase-client.js';
import { state } from './state.js';
import { fmt, escapeHtml } from './formatters.js';
import { $, el, toast } from './dom.js';

const POLL_INTERVAL_MS = 30 * 1000;
let pollTimer = null;
let lastSeenIds = new Set();

const TYPE_ICONS = {
  new_sale: '💰',
  sale_delivered: '🚗',
  new_lead: '🎯',
  unassigned_lead: '📥',
  urgent_action: '⚠',
  default: '🔔',
};

export async function startNotifications() {
  if (!state.profile) return;
  await fetchAndUpdate(true);
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => fetchAndUpdate(false), POLL_INTERVAL_MS);
  setupBellHandlers();
}

export function stopNotifications() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  lastSeenIds.clear();
}

async function fetchAndUpdate(initialLoad) {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('recipient_id', state.profile.id)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) {
      console.warn('notifications fetch error', error);
      return;
    }
    const list = data || [];
    const unread = list.filter(n => !n.read_at);

    // Detectar nuevas (no estaban en lastSeenIds y son recientes)
    if (!initialLoad) {
      const newOnes = unread.filter(n => !lastSeenIds.has(n.id));
      newOnes.forEach(n => {
        toast(n.title, n.body, 'info');
      });
    }
    lastSeenIds = new Set(unread.map(n => n.id));

    updateBadge(unread.length);
    updateDropdown(list);
  } catch (err) {
    console.warn('notifications loop error', err);
  }
}

function updateBadge(count) {
  const badge = $('#notif-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function updateDropdown(list) {
  const body = $('#notif-list');
  if (!body) return;

  if (!list.length) {
    body.innerHTML = `<div class="notif-empty">Sin notificaciones todavía</div>`;
    return;
  }

  body.innerHTML = list.map(n => {
    const icon = TYPE_ICONS[n.type] || TYPE_ICONS.default;
    const unread = !n.read_at;
    const code = n.metadata?.opp_code || '';
    const canReQualify = LEAD_ALERT_TYPES.has(n.type) && code;
    return `
      <div class="notif-item ${unread ? 'unread' : ''}" data-id="${n.id}" data-link="${escapeHtml(n.link || '')}">
        <div class="notif-icon">${icon}</div>
        <div class="notif-body">
          <div class="notif-title">${escapeHtml(n.title)}</div>
          ${n.body ? `<div class="notif-desc">${escapeHtml(n.body)}</div>` : ''}
          <div class="notif-time">${escapeHtml(fmt.relative(n.created_at))}</div>
          ${canReQualify ? renderNotifActions(n.id, code) : ''}
        </div>
        ${unread ? '<div class="notif-dot"></div>' : ''}
      </div>
    `;
  }).join('');

  body.onclick = async (e) => {
    // Acciones rápidas de recalificación (no navegan)
    const act = e.target.closest('[data-na]');
    if (act) {
      e.stopPropagation();
      await handleNotifAction(act);
      return;
    }
    const item = e.target.closest('.notif-item');
    if (!item) return;
    const id = item.dataset.id;
    const link = item.dataset.link;
    await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', id);
    $('#notif-dropdown')?.classList.remove('open');
    if (link) location.hash = '#' + link;
    fetchAndUpdate(true);
  };
}

// Tipos de alerta de lead que se pueden recalificar al vuelo
const LEAD_ALERT_TYPES = new Set([
  'lead_cold', 'lead_uncontacted', 'opp_stale', 'new_lead', 'unassigned_lead', 'quote_no_response', 'urgent_action',
]);
const LOSS_REASONS = [
  ['compro_en_competencia', 'Compró en otra agencia'],
  ['precio', 'Precio'],
  ['no_respondio', 'No respondió'],
  ['no_califica_credito', 'No califica crédito'],
  ['cambio_de_planes', 'Cambió de planes'],
  ['otro', 'Otro'],
];

function renderNotifActions(nid, code) {
  return `
    <div class="notif-actions" data-nid="${nid}" data-opp="${escapeHtml(code)}">
      <button class="na-btn ok" data-na="contacted">Contacté</button>
      <button class="na-btn" data-na="snooze">Llamar +1d</button>
      <button class="na-btn danger" data-na="lost-open">Perdido ▾</button>
      <div class="na-reasons hidden">
        ${LOSS_REASONS.map(([v, l]) => `<button class="na-reason" data-na="lost" data-reason="${v}">${l}</button>`).join('')}
      </div>
    </div>
  `;
}

async function handleNotifAction(elBtn) {
  const wrap = elBtn.closest('.notif-actions');
  if (!wrap) return;
  const code = wrap.dataset.opp;
  const nid = wrap.dataset.nid;
  const action = elBtn.dataset.na;

  if (action === 'lost-open') {
    wrap.querySelector('.na-reasons')?.classList.toggle('hidden');
    return;
  }

  // Resolver la oportunidad por código
  const { data: opp } = await supabase
    .from('opportunities').select('id').ilike('opp_code', code).maybeSingle();
  if (!opp) { toast('No se encontró la oportunidad', null, 'error'); return; }

  try {
    if (action === 'contacted') {
      await supabase.from('timeline_events').insert({
        opportunity_id: opp.id, event_type: 'llamada', channel: 'llamada',
        direction: 'saliente', title: 'Contacto registrado desde alerta',
        user_id: state.profile?.id, is_system: false,
      });
      toast('Contacto registrado', null, 'ok');
    } else if (action === 'snooze') {
      const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(10, 0, 0, 0);
      await supabase.from('opportunities').update({
        next_action_title: 'Llamar al cliente', next_action_due_at: t.toISOString(), next_action_done: false,
      }).eq('id', opp.id);
      toast('Reprogramado para mañana 10:00', null, 'ok');
    } else if (action === 'lost') {
      const reason = elBtn.dataset.reason;
      await supabase.from('opportunities').update({
        stage: 'perdida', loss_reason: reason, lost_at: new Date().toISOString(), next_action_done: true,
      }).eq('id', opp.id);
      const label = (LOSS_REASONS.find(r => r[0] === reason) || [])[1] || 'Perdida';
      toast('Oportunidad recalificada', label, 'warn');
    }
    // Marcar la notificación como leída y refrescar
    if (nid) await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', nid);
    fetchAndUpdate(true);
  } catch (err) {
    toast('Error', err.message, 'error');
  }
}

function setupBellHandlers() {
  const bell = $('#notif-bell');
  const dropdown = $('#notif-dropdown');
  if (!bell || !dropdown) return;

  bell.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
    fetchAndUpdate(true);
  });
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target) && !bell.contains(e.target)) {
      dropdown.classList.remove('open');
    }
  });

  $('#notif-mark-all')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await supabase.rpc('notifications_mark_all_read');
    fetchAndUpdate(true);
  });
}
