// ============================================================
// CARCASH · MÓDULO FICHA 360° DE OPORTUNIDAD
// Rutas:
//   /pipeline/nueva → formulario de creación
//   /pipeline/:id   → ficha 360° (timeline, composer, panel datos, IA)
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { state, isAdmin, currentUserId } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles, confirmDialog, debounce } from '../lib/dom.js';
import { navigate } from '../lib/router.js';
import { analyzeOpportunity, suggestReply } from '../lib/ai.js';

// ============================================================
// CONFIG
// ============================================================
const STAGES = [
  { id: 'nuevo',       name: 'Nuevo' },
  { id: 'contactado',  name: 'Contactado' },
  { id: 'visita_test', name: 'Visita/Test' },
  { id: 'presupuesto', name: 'Presupuesto' },
  { id: 'negociacion', name: 'Negociación' },
  { id: 'reserva',     name: 'Reserva' },
  { id: 'ganada',      name: 'Ganada' },
  { id: 'perdida',     name: 'Perdida' },
];

const ORIGINS = [
  { id: 'mercado_libre', label: 'Mercado Libre' },
  { id: 'instagram',     label: 'Instagram' },
  { id: 'meta_ads',      label: 'Meta Ads' },
  { id: 'whatsapp',      label: 'WhatsApp' },
  { id: 'web',           label: 'Web propia' },
  { id: 'walk_in',       label: 'Walk-in (showroom)' },
  { id: 'referido',      label: 'Referido' },
  { id: 'google_ads',    label: 'Google Ads' },
  { id: 'otro',          label: 'Otro' },
];

const CHANNEL_TABS = [
  { id: 'nota_interna', label: 'Nota interna', icon: '◆' },
  { id: 'whatsapp',     label: 'WhatsApp',     icon: '●' },
  { id: 'email',        label: 'Email',        icon: '✉' },
  { id: 'llamada',      label: 'Llamada',      icon: '☎' },
];

// ============================================================
// MOUNT
// ============================================================
export async function mount(params = {}) {
  injectStyles('ficha-oportunidad-styles', styles);

  if (!params.id || params.id === 'nueva') {
    await renderCreateForm(params);
  } else {
    await renderFicha(params.id);
  }
}

export default mount;

// ============================================================
// FETCH HELPERS
// ============================================================
async function fetchOpportunity(idOrCode) {
  // Permitir buscar tanto por uuid como por opp_code (case-insensitive)
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(idOrCode);
  let q = supabase
    .from('opportunities')
    .select(`
      *,
      contact:contacts(*),
      unit:units!unit_of_interest_id(*),
      assignee:users_profile!assigned_to(id, full_name, role)
    `)
    .is('deleted_at', null);

  if (isUuid) {
    q = q.eq('id', idOrCode);
  } else {
    q = q.ilike('opp_code', idOrCode.toUpperCase());
  }

  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  return data;
}

async function fetchTimeline(opportunityId) {
  const { data, error } = await supabase
    .from('timeline_events')
    .select('*, user:users_profile!user_id(full_name, avatar_initials)')
    .eq('opportunity_id', opportunityId)
    .order('event_at', { ascending: false });
  if (error) {
    console.error('timeline error', error);
    return [];
  }
  return data || [];
}

async function fetchContacts(search = '') {
  let q = supabase
    .from('contacts')
    .select('id, full_name, phone, email, dni_cuit')
    .is('deleted_at', null)
    .order('full_name')
    .limit(50);
  if (search) q = q.ilike('full_name', `%${search}%`);
  const { data, error } = await q;
  if (error) {
    console.error('contacts error', error);
    return [];
  }
  return data || [];
}

async function fetchUnitsAvailable() {
  const { data, error } = await supabase
    .from('units')
    .select('id, unit_code, brand, model, year, public_price, status')
    .is('deleted_at', null)
    .in('status', ['disponible', 'reservado'])
    .order('brand');
  if (error) {
    console.error('units error', error);
    return [];
  }
  return data || [];
}

async function fetchSellers() {
  const { data, error } = await supabase
    .from('users_profile')
    .select('id, full_name')
    .eq('active', true)
    .in('role', ['vendedor', 'gerente', 'dueno'])
    .order('full_name');
  if (error) return [];
  return data || [];
}

// ============================================================
// VISTA: FORMULARIO DE CREACIÓN
// ============================================================
async function renderCreateForm(params = {}) {
  const view = $('#view');
  view.innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">MÓDULO 02 · COMERCIAL</div>
          <div class="page-title">Nueva <i>oportunidad</i></div>
          <div class="page-sub">Cargá el lead nuevo. Si el contacto no existe, lo creás acá mismo.</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-ghost" id="btn-cancel">Cancelar</button>
          <button class="btn" id="btn-save">Crear oportunidad</button>
        </div>
      </div>
    </div>

    <form class="opp-form" id="opp-form" autocomplete="off">
      <div class="form-section">
        <div class="form-section-hd">Contacto</div>
        <div class="form-section-body">
          <div class="contact-picker">
            <input type="text" id="contact-search" placeholder="Buscar contacto por nombre…" />
            <div class="contact-results" id="contact-results"></div>
            <button type="button" class="btn btn-ghost btn-sm" id="btn-new-contact">+ Crear contacto nuevo</button>
            <div class="contact-selected" id="contact-selected" hidden></div>
            <div class="new-contact-form" id="new-contact-form" hidden>
              <div class="field-row">
                <div class="field"><label>Nombre completo</label><input id="nc-name" required></div>
                <div class="field"><label>DNI / CUIT</label><input id="nc-dni"></div>
              </div>
              <div class="field-row">
                <div class="field"><label>Teléfono</label><input id="nc-phone"></div>
                <div class="field"><label>Email</label><input id="nc-email" type="email"></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="form-section">
        <div class="form-section-hd">Unidad de interés</div>
        <div class="form-section-body">
          <div class="field">
            <label>Unidad</label>
            <select id="opp-unit">
              <option value="">— Sin unidad asignada (lead general)</option>
            </select>
          </div>
        </div>
      </div>

      <div class="form-section">
        <div class="form-section-hd">Origen y datos comerciales</div>
        <div class="form-section-body">
          <div class="field-row">
            <div class="field">
              <label>Origen del lead</label>
              <select id="opp-origin" required>
                ${ORIGINS.map(o => `<option value="${o.id}">${o.label}</option>`).join('')}
              </select>
            </div>
            <div class="field" id="seller-field" hidden>
              <label>Vendedor asignado</label>
              <select id="opp-assigned"></select>
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label>Monto esperado (USD)</label>
              <input type="number" id="opp-amount" min="0" step="500" placeholder="Ej: 145000">
            </div>
            <div class="field">
              <label>Etapa inicial</label>
              <select id="opp-stage">
                ${STAGES.filter(s => !['ganada','perdida'].includes(s.id)).map(s => `<option value="${s.id}" ${s.id === 'nuevo' ? 'selected' : ''}>${s.name}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label>
                <input type="checkbox" id="opp-trade-in" />
                Tiene auto en permuta
              </label>
            </div>
            <div class="field">
              <label>
                <input type="checkbox" id="opp-financing" />
                Necesita financiación
              </label>
            </div>
          </div>
        </div>
      </div>

      <div class="form-section">
        <div class="form-section-hd">Próxima acción</div>
        <div class="form-section-body">
          <div class="field-row">
            <div class="field" style="flex: 2">
              <label>Qué hay que hacer</label>
              <input type="text" id="opp-action" placeholder="Ej: Llamar para coordinar visita">
            </div>
            <div class="field">
              <label>Vencimiento</label>
              <input type="datetime-local" id="opp-action-due">
            </div>
          </div>
        </div>
      </div>
    </form>
  `;

  // Cargar selectors
  const [units, sellers] = await Promise.all([fetchUnitsAvailable(), fetchSellers()]);

  const unitSelect = $('#opp-unit');
  units.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.id;
    opt.textContent = `${u.brand} ${u.model} ${u.year} · ${u.unit_code} · USD ${fmt.usd(u.public_price)}`;
    unitSelect.appendChild(opt);
  });

  if (isAdmin()) {
    $('#seller-field').hidden = false;
    const sellerSelect = $('#opp-assigned');
    // Opción por defecto: reparto automático (round-robin entre vendedores)
    const autoOpt = document.createElement('option');
    autoOpt.value = '';
    autoOpt.textContent = '— Reparto automático —';
    sellerSelect.appendChild(autoOpt);
    sellers.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.full_name;
      sellerSelect.appendChild(opt);
    });
  }

  // Default vencimiento: hoy + 4hs
  const due = new Date(Date.now() + 4 * 3600 * 1000);
  due.setSeconds(0, 0);
  $('#opp-action-due').value = due.toISOString().slice(0, 16);

  attachCreateHandlers(params);
}

let selectedContact = null;

function attachCreateHandlers(params = {}) {
  const searchInput = $('#contact-search');
  const resultsEl = $('#contact-results');
  const selectedEl = $('#contact-selected');
  const newFormEl = $('#new-contact-form');
  const newBtn = $('#btn-new-contact');

  let lastResults = [];

  const doSearch = debounce(async (q) => {
    if (!q || q.length < 2) {
      resultsEl.innerHTML = '';
      return;
    }
    lastResults = await fetchContacts(q);
    resultsEl.innerHTML = '';
    lastResults.forEach(c => {
      const item = el('div', { class: 'contact-result-item', dataset: { id: c.id } },
        el('div', { class: 'crit-name' }, c.full_name),
        el('div', { class: 'crit-meta' }, [c.phone, c.email].filter(Boolean).join(' · ') || c.dni_cuit || '—')
      );
      resultsEl.appendChild(item);
    });
  }, 200);

  searchInput.addEventListener('input', (e) => doSearch(e.target.value.trim()));

  resultsEl.addEventListener('click', (e) => {
    const item = e.target.closest('.contact-result-item');
    if (!item) return;
    const c = lastResults.find(x => x.id === item.dataset.id);
    if (!c) return;
    selectContact(c);
  });

  newBtn.addEventListener('click', () => {
    selectedContact = null;
    newFormEl.hidden = false;
    selectedEl.hidden = true;
    resultsEl.innerHTML = '';
    searchInput.value = '';
    $('#nc-name').focus();
  });

  $('#btn-cancel').addEventListener('click', () => navigate('/pipeline'));
  $('#btn-save').addEventListener('click', submitNewOpportunity);

  function selectContact(c) {
    selectedContact = c;
    newFormEl.hidden = true;
    selectedEl.hidden = false;
    selectedEl.innerHTML = `
      <div class="cs-avatar">${escapeHtml(fmt.initials(c.full_name))}</div>
      <div class="cs-data">
        <div class="cs-name">${escapeHtml(c.full_name)}</div>
        <div class="cs-meta">${escapeHtml([c.phone, c.email].filter(Boolean).join(' · ') || c.dni_cuit || '—')}</div>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" id="cs-clear">Cambiar</button>
    `;
    $('#cs-clear').addEventListener('click', () => {
      selectedContact = null;
      selectedEl.hidden = true;
      searchInput.value = '';
      searchInput.focus();
    });
    resultsEl.innerHTML = '';
    searchInput.value = '';
  }

  // Preselección de contacto vía ?contact=<uuid> (ej: desde ficha de contacto)
  if (params.contact) {
    supabase
      .from('contacts')
      .select('id, full_name, phone, email, dni_cuit')
      .eq('id', params.contact)
      .maybeSingle()
      .then(({ data }) => { if (data) selectContact(data); });
  }
}

async function submitNewOpportunity() {
  const btn = $('#btn-save');
  btn.disabled = true;
  btn.textContent = 'Creando…';

  try {
    let contactId = selectedContact?.id;

    // Crear contacto si no hay seleccionado
    if (!contactId) {
      const name = $('#nc-name').value.trim();
      if (!name) {
        toast('Falta el contacto', 'Buscá un contacto existente o creá uno nuevo', 'error');
        btn.disabled = false;
        btn.textContent = 'Crear oportunidad';
        return;
      }
      const { data: newC, error: ncErr } = await supabase
        .from('contacts')
        .insert({
          full_name: name,
          dni_cuit: $('#nc-dni').value.trim() || null,
          phone: $('#nc-phone').value.trim() || null,
          email: $('#nc-email').value.trim() || null,
          created_by: currentUserId(),
        })
        .select()
        .single();
      if (ncErr) throw ncErr;
      contactId = newC.id;
    }

    const payload = {
      contact_id: contactId,
      // Si no se elige vendedor explícito, queda null → la base lo reparte
      // automáticamente (round-robin entre vendedores activos).
      assigned_to: $('#opp-assigned').value || null,
      unit_of_interest_id: $('#opp-unit').value || null,
      origin: $('#opp-origin').value,
      stage: $('#opp-stage').value,
      expected_amount: parseFloat($('#opp-amount').value) || null,
      has_trade_in: $('#opp-trade-in').checked,
      needs_financing: $('#opp-financing').checked,
      next_action_title: $('#opp-action').value.trim() || null,
      next_action_due_at: $('#opp-action-due').value ? new Date($('#opp-action-due').value).toISOString() : null,
      next_action_done: false,
      created_by: currentUserId(),
    };

    const { data, error } = await supabase
      .from('opportunities')
      .insert(payload)
      .select('id, opp_code')
      .single();
    if (error) throw error;

    // Crear evento de timeline
    await supabase.from('timeline_events').insert({
      opportunity_id: data.id,
      event_type: 'creacion',
      title: 'Oportunidad creada',
      body: `Lead manual · ${ORIGINS.find(o => o.id === payload.origin)?.label || payload.origin}`,
      user_id: currentUserId(),
      is_system: false,
    });

    toast(`${data.opp_code} creada`, 'Cargada en el pipeline', 'ok');
    navigate(`/pipeline/${data.opp_code.toLowerCase()}`);
  } catch (err) {
    console.error(err);
    toast('Error al crear oportunidad', err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Crear oportunidad';
  }
}

// ============================================================
// VISTA: FICHA 360°
// ============================================================
const local = {
  opp: null,
  timeline: [],
  composerTab: 'nota_interna',
  composerText: '',
};

async function renderFicha(idOrCode) {
  const view = $('#view');
  view.innerHTML = `<div class="empty">Cargando oportunidad…</div>`;

  try {
    local.opp = await fetchOpportunity(idOrCode);
    if (!local.opp) {
      view.innerHTML = `
        <div class="placeholder">
          <div class="placeholder-content">
            <div class="placeholder-num">404</div>
            <div class="placeholder-title">Oportunidad no <i>encontrada</i></div>
            <div class="placeholder-desc">No existe una oportunidad con código "${escapeHtml(idOrCode.toUpperCase())}".</div>
            <div class="placeholder-status" style="cursor:pointer" onclick="location.hash='#/pipeline'">VOLVER AL PIPELINE</div>
          </div>
        </div>
      `;
      return;
    }
    local.timeline = await fetchTimeline(local.opp.id);
    renderFichaUI();
  } catch (err) {
    console.error('renderFicha error', err);
    toast('Error cargando oportunidad', err.message, 'error');
  }
}

function renderFichaUI() {
  const opp = local.opp;
  const view = $('#view');
  const stageInfo = STAGES.find(s => s.id === opp.stage);
  const ageHours = Math.floor((Date.now() - new Date(opp.created_at).getTime()) / 3600000);
  const ageLabel = ageHours < 24 ? `${ageHours}h en curso` : `${Math.floor(ageHours / 24)}d en curso`;
  const aiAnalysis = opp.ai_analysis || {};
  const scoreClass = (opp.ai_score >= 85) ? 'hot' : (opp.ai_score >= 60 ? 'warm' : 'cold');
  const isUrgent = opp.next_action_due_at && new Date(opp.next_action_due_at) < new Date() && !opp.next_action_done;

  view.innerHTML = `
    <div class="ficha">
      <!-- HERO -->
      <div class="hero">
        <div class="hero-grid">
          <div class="hero-person">
            <div class="hero-av">${escapeHtml(fmt.initials(opp.contact?.full_name || '?'))}</div>
            <div>
              <div class="hero-id-row">
                ${escapeHtml(opp.opp_code)} · CREADA ${escapeHtml(fmt.dateAR(opp.created_at).toUpperCase())} · <b>${escapeHtml(ageLabel.toUpperCase())}</b>
              </div>
              <div class="hero-name">
                ${escapeHtml((opp.contact?.full_name || '').replace(/\b(\w+)$/, '|||$1|||')).replace(/\|\|\|(.+?)\|\|\|/, '<i>$1</i>')}
              </div>
              <div class="hero-tags">
                <span class="badge badge-stage" data-stage="${opp.stage}">${escapeHtml(stageInfo?.name || opp.stage)}</span>
                <span class="badge">${escapeHtml(originLabel(opp.origin))}</span>
                ${opp.contact?.is_recurrent ? '<span class="badge badge-info">RECURRENTE</span>' : ''}
                ${opp.contact?.tags?.map(t => `<span class="badge">${escapeHtml(t)}</span>`).join('') || ''}
              </div>
            </div>
          </div>
          <div class="hero-actions">
            <button class="btn btn-ghost" id="btn-back-pipeline">← Pipeline</button>
            <select class="stage-select" id="stage-select">
              ${STAGES.map(s => `<option value="${s.id}" ${s.id === opp.stage ? 'selected' : ''}>${s.name}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>

      <!-- BODY · 3 columnas -->
      <div class="ficha-body">
        <!-- TIMELINE + COMPOSER -->
        <div class="col-main">
          <div class="composer">
            <div class="composer-tabs" id="composer-tabs">
              ${CHANNEL_TABS.map(t => `<div class="comp-tab ${t.id === local.composerTab ? 'active' : ''}" data-tab="${t.id}">${t.icon} ${t.label}</div>`).join('')}
            </div>
            <textarea class="comp-textarea" id="composer-text" placeholder="Escribir…"></textarea>
            <div class="comp-actions">
              <button class="btn btn-ghost btn-sm" id="btn-ai-suggest">◆ Sugerir respuesta</button>
              <button class="btn btn-sm" id="btn-send">Registrar</button>
            </div>
          </div>

          <div class="timeline-section">
            <div class="section-hd">Timeline</div>
            <div class="timeline" id="timeline">
              ${renderTimelineHTML()}
            </div>
          </div>
        </div>

        <!-- DATOS / DEAL -->
        <div class="col-side">
          <div class="side-panel">
            <div class="sp-hd">Datos del cliente</div>
            <div class="sp-row"><span>Nombre</span><b>${escapeHtml(opp.contact?.full_name || '—')}</b></div>
            <div class="sp-row"><span>Teléfono</span><b>${escapeHtml(fmt.phone(opp.contact?.phone))}</b></div>
            <div class="sp-row"><span>Email</span><b>${escapeHtml(opp.contact?.email || '—')}</b></div>
            <div class="sp-row"><span>DNI/CUIT</span><b>${escapeHtml(opp.contact?.dni_cuit || '—')}</b></div>
            ${opp.contact?.city ? `<div class="sp-row"><span>Ciudad</span><b>${escapeHtml(opp.contact.city)}</b></div>` : ''}
            ${opp.contact?.profession ? `<div class="sp-row"><span>Profesión</span><b>${escapeHtml(opp.contact.profession)}</b></div>` : ''}
          </div>

          ${opp.unit ? `
          <div class="side-panel">
            <div class="sp-hd">Unidad de interés</div>
            ${opp.unit.main_photo_url ? `<img class="sp-photo" src="${escapeHtml(opp.unit.main_photo_url)}" alt="">` : ''}
            <div class="sp-row"><span>Modelo</span><b>${escapeHtml(opp.unit.brand + ' ' + opp.unit.model)}</b></div>
            <div class="sp-row"><span>Año</span><b>${opp.unit.year}</b></div>
            <div class="sp-row"><span>Kms</span><b>${escapeHtml(fmt.km(opp.unit.mileage))}</b></div>
            <div class="sp-row"><span>Color</span><b>${escapeHtml(opp.unit.color_exterior || '—')}</b></div>
            <div class="sp-row"><span>Precio público</span><b>USD ${escapeHtml(fmt.usd(opp.unit.public_price))}</b></div>
            <div class="sp-row"><a href="#/unidades/${opp.unit.unit_code?.toLowerCase()}" class="sp-link">Ver ficha completa →</a></div>
          </div>
          ` : `<div class="side-panel"><div class="sp-hd">Unidad</div><div class="sp-empty">Sin unidad asignada</div></div>`}

          <div class="side-panel">
            <div class="sp-hd">Deal</div>
            <div class="sp-row"><span>Monto esperado</span><b>USD ${escapeHtml(fmt.usd(opp.expected_amount))}</b></div>
            <div class="sp-row"><span>Permuta</span><b>${opp.has_trade_in ? 'Sí' : 'No'}</b></div>
            <div class="sp-row"><span>Financiación</span><b>${opp.needs_financing ? `Sí · USD ${fmt.usd(opp.financing_amount)}` : 'No'}</b></div>
            <div class="sp-row"><span>Vendedor</span><b>${escapeHtml(opp.assignee?.full_name || '—')}</b></div>
          </div>

          <div class="side-panel ${isUrgent ? 'urgent' : ''}">
            <div class="sp-hd">Próxima acción</div>
            ${opp.next_action_title ? `
              <div class="sp-action">${escapeHtml(opp.next_action_title)}</div>
              <div class="sp-action-due">${isUrgent ? '● VENCIDA · ' : ''}${escapeHtml(fmt.relative(opp.next_action_due_at))}</div>
              <button class="btn btn-sm btn-ok" id="btn-action-done" ${opp.next_action_done ? 'disabled' : ''}>${opp.next_action_done ? 'Completada' : 'Marcar completada'}</button>
            ` : `<div class="sp-empty">Sin próxima acción</div>`}
            <button class="btn btn-ghost btn-sm" id="btn-set-action">${opp.next_action_title ? 'Cambiar' : 'Definir'} próxima acción</button>
          </div>
        </div>

        <!-- IA -->
        <div class="col-ai">
          <div class="ai-panel">
            <div class="ai-hd">
              <span class="ai-lbl">◆ CLAUDE</span>
              <span class="ai-score ${scoreClass}">${opp.ai_score ?? '—'}${opp.ai_score >= 85 ? ' · HOT' : (opp.ai_score < 60 && opp.ai_score != null ? ' · COLD' : '')}</span>
            </div>
            ${aiAnalysis.sugerencia ? `<div class="ai-q">${escapeHtml(aiAnalysis.sugerencia)}</div>` : ''}
            <div class="ai-tabs" id="ai-tabs">
              <div class="ai-tab active" data-tab="a_favor">A favor (${(aiAnalysis.a_favor || []).length})</div>
              <div class="ai-tab" data-tab="riesgos">Riesgos (${(aiAnalysis.riesgos || []).length})</div>
            </div>
            <ul class="ai-bullets" id="ai-bullets">
              ${renderAIList('a_favor', aiAnalysis)}
            </ul>
            <button class="btn btn-sm" id="btn-ai-analyze">Re-analizar con Claude</button>
          </div>
        </div>
      </div>
    </div>
  `;

  attachFichaHandlers();
}

function originLabel(o) {
  return ORIGINS.find(x => x.id === o)?.label || o;
}

function renderTimelineHTML() {
  if (!local.timeline.length) {
    return '<div class="tl-empty">Sin actividad todavía</div>';
  }
  return local.timeline.map(ev => {
    const channelTag = ev.channel ? `<span class="tl-channel">${escapeHtml(ev.channel.toUpperCase())}</span>` : '';
    const dirTag = ev.direction === 'entrante' ? '← entrante' : (ev.direction === 'saliente' ? '→ saliente' : '');
    const sysTag = ev.is_system ? '<span class="tl-sys">SISTEMA</span>' : '';
    return `
      <div class="tl-item" data-type="${ev.event_type}">
        <div class="tl-dot"></div>
        <div class="tl-content">
          <div class="tl-meta">
            <span class="tl-type">${escapeHtml(eventTypeLabel(ev.event_type))}</span>
            ${channelTag}
            ${dirTag ? `<span class="tl-dir">${dirTag}</span>` : ''}
            ${sysTag}
            <span class="tl-time">${escapeHtml(fmt.relative(ev.event_at))}</span>
          </div>
          <div class="tl-title">${escapeHtml(ev.title)}</div>
          ${ev.body ? `<div class="tl-body">${escapeHtml(ev.body)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function eventTypeLabel(t) {
  const labels = {
    creacion: 'CREACIÓN', mensaje: 'MENSAJE', llamada: 'LLAMADA',
    visita: 'VISITA', cambio_etapa: 'ETAPA', asignacion: 'ASIGNACIÓN',
    alerta_sistema: 'ALERTA', nota: 'NOTA', documento: 'DOCUMENTO',
    reserva: 'RESERVA', venta: 'VENTA',
  };
  return labels[t] || t.toUpperCase();
}

function renderAIList(which, analysis) {
  const items = analysis?.[which] || [];
  if (!items.length) return `<li class="ai-empty">Sin datos en "${which.replace('_', ' ')}"</li>`;
  return items.map(i => `<li>${escapeHtml(i)}</li>`).join('');
}

// ============================================================
// HANDLERS DE LA FICHA
// ============================================================
function attachFichaHandlers() {
  $('#btn-back-pipeline').addEventListener('click', () => navigate('/pipeline'));

  // Cambio de etapa
  $('#stage-select').addEventListener('change', async (e) => {
    const newStage = e.target.value;
    const oldStage = local.opp.stage;
    if (newStage === oldStage) return;

    let extraUpdate = {};
    if (newStage === 'perdida') {
      const reason = await promptLossReason();
      if (!reason) {
        e.target.value = oldStage;
        return;
      }
      extraUpdate = { loss_reason: reason.reason, loss_notes: reason.notes || null };
    }
    if (newStage === 'ganada') {
      const ok = await confirmDialog('¿Marcar como GANADA? Después se abre el formulario de cierre para registrar la venta.', { okText: 'Marcar ganada' });
      if (!ok) {
        e.target.value = oldStage;
        return;
      }
    }

    const { error } = await supabase
      .from('opportunities')
      .update({ stage: newStage, ...extraUpdate })
      .eq('id', local.opp.id);
    if (error) {
      toast('Error cambiando etapa', error.message, 'error');
      e.target.value = oldStage;
      return;
    }
    local.opp.stage = newStage;
    Object.assign(local.opp, extraUpdate);
    toast(`Etapa actualizada`, STAGES.find(s => s.id === newStage)?.name, 'ok');

    // Si pasó a ganada, redirigir a /ventas/nueva con la opp pre-cargada
    if (newStage === 'ganada') {
      navigate(`/ventas/nueva?opp=${local.opp.opp_code.toLowerCase()}`);
      return;
    }

    // Refrescar timeline (el trigger la actualizó)
    local.timeline = await fetchTimeline(local.opp.id);
    renderFichaUI();
  });

  // Composer tabs
  $('#composer-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.comp-tab');
    if (!tab) return;
    local.composerTab = tab.dataset.tab;
    $$('.comp-tab').forEach(t => t.classList.toggle('active', t === tab));
    const ta = $('#composer-text');
    ta.placeholder = local.composerTab === 'nota_interna'
      ? 'Anotar algo (no se manda al cliente)…'
      : `Escribir mensaje por ${local.composerTab.replace('_', ' ')}…`;
    ta.focus();
  });

  // Sugerir respuesta IA
  $('#btn-ai-suggest').addEventListener('click', async () => {
    const btn = $('#btn-ai-suggest');
    btn.disabled = true;
    btn.textContent = 'Pensando…';
    try {
      const result = await suggestReply({
        contact: local.opp.contact,
        opportunity: local.opp,
        last_messages: local.timeline.slice(0, 5),
        goal: local.composerTab === 'nota_interna' ? 'resumen' : 'avanzar',
      });
      $('#composer-text').value = result.reply || '';
      if (result._mock) toast('Sugerencia (mock)', 'Edge function aún no deployada', 'info');
    } catch (err) {
      toast('Error generando sugerencia', err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '◆ Sugerir respuesta';
    }
  });

  // Registrar mensaje/nota
  $('#btn-send').addEventListener('click', registerComposerEvent);

  // Acción completada
  const actionBtn = $('#btn-action-done');
  if (actionBtn) {
    actionBtn.addEventListener('click', async () => {
      const { error } = await supabase
        .from('opportunities')
        .update({ next_action_done: true })
        .eq('id', local.opp.id);
      if (error) { toast('Error', error.message, 'error'); return; }
      local.opp.next_action_done = true;
      toast('Acción completada', null, 'ok');
      renderFichaUI();
    });
  }
  $('#btn-set-action')?.addEventListener('click', promptSetAction);

  // AI tabs
  $('#ai-tabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('.ai-tab');
    if (!tab) return;
    $$('.ai-tab').forEach(t => t.classList.toggle('active', t === tab));
    $('#ai-bullets').innerHTML = renderAIList(tab.dataset.tab, local.opp.ai_analysis || {});
  });

  // Re-analizar con Claude
  $('#btn-ai-analyze')?.addEventListener('click', async () => {
    const btn = $('#btn-ai-analyze');
    btn.disabled = true;
    btn.textContent = 'Analizando…';
    try {
      const result = await analyzeOpportunity(local.opp.id);
      // Persistir
      await supabase
        .from('opportunities')
        .update({
          ai_score: result.score,
          ai_analysis: { a_favor: result.a_favor, riesgos: result.riesgos, sugerencia: result.sugerencia },
          ai_suggested_next_action: result.next_action?.title,
          ai_score_updated_at: new Date().toISOString(),
        })
        .eq('id', local.opp.id);
      local.opp.ai_score = result.score;
      local.opp.ai_analysis = { a_favor: result.a_favor, riesgos: result.riesgos, sugerencia: result.sugerencia };
      local.opp.ai_suggested_next_action = result.next_action?.title;
      if (result._mock) toast('Análisis (mock)', 'Edge function aún no deployada', 'info');
      else toast('Análisis actualizado', `Score: ${result.score}`, 'ok');
      renderFichaUI();
    } catch (err) {
      toast('Error', err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Re-analizar con Claude';
    }
  });
}

async function registerComposerEvent() {
  const text = $('#composer-text').value.trim();
  if (!text) {
    toast('Escribí algo primero', null, 'warn');
    return;
  }
  const btn = $('#btn-send');
  btn.disabled = true;
  btn.textContent = 'Guardando…';

  try {
    const tab = local.composerTab;
    const evType = tab === 'nota_interna' ? 'nota' :
                   tab === 'llamada' ? 'llamada' : 'mensaje';
    const channel = tab === 'nota_interna' ? 'nota_interna' : tab;

    const { error } = await supabase.from('timeline_events').insert({
      opportunity_id: local.opp.id,
      event_type: evType,
      channel,
      direction: tab === 'nota_interna' ? null : 'saliente',
      title: tab === 'nota_interna' ? 'Nota interna' : `Mensaje · ${tab}`,
      body: text,
      user_id: currentUserId(),
      is_system: false,
    });
    if (error) throw error;
    $('#composer-text').value = '';
    toast('Registrado', null, 'ok');
    local.timeline = await fetchTimeline(local.opp.id);
    $('#timeline').innerHTML = renderTimelineHTML();
  } catch (err) {
    toast('Error guardando', err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Registrar';
  }
}

function promptSetAction() {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const modal = el('div', { class: 'modal' });
    const titleInput = el('input', {
      type: 'text',
      placeholder: 'Ej: Llamar para coordinar visita',
      value: local.opp.next_action_title || '',
      class: 'loss-select',
    });
    const dueInput = el('input', {
      type: 'datetime-local',
      class: 'loss-select',
      value: local.opp.next_action_due_at
        ? new Date(local.opp.next_action_due_at).toISOString().slice(0, 16)
        : new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 16),
    });

    modal.appendChild(el('div', { class: 'modal-hd' },
      el('h3', {}, 'Próxima acción'),
      el('button', { class: 'modal-close', onClick: () => close(null) }, '×')
    ));
    modal.appendChild(el('div', { class: 'modal-body' },
      el('label', { class: 'loss-label' }, 'Qué hay que hacer'),
      titleInput,
      el('label', { class: 'loss-label', style: { marginTop: '12px' } }, 'Cuándo'),
      dueInput
    ));
    modal.appendChild(el('div', { class: 'modal-actions' },
      el('button', { class: 'btn btn-ghost', onClick: () => close(null) }, 'Cancelar'),
      el('button', { class: 'btn', onClick: async () => {
        if (!titleInput.value.trim()) { titleInput.style.borderColor = 'var(--cc-danger)'; return; }
        const update = {
          next_action_title: titleInput.value.trim(),
          next_action_due_at: dueInput.value ? new Date(dueInput.value).toISOString() : null,
          next_action_done: false,
        };
        const { error } = await supabase.from('opportunities').update(update).eq('id', local.opp.id);
        if (error) { toast('Error', error.message, 'error'); return; }
        Object.assign(local.opp, update);
        toast('Próxima acción definida', null, 'ok');
        close(true);
        renderFichaUI();
      } }, 'Guardar'),
    ));

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    function close(value) { backdrop.remove(); resolve(value); }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });
  });
}

// Reutilizo el modal de motivo de pérdida (simétrico al de pipeline)
const LOSS_REASONS = [
  { id: 'precio', label: 'Precio' },
  { id: 'no_respondio', label: 'No respondió' },
  { id: 'compro_en_competencia', label: 'Compró en competencia' },
  { id: 'no_califica_credito', label: 'No califica crédito' },
  { id: 'cambio_de_planes', label: 'Cambió de planes' },
  { id: 'producto_no_disponible', label: 'Producto no disponible' },
  { id: 'otro', label: 'Otro' },
];

function promptLossReason() {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const modal = el('div', { class: 'modal' });
    const reasonSelect = el('select', { class: 'loss-select' },
      el('option', { value: '' }, 'Seleccionar motivo…'),
      ...LOSS_REASONS.map(r => el('option', { value: r.id }, r.label))
    );
    const notesArea = el('textarea', { class: 'loss-notes', rows: '3', placeholder: 'Notas adicionales' });

    modal.appendChild(el('div', { class: 'modal-hd' },
      el('h3', {}, 'Motivo de pérdida'),
      el('button', { class: 'modal-close', onClick: () => close(null) }, '×')
    ));
    modal.appendChild(el('div', { class: 'modal-body' },
      el('label', { class: 'loss-label' }, 'Motivo'),
      reasonSelect,
      el('label', { class: 'loss-label', style: { marginTop: '12px' } }, 'Notas'),
      notesArea,
    ));
    modal.appendChild(el('div', { class: 'modal-actions' },
      el('button', { class: 'btn btn-ghost', onClick: () => close(null) }, 'Cancelar'),
      el('button', { class: 'btn btn-danger', onClick: () => {
        if (!reasonSelect.value) { reasonSelect.style.borderColor = 'var(--cc-danger)'; return; }
        close({ reason: reasonSelect.value, notes: notesArea.value.trim() });
      } }, 'Marcar perdida'),
    ));

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    function close(value) { backdrop.remove(); resolve(value); }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });
  });
}

// ============================================================
// ESTILOS
// ============================================================
const styles = `
  /* HERO */
  .hero { padding: 22px 20px; border-bottom: 1px solid var(--cc-line); background: var(--cc-surface); }
  @container app (min-width: 900px) { .hero { padding: 28px 32px; } }
  .hero-grid { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; flex-wrap: wrap; }
  .hero-person { display: flex; gap: 16px; align-items: flex-start; min-width: 0; flex: 1; }
  .hero-av { width: 56px; height: 56px; border-radius: 50%; background: linear-gradient(135deg, var(--cc-graphite), var(--cc-steel)); color: var(--cc-bg); display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 600; flex-shrink: 0; }
  .hero-id-row { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.18em; color: var(--cc-muted); margin-bottom: 6px; }
  .hero-id-row b { color: var(--cc-ink); font-weight: 600; }
  .hero-name { font-family: var(--cc-font-display); font-weight: 300; font-size: 32px; letter-spacing: -0.02em; line-height: 1; }
  .hero-name i { font-style: italic; font-weight: 500; }
  @container app (min-width: 700px) { .hero-name { font-size: 38px; } }
  .hero-tags { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
  .hero-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .stage-select { padding: 8px 12px; font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; border: 1px solid var(--cc-ink); background: var(--cc-ink); color: var(--cc-bg); font-family: inherit; cursor: pointer; }
  .badge-stage { background: var(--cc-ink); color: var(--cc-bg); border-color: var(--cc-ink); }
  .badge-stage[data-stage="ganada"] { background: var(--cc-ok); border-color: var(--cc-ok); }
  .badge-stage[data-stage="perdida"] { background: var(--cc-muted); border-color: var(--cc-muted); }
  .badge-stage[data-stage="reserva"] { background: var(--cc-champagne); border-color: var(--cc-champagne); color: var(--cc-ink); }

  /* BODY · 3 columnas */
  .ficha-body { display: grid; grid-template-columns: 1fr; gap: 1px; background: var(--cc-line); }
  @container app (min-width: 900px) { .ficha-body { grid-template-columns: 2fr 1fr 1fr; } }
  .col-main, .col-side, .col-ai { background: var(--cc-bg); padding: 20px; min-width: 0; }
  @container app (min-width: 900px) { .col-main { padding: 24px 28px; } }

  /* COMPOSER */
  .composer { background: var(--cc-surface); border: 1px solid var(--cc-line); margin-bottom: 24px; }
  .composer-tabs { display: flex; border-bottom: 1px solid var(--cc-line-soft); }
  .comp-tab { padding: 10px 14px; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--cc-muted); cursor: pointer; border-right: 1px solid var(--cc-line-soft); font-weight: 500; }
  .comp-tab:last-child { border-right: none; }
  .comp-tab.active { background: var(--cc-ink); color: var(--cc-bg); }
  .comp-textarea { width: 100%; padding: 12px 14px; border: none; background: transparent; font-family: inherit; font-size: 13px; resize: vertical; min-height: 100px; color: var(--cc-ink); }
  .comp-textarea:focus { outline: none; }
  .comp-actions { display: flex; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--cc-line-soft); justify-content: flex-end; }

  /* TIMELINE */
  .section-hd { font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cc-muted); font-weight: 600; margin-bottom: 12px; }
  .timeline { position: relative; padding-left: 22px; }
  .timeline::before { content: ''; position: absolute; left: 6px; top: 6px; bottom: 6px; width: 1px; background: var(--cc-line); }
  .tl-item { position: relative; padding: 0 0 18px; }
  .tl-dot { position: absolute; left: -22px; top: 4px; width: 13px; height: 13px; background: var(--cc-bg); border: 1px solid var(--cc-line); border-radius: 50%; }
  .tl-item[data-type="cambio_etapa"] .tl-dot { background: var(--cc-champagne); border-color: var(--cc-champagne); }
  .tl-item[data-type="creacion"] .tl-dot { background: var(--cc-ink); border-color: var(--cc-ink); }
  .tl-item[data-type="reserva"] .tl-dot { background: var(--cc-ok); border-color: var(--cc-ok); }
  .tl-content { background: var(--cc-surface); border: 1px solid var(--cc-line-soft); padding: 10px 12px; }
  .tl-meta { display: flex; gap: 8px; align-items: center; font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.12em; color: var(--cc-muted); margin-bottom: 4px; flex-wrap: wrap; }
  .tl-type { font-weight: 600; color: var(--cc-ink); }
  .tl-channel, .tl-dir, .tl-sys { padding: 1px 6px; background: var(--cc-bg-alt); border: 1px solid var(--cc-line); }
  .tl-time { margin-left: auto; }
  .tl-title { font-size: 13px; font-weight: 500; margin-bottom: 2px; }
  .tl-body { font-size: 12px; color: var(--cc-ink-soft); line-height: 1.5; }
  .tl-empty { color: var(--cc-muted); font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; padding: 20px 0; }

  /* SIDE PANELS */
  .col-side { display: flex; flex-direction: column; gap: 16px; }
  .side-panel { background: var(--cc-surface); border: 1px solid var(--cc-line); padding: 14px; }
  .side-panel.urgent { border-left: 3px solid var(--cc-danger); }
  .sp-hd { font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cc-muted); font-weight: 600; margin-bottom: 10px; }
  .sp-row { display: flex; justify-content: space-between; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--cc-line-soft); font-size: 12px; }
  .sp-row:last-child { border-bottom: none; }
  .sp-row span { color: var(--cc-muted); }
  .sp-row b { color: var(--cc-ink); font-weight: 500; text-align: right; }
  .sp-photo { width: 100%; aspect-ratio: 16/10; object-fit: cover; margin-bottom: 8px; border: 1px solid var(--cc-line-soft); }
  .sp-link { color: var(--cc-ink); text-decoration: underline; font-size: 11px; }
  .sp-empty { color: var(--cc-muted); font-style: italic; font-size: 12px; }
  .sp-action { font-weight: 500; margin-bottom: 4px; }
  .sp-action-due { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); margin-bottom: 8px; letter-spacing: 0.05em; }
  .side-panel.urgent .sp-action-due { color: var(--cc-danger); font-weight: 600; }

  /* AI PANEL */
  .col-ai { background: var(--cc-bg-alt); }
  .ai-panel { background: var(--cc-surface); border: 1px solid var(--cc-line); padding: 16px; }
  .ai-hd { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
  .ai-lbl { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.22em; color: var(--cc-champagne); font-weight: 600; }
  .ai-score { font-family: var(--cc-font-mono); font-size: 12px; padding: 3px 8px; background: var(--cc-bg-alt); border: 1px solid var(--cc-line); font-weight: 600; }
  .ai-score.hot { background: var(--cc-ink); color: var(--cc-bg); border-color: var(--cc-ink); }
  .ai-score.cold { color: var(--cc-muted); }
  .ai-q { font-style: italic; font-size: 13px; color: var(--cc-ink-soft); padding: 10px 12px; background: var(--cc-bg-alt); border-left: 2px solid var(--cc-champagne); margin-bottom: 12px; line-height: 1.5; }
  .ai-tabs { display: flex; gap: 0; border: 1px solid var(--cc-line); margin-bottom: 10px; }
  .ai-tab { padding: 6px 10px; font-size: 9px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--cc-muted); cursor: pointer; border-right: 1px solid var(--cc-line); flex: 1; text-align: center; font-weight: 500; }
  .ai-tab:last-child { border-right: none; }
  .ai-tab.active { background: var(--cc-ink); color: var(--cc-bg); }
  .ai-bullets { list-style: none; padding: 0; margin: 0 0 12px; }
  .ai-bullets li { padding: 6px 0 6px 16px; position: relative; font-size: 12px; line-height: 1.5; border-bottom: 1px solid var(--cc-line-soft); }
  .ai-bullets li:last-child { border-bottom: none; }
  .ai-bullets li::before { content: '·'; position: absolute; left: 4px; color: var(--cc-champagne); font-weight: 700; }
  .ai-empty { color: var(--cc-muted); font-style: italic; }

  /* CREATE FORM */
  .opp-form { padding: 0 20px 24px; }
  @container app (min-width: 900px) { .opp-form { padding: 0 32px 32px; max-width: 800px; } }
  .form-section { background: var(--cc-surface); border: 1px solid var(--cc-line); margin-bottom: 16px; }
  .form-section-hd { padding: 12px 16px; border-bottom: 1px solid var(--cc-line-soft); font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; font-weight: 600; color: var(--cc-ink); }
  .form-section-body { padding: 16px; }
  .contact-picker { display: flex; flex-direction: column; gap: 10px; }
  .contact-picker input[type="text"]:not(.btn) { padding: 10px 12px; border: 1px solid var(--cc-line); background: var(--cc-bg); font-size: 13px; font-family: inherit; }
  .contact-results { display: flex; flex-direction: column; max-height: 200px; overflow-y: auto; }
  .contact-result-item { padding: 10px 12px; border: 1px solid var(--cc-line-soft); cursor: pointer; background: var(--cc-bg); margin-bottom: -1px; }
  .contact-result-item:hover { background: var(--cc-bg-alt); border-color: var(--cc-ink); }
  .crit-name { font-weight: 500; font-size: 13px; }
  .crit-meta { font-size: 11px; color: var(--cc-muted); margin-top: 2px; }
  .contact-selected { display: flex; align-items: center; gap: 12px; padding: 10px 12px; background: var(--cc-ok-soft); border: 1px solid var(--cc-ok); }
  .cs-avatar { width: 36px; height: 36px; border-radius: 50%; background: var(--cc-ink); color: var(--cc-bg); display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; }
  .cs-data { flex: 1; min-width: 0; }
  .cs-name { font-weight: 500; }
  .cs-meta { font-size: 11px; color: var(--cc-muted); }
  .new-contact-form { background: var(--cc-bg-alt); padding: 12px; border: 1px solid var(--cc-line-soft); }
  .loss-select, .loss-notes { width: 100%; padding: 10px 12px; border: 1px solid var(--cc-line); background: var(--cc-bg); font-family: inherit; font-size: 13px; color: var(--cc-ink); }
  .loss-label { display: block; font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cc-muted); font-weight: 500; margin-bottom: 6px; }
  .loss-notes { resize: vertical; min-height: 60px; }
  .badge-info { background: var(--cc-info-soft); border-color: var(--cc-info); color: var(--cc-info); }
`;
