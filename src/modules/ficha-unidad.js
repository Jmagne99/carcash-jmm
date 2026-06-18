// ============================================================
// CARCASH · MÓDULO FICHA DE UNIDAD
// Ruta: /unidades/:id (acepta unit_code o uuid)
// Funciones clave:
//   - Galería de fotos
//   - Ficha técnica completa
//   - Documentación
//   - Oportunidades vinculadas
//   - ENVIAR FICHA por WhatsApp o Email (con fotos)
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { state, isAdmin, currentUserId } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles, confirmDialog } from '../lib/dom.js';
import { navigate } from '../lib/router.js';
import { CHANNELS, publishUnit, getUnitPublications } from '../lib/publish.js';

const STATUS_LABELS = {
  en_preparacion: 'En preparación',
  disponible: 'Disponible',
  reservado: 'Reservado',
  vendido: 'Vendido',
  entregado: 'Entregado',
  devuelto: 'Devuelto',
  baja: 'Baja',
};

const local = {
  unit: null,
  documents: [],
  opportunities: [],
  contacts: [],
  publications: [],
  galleryIndex: 0,
};

// ============================================================
// MOUNT
// ============================================================
export async function mount(params = {}) {
  injectStyles('ficha-unidad-styles', styles);
  if (!params.id) {
    navigate('/unidades');
    return;
  }
  await renderFicha(params.id);
}

export default mount;

// ============================================================
// FETCH
// ============================================================
async function fetchUnit(idOrCode) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(idOrCode);
  let q = supabase
    .from('units')
    .select('*, consignor:contacts!consignor_contact_id(id, full_name, phone)')
    .is('deleted_at', null);

  if (isUuid) q = q.eq('id', idOrCode);
  else q = q.ilike('unit_code', idOrCode.toUpperCase());

  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  return data;
}

async function fetchUnitDocuments(unitId) {
  const { data, error } = await supabase
    .from('unit_documents')
    .select('id, unit_id, doc_type, status, file_url, expiration_date, notes')
    .eq('unit_id', unitId);
  if (error) {
    console.error('fetchUnitDocuments error', error);
    return [];
  }
  return data || [];
}

async function fetchUnitOpportunities(unitId) {
  const { data } = await supabase
    .from('opportunities')
    .select(`
      id, opp_code, stage, ai_score,
      contact:contacts(id, full_name, phone, email),
      assignee:users_profile!assigned_to(full_name)
    `)
    .eq('unit_of_interest_id', unitId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  return data || [];
}

async function fetchContacts() {
  const { data } = await supabase
    .from('contacts')
    .select('id, full_name, phone, email, dni_cuit')
    .is('deleted_at', null)
    .order('full_name');
  return data || [];
}

// ============================================================
// RENDER
// ============================================================
async function renderFicha(idOrCode) {
  const view = $('#view');
  view.innerHTML = `<div class="empty">Cargando unidad…</div>`;

  try {
    local.unit = await fetchUnit(idOrCode);
    if (!local.unit) {
      view.innerHTML = `
        <div class="placeholder">
          <div class="placeholder-content">
            <div class="placeholder-num">404</div>
            <div class="placeholder-title">Unidad no <i>encontrada</i></div>
            <div class="placeholder-desc">No existe una unidad con código "${escapeHtml(idOrCode.toUpperCase())}".</div>
            <div class="placeholder-status" style="cursor:pointer" onclick="location.hash='#/unidades'">VOLVER AL STOCK</div>
          </div>
        </div>
      `;
      return;
    }
    [local.documents, local.opportunities, local.contacts, local.publications] = await Promise.all([
      fetchUnitDocuments(local.unit.id),
      fetchUnitOpportunities(local.unit.id),
      fetchContacts(),
      getUnitPublications(local.unit.id),
    ]);
    renderUI();
  } catch (err) {
    console.error(err);
    toast('Error cargando unidad', err.message, 'error');
  }
}

function renderUI() {
  const u = local.unit;
  const view = $('#view');
  const photos = collectPhotos(u);
  local.galleryIndex = 0;
  const stockDays = Math.floor((Date.now() - new Date(u.entered_at).getTime()) / 86400000);

  view.innerHTML = `
    <div class="unit-page">
      <!-- HEADER -->
      <div class="up-hd">
        <div class="up-hd-row">
          <div>
            <div class="up-back"><a data-route="/unidades">← Stock</a></div>
            <div class="up-id-row">${escapeHtml(u.unit_code)} · ${escapeHtml(fmt.plate(u.license_plate))} · INGRESO ${escapeHtml(fmt.dateAR(u.entered_at).toUpperCase())}</div>
            <div class="up-name">${escapeHtml(u.brand)} <i>${escapeHtml(u.model)}</i> <span class="up-year">'${String(u.year).slice(2)}</span></div>
            ${u.version ? `<div class="up-version">${escapeHtml(u.version)}</div>` : ''}
            <div class="up-tags">
              <span class="badge badge-status badge-${u.status}">${escapeHtml(STATUS_LABELS[u.status] || u.status)}</span>
              <span class="badge">${escapeHtml(u.modality.toUpperCase())}</span>
              ${stockDays >= 30 && u.status === 'disponible' ? `<span class="badge danger">${stockDays}d EN STOCK</span>` : ''}
            </div>
          </div>
          <div class="up-actions">
            <button class="btn btn-ok" id="btn-share-wsp">● Enviar por WhatsApp</button>
            <button class="btn" id="btn-share-email">✉ Enviar por Email</button>
            <button class="btn btn-ghost" id="btn-preview-public">↗ Ver landing pública</button>
            ${isAdmin() ? '<button class="btn btn-ghost" id="btn-edit">Editar</button>' : ''}
          </div>
        </div>
      </div>

      <div class="up-body">
        <!-- GALERÍA + DESCRIPCIÓN -->
        <div class="up-col-main">
          ${renderGallery(photos)}
          ${u.description ? `<div class="up-block"><div class="up-block-hd">Descripción</div><div class="up-desc">${escapeHtml(u.description)}</div></div>` : ''}
          ${u.featured_equipment?.length ? `
            <div class="up-block">
              <div class="up-block-hd">Equipamiento destacado</div>
              <ul class="up-features">
                ${u.featured_equipment.map(f => `<li>${escapeHtml(f)}</li>`).join('')}
              </ul>
            </div>
          ` : ''}

          <!-- FICHA TÉCNICA -->
          <div class="up-block">
            <div class="up-block-hd">Ficha técnica</div>
            <div class="up-specs">
              ${specRow('Marca', u.brand)}
              ${specRow('Modelo', u.model)}
              ${specRow('Versión', u.version)}
              ${specRow('Año', u.year)}
              ${specRow('Tipo', u.body_type)}
              ${specRow('Combustible', u.fuel_type)}
              ${specRow('Transmisión', u.transmission)}
              ${specRow('Cilindrada', u.displacement_cc ? u.displacement_cc + ' cc' : '—')}
              ${specRow('Potencia', u.horsepower ? u.horsepower + ' hp' : '—')}
              ${specRow('Kilometraje', fmt.km(u.mileage))}
              ${specRow('Color exterior', u.color_exterior)}
              ${specRow('Color interior', u.color_interior)}
              ${specRow('Patente', fmt.plate(u.license_plate))}
              ${specRow('VIN', u.vin)}
              ${specRow('Motor', u.engine_number)}
              ${specRow('Ubicación', u.location)}
            </div>
          </div>
        </div>

        <!-- LATERAL: precio, comercial, documentación, oportunidades -->
        <div class="up-col-side">
          <div class="up-panel up-price-panel">
            <div class="up-panel-hd">Precio</div>
            <div class="up-price">USD ${escapeHtml(fmt.usd(u.public_price))}</div>
            ${isAdmin() ? `
              <div class="up-price-meta">
                <div class="up-price-row"><span>Mínimo aut.</span><b>USD ${escapeHtml(fmt.usd(u.minimum_price))}</b></div>
                <div class="up-price-row"><span>Costo</span><b>USD ${escapeHtml(fmt.usd(u.acquisition_cost))}</b></div>
                <div class="up-price-row"><span>Margen estimado</span><b>${u.acquisition_cost && u.public_price ? fmt.pct(((u.public_price - u.acquisition_cost) / u.public_price) * 100) : '—'}</b></div>
              </div>
            ` : ''}
          </div>

          ${u.modality === 'consignacion' && u.consignor ? `
            <div class="up-panel">
              <div class="up-panel-hd">Consignante</div>
              <div class="up-row"><span>Nombre</span><b>${escapeHtml(u.consignor.full_name)}</b></div>
              <div class="up-row"><span>Teléfono</span><b>${escapeHtml(fmt.phone(u.consignor.phone))}</b></div>
              <div class="up-row"><span>Precio acordado</span><b>USD ${escapeHtml(fmt.usd(u.consignor_agreed_price))}</b></div>
              <div class="up-row"><span>Comisión</span><b>${u.consignor_commission_pct ? fmt.pct(u.consignor_commission_pct) : '—'}</b></div>
            </div>
          ` : ''}

          <div class="up-panel">
            <div class="up-panel-hd">Documentación</div>
            ${renderDocsList()}
          </div>

          ${isAdmin() ? `
            <div class="up-panel up-pub-panel">
              <div class="up-panel-hd">Publicaciones</div>
              ${renderPublicationsList()}
            </div>
          ` : ''}

          <div class="up-panel">
            <div class="up-panel-hd">Oportunidades vinculadas</div>
            ${renderOppsList()}
          </div>

          <div class="up-panel">
            <div class="up-panel-hd">Métricas</div>
            <div class="up-row"><span>Visitas</span><b>${u.views_count || 0}</b></div>
            <div class="up-row"><span>Consultas</span><b>${u.inquiries_count || 0}</b></div>
            <div class="up-row"><span>En stock</span><b>${stockDays}d</b></div>
          </div>
        </div>
      </div>
    </div>
  `;

  attachHandlers(photos);
}

function specRow(label, value) {
  return `
    <div class="up-spec-row">
      <span>${escapeHtml(label)}</span>
      <b>${escapeHtml(value || '—')}</b>
    </div>
  `;
}

function renderDocsList() {
  if (!local.documents.length) {
    return `<div class="up-empty">Sin documentación cargada</div>`;
  }
  return `<div class="up-docs">
    ${local.documents.map(d => `
      <div class="up-doc">
        <div class="up-doc-name">${escapeHtml(fmt.humanize(d.doc_type))}</div>
        <div class="up-doc-status doc-${d.status}">${escapeHtml(d.status.toUpperCase())}</div>
      </div>
    `).join('')}
  </div>`;
}

function renderPublicationsList() {
  const channels = ['mercado_libre', 'instagram'];
  const byChannel = {};
  for (const p of local.publications) byChannel[p.channel] = p;

  return `
    <div class="up-pubs">
      ${channels.map(ch => {
        const p = byChannel[ch];
        const cfg = CHANNELS[ch] || { label: ch };
        const status = p?.status || 'no_publicada';
        const hasError = !!p?.error_message;
        return `
          <div class="up-pub-row" data-channel="${ch}">
            <div class="up-pub-info">
              <div class="up-pub-label">${escapeHtml(cfg.label)}</div>
              <div class="up-pub-meta">
                ${hasError
                  ? `<span class="up-pub-status err">⚠ Error</span>`
                  : `<span class="up-pub-status status-${status}">${escapeHtml(statusLabel(status))}</span>`}
                ${p?.url ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener" class="up-pub-link">Ver →</a>` : ''}
                ${p?.last_synced_at ? `<span class="up-pub-time">${escapeHtml(fmt.relative(p.last_synced_at))}</span>` : ''}
              </div>
              ${hasError ? `<div class="up-pub-err-msg">${escapeHtml(p.error_message.slice(0, 120))}</div>` : ''}
            </div>
            <div class="up-pub-actions">
              ${status === 'activa'
                ? `<button class="btn btn-ghost btn-sm" data-pub-action="update" data-pub-channel="${ch}">↻ Actualizar</button>
                   <button class="btn btn-ghost btn-sm" data-pub-action="pause" data-pub-channel="${ch}">⏸ Pausar</button>`
                : `<button class="btn btn-sm" data-pub-action="publish" data-pub-channel="${ch}">▶ Publicar</button>`}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function statusLabel(s) {
  const m = {
    activa: '● Activa',
    pausada: '⏸ Pausada',
    cerrada: '✕ Cerrada',
    error: '⚠ Error',
    no_publicada: '○ No publicada',
  };
  return m[s] || s;
}

function renderOppsList() {
  if (!local.opportunities.length) {
    return `<div class="up-empty">Sin oportunidades vinculadas todavía</div>`;
  }
  return `<div class="up-opps">
    ${local.opportunities.map(o => `
      <a class="up-opp" data-route="/pipeline/${escapeHtml(o.opp_code.toLowerCase())}">
        <div class="up-opp-name">${escapeHtml(o.contact?.full_name || '—')}</div>
        <div class="up-opp-meta">
          <span>${escapeHtml(o.opp_code)}</span>
          <span class="up-opp-stage">${escapeHtml(o.stage.toUpperCase())}</span>
          ${o.ai_score != null ? `<span>· score ${o.ai_score}</span>` : ''}
        </div>
      </a>
    `).join('')}
  </div>`;
}

// ============================================================
// GALERÍA
// ============================================================
function collectPhotos(u) {
  const all = [u.main_photo_url, ...(u.photos || [])].filter(Boolean);
  return [...new Set(all)];
}

function renderGallery(photos) {
  if (!photos.length) {
    return `
      <div class="up-gallery up-no-gallery">
        <div class="up-no-photo">Sin fotos cargadas</div>
        ${isAdmin() ? '<button class="btn btn-ghost btn-sm" id="btn-add-photo">+ Agregar foto</button>' : ''}
      </div>
    `;
  }
  return `
    <div class="up-gallery">
      <div class="up-gallery-main">
        <img id="gallery-main-img" src="${escapeHtml(photos[0])}" alt="">
        ${photos.length > 1 ? `
          <button class="gallery-nav prev" id="gallery-prev" aria-label="Anterior">‹</button>
          <button class="gallery-nav next" id="gallery-next" aria-label="Siguiente">›</button>
          <div class="gallery-counter"><span id="gallery-pos">1</span>/${photos.length}</div>
        ` : ''}
      </div>
      ${photos.length > 1 ? `
        <div class="up-gallery-thumbs" id="gallery-thumbs">
          ${photos.map((p, i) => `<div class="gallery-thumb ${i === 0 ? 'active' : ''}" data-idx="${i}" style="background-image:url('${escapeHtml(p)}')"></div>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function setGalleryPhoto(photos, idx) {
  if (idx < 0) idx = photos.length - 1;
  if (idx >= photos.length) idx = 0;
  local.galleryIndex = idx;
  $('#gallery-main-img').src = photos[idx];
  $('#gallery-pos').textContent = String(idx + 1);
  $$('.gallery-thumb').forEach((t, i) => t.classList.toggle('active', i === idx));
}

// ============================================================
// HANDLERS
// ============================================================
function attachHandlers(photos) {
  // Galería
  if (photos.length > 1) {
    $('#gallery-prev')?.addEventListener('click', () => setGalleryPhoto(photos, local.galleryIndex - 1));
    $('#gallery-next')?.addEventListener('click', () => setGalleryPhoto(photos, local.galleryIndex + 1));
    $('#gallery-thumbs')?.addEventListener('click', (e) => {
      const t = e.target.closest('.gallery-thumb');
      if (!t) return;
      setGalleryPhoto(photos, parseInt(t.dataset.idx, 10));
    });
  }

  // Acciones de envío
  $('#btn-share-wsp').addEventListener('click', () => openShareModal('whatsapp'));
  $('#btn-share-email').addEventListener('click', () => openShareModal('email'));

  // Preview de la landing pública
  $('#btn-preview-public')?.addEventListener('click', () => {
    const link = buildPublicLink(local.unit.unit_code);
    window.open(link, '_blank');
  });

  $('#btn-edit')?.addEventListener('click', () => {
    navigate(`/unidades/${local.unit.unit_code.toLowerCase()}/editar`);
  });

  // Acciones de publicaciones
  document.querySelectorAll('[data-pub-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.pubAction;
      const channel = btn.dataset.pubChannel;
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳ Procesando…';
      try {
        const r = await publishUnit(local.unit.id, channel, action);
        if (r.mock) {
          toast('Edge Function no deployada', r.error, 'warn');
        } else if (r.ok) {
          toast(`✓ ${actionLabel(action)} en ${CHANNELS[channel]?.label}`, r.url || '', 'ok');
          // Refrescar publicaciones y re-renderizar el panel
          local.publications = await getUnitPublications(local.unit.id);
          renderUI();
        } else {
          toast('Error', r.error, 'error');
        }
      } catch (err) {
        toast('Error', err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  });
}

function actionLabel(a) {
  return { publish: 'Publicada', update: 'Actualizada', pause: 'Pausada', close: 'Cerrada' }[a] || a;
}

// ============================================================
// MODAL ENVIAR FICHA
// ============================================================
function openShareModal(channel) {
  const u = local.unit;
  const photos = collectPhotos(u);

  // Link público a la ficha — el cliente lo abre y ve solo este auto
  const publicLink = buildPublicLink(u.unit_code);

  // Template del mensaje (corto, con link a la landing)
  const businessName = 'CarCash';
  const lines = [
    `Hola! Te paso la ficha de la unidad que te interesa:`,
    '',
    `*${u.brand} ${u.model} ${u.year}*${u.version ? ` · ${u.version}` : ''}`,
    `🚗 ${fmt.km(u.mileage)}${u.color_exterior ? ' · ' + u.color_exterior : ''}`,
    u.horsepower ? `⚡ ${u.horsepower} hp${u.transmission ? ' · ' + u.transmission : ''}` : null,
    '',
    `💵 *USD ${fmt.usd(u.public_price)}*`,
    '',
    `🔗 Ficha completa con fotos:`,
    publicLink,
    '',
    `Cualquier consulta a la orden.`,
    `— ${businessName} Premium Motors`,
  ].filter(l => l !== null);
  const message = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  const subject = `${u.brand} ${u.model} ${u.year}${u.version ? ' ' + u.version : ''} · USD ${fmt.usd(u.public_price)}`;

  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', style: { maxWidth: '560px' } });

  const recipientInput = el('input', {
    class: 'loss-select',
    placeholder: channel === 'whatsapp' ? 'Buscar contacto o teléfono (+5491145678901)' : 'Buscar contacto o email',
    type: 'text',
  });

  const recipientHint = el('div', { class: 'recipient-hint', style: { fontSize: '11px', color: 'var(--cc-muted)', marginTop: '4px' } },
    'Opcional. Si no completás, se abre WhatsApp/Email vacío para que elijas destinatario.');

  const messageArea = el('textarea', {
    class: 'loss-notes',
    style: { minHeight: '220px', fontFamily: 'monospace', fontSize: '12px' },
    rows: '12',
  });
  messageArea.value = message;

  const photosToggle = el('div', { class: 'photos-toggle' });
  photosToggle.appendChild(el('div', {
    style: { fontSize: '11px', color: 'var(--cc-muted)', marginTop: '6px', display: 'flex', alignItems: 'center', gap: '6px' }
  },
    el('span', { style: { fontFamily: 'var(--cc-font-mono)', fontSize: '10px', letterSpacing: '0.1em', color: 'var(--cc-champagne)' } }, '🔗'),
    `El link abre una landing pública con galería + ficha técnica. No requiere login.`
  ));

  // Autocomplete de contactos
  let selectedRecipient = null;
  const matchesEl = el('div', { class: 'recipient-matches' });

  recipientInput.addEventListener('input', () => {
    const q = recipientInput.value.trim().toLowerCase();
    matchesEl.innerHTML = '';
    if (!q || q.length < 2) return;
    const matches = local.contacts.filter(c =>
      c.full_name?.toLowerCase().includes(q) ||
      c.phone?.includes(q) ||
      c.email?.toLowerCase().includes(q)
    ).slice(0, 5);
    matches.forEach(c => {
      const item = el('div', { class: 'recipient-match' },
        el('div', { class: 'rm-name' }, c.full_name),
        el('div', { class: 'rm-meta' }, channel === 'whatsapp' ? (c.phone || '—') : (c.email || '—'))
      );
      item.addEventListener('click', () => {
        selectedRecipient = c;
        recipientInput.value = `${c.full_name} · ${channel === 'whatsapp' ? c.phone : c.email}`;
        matchesEl.innerHTML = '';
      });
      matchesEl.appendChild(item);
    });
  });

  modal.appendChild(el('div', { class: 'modal-hd' },
    el('h3', {}, channel === 'whatsapp' ? 'Enviar por WhatsApp' : 'Enviar por Email'),
    el('button', { class: 'modal-close', onClick: () => close() }, '×')
  ));

  modal.appendChild(el('div', { class: 'modal-body' },
    el('label', { class: 'loss-label' }, 'Destinatario'),
    recipientInput,
    matchesEl,
    recipientHint,
    el('label', { class: 'loss-label', style: { marginTop: '14px' } }, 'Mensaje (editable)'),
    messageArea,
    photosToggle,
  ));

  modal.appendChild(el('div', { class: 'modal-actions' },
    el('button', { class: 'btn btn-ghost', onClick: () => close() }, 'Cancelar'),
    el('button', { class: 'btn btn-ok', onClick: () => sendShare(channel, messageArea.value, selectedRecipient, recipientInput.value, photos, () => close()) },
      channel === 'whatsapp' ? '● Abrir WhatsApp' : '✉ Abrir Email'),
  ));

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  function close() { backdrop.remove(); }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
}

function buildPublicLink(unitCode) {
  // Link a la landing pública. Usa el origen actual + hash route.
  const origin = window.location.origin;
  const path = window.location.pathname.replace(/index\.html$/, '');
  return `${origin}${path}#/u/${unitCode.toLowerCase()}`;
}

function sendShare(channel, messageRaw, contact, rawText, photos, onDone) {
  let message = messageRaw;

  if (channel === 'whatsapp') {
    let phone = contact?.phone || '';
    // Si no eligió contacto, intentar extraer del raw
    if (!phone && rawText) {
      const m = rawText.match(/(\+?\d{10,13})/);
      if (m) phone = m[1];
    }
    const cleanPhone = String(phone).replace(/\D/g, '');
    const url = cleanPhone
      ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`
      : `https://wa.me/?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank');
    toast('WhatsApp abierto', cleanPhone ? `Para ${contact?.full_name || cleanPhone}` : 'Elegí el destinatario', 'ok');
  } else {
    let mailTo = contact?.email || '';
    if (!mailTo && rawText) {
      const m = rawText.match(/[^\s,]+@[^\s,]+\.[^\s,]+/);
      if (m) mailTo = m[0];
    }
    const u = local.unit;
    const subject = `${u.brand} ${u.model} ${u.year}${u.version ? ' ' + u.version : ''} · USD ${fmt.usd(u.public_price)}`;
    const url = `mailto:${mailTo}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
    window.location.href = url;
    toast('Email abierto', mailTo || 'Elegí el destinatario', 'ok');
  }

  // Registrar el envío como evento (si estamos vinculados a una oportunidad — opcional)
  // Por ahora solo lo dejamos en log local; si querés trackear, podemos agregar timeline_events
  // por contacto + unidad después.

  onDone();
}

// ============================================================
// STYLES
// ============================================================
const styles = `
  /* HEADER UNIDAD */
  .up-hd { padding: 22px 20px 18px; border-bottom: 1px solid var(--cc-line); background: var(--cc-surface); }
  @container app (min-width: 900px) { .up-hd { padding: 28px 32px 22px; } }
  .up-hd-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
  .up-back { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.18em; color: var(--cc-muted); margin-bottom: 8px; }
  .up-back a { color: var(--cc-muted); text-decoration: none; cursor: pointer; }
  .up-back a:hover { color: var(--cc-ink); }
  .up-id-row { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.16em; color: var(--cc-muted); margin-bottom: 6px; }
  .up-name { font-family: var(--cc-font-display); font-weight: 300; font-size: 32px; letter-spacing: -0.02em; line-height: 1; }
  @container app (min-width: 700px) { .up-name { font-size: 38px; } }
  .up-name i { font-style: italic; font-weight: 500; }
  .up-year { font-family: var(--cc-font-mono); font-size: 18px; color: var(--cc-muted); font-weight: 400; }
  .up-version { font-size: 12px; color: var(--cc-muted); margin-top: 4px; }
  .up-tags { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
  .badge-status { background: var(--cc-ink); color: var(--cc-bg); border-color: var(--cc-ink); }
  .badge-disponible { background: var(--cc-ok); color: white; border-color: var(--cc-ok); }
  .badge-reservado { background: var(--cc-champagne); color: var(--cc-ink); border-color: var(--cc-champagne); }
  .badge-vendido { background: var(--cc-ink); color: var(--cc-bg); border-color: var(--cc-ink); }
  .badge-en_preparacion { background: var(--cc-warn); color: white; border-color: var(--cc-warn); }
  .up-actions { display: flex; gap: 8px; flex-wrap: wrap; }

  /* BODY */
  .up-body { display: grid; grid-template-columns: 1fr; gap: 1px; background: var(--cc-line); }
  @container app (min-width: 900px) { .up-body { grid-template-columns: 1.6fr 1fr; } }
  .up-col-main, .up-col-side { background: var(--cc-bg); padding: 18px 20px; min-width: 0; }
  @container app (min-width: 900px) { .up-col-main { padding: 24px 28px; } }
  .up-col-side { display: flex; flex-direction: column; gap: 16px; }

  /* GALERÍA */
  .up-gallery { background: var(--cc-surface); border: 1px solid var(--cc-line); margin-bottom: 18px; }
  .up-no-gallery { padding: 60px; text-align: center; }
  .up-gallery-main { aspect-ratio: 16/9; background: var(--cc-bg-alt); position: relative; overflow: hidden; }
  .up-gallery-main img { width: 100%; height: 100%; object-fit: cover; }
  .gallery-nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(17,17,17,0.6); color: white; border: none; width: 38px; height: 38px; font-size: 22px; cursor: pointer; }
  .gallery-nav:hover { background: rgba(17,17,17,0.85); }
  .gallery-nav.prev { left: 12px; }
  .gallery-nav.next { right: 12px; }
  .gallery-counter { position: absolute; bottom: 12px; right: 12px; background: rgba(17,17,17,0.7); color: white; padding: 4px 10px; font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.1em; }
  .up-gallery-thumbs { display: flex; gap: 1px; padding: 8px; background: var(--cc-bg-alt); overflow-x: auto; }
  .gallery-thumb { width: 84px; height: 56px; flex-shrink: 0; background-size: cover; background-position: center; cursor: pointer; opacity: 0.6; border: 2px solid transparent; }
  .gallery-thumb:hover { opacity: 1; }
  .gallery-thumb.active { opacity: 1; border-color: var(--cc-ink); }
  .up-no-photo { color: var(--cc-muted); font-family: var(--cc-font-mono); font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; }

  /* BLOCKS */
  .up-block { background: var(--cc-surface); border: 1px solid var(--cc-line); margin-bottom: 18px; }
  .up-block-hd { padding: 12px 16px; border-bottom: 1px solid var(--cc-line-soft); font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; font-weight: 600; }
  .up-desc { padding: 14px 16px; font-size: 13px; line-height: 1.6; color: var(--cc-ink-soft); }
  .up-features { padding: 12px 24px; list-style: none; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; }
  .up-features li { padding: 4px 0 4px 16px; position: relative; font-size: 12px; }
  .up-features li::before { content: '◆'; position: absolute; left: 0; color: var(--cc-champagne); font-size: 9px; top: 7px; }
  .up-specs { padding: 4px 0; }
  .up-spec-row { display: flex; justify-content: space-between; padding: 8px 16px; border-bottom: 1px solid var(--cc-line-soft); font-size: 12px; }
  .up-spec-row:last-child { border-bottom: none; }
  .up-spec-row span { color: var(--cc-muted); }
  .up-spec-row b { font-weight: 500; text-align: right; }

  /* SIDE PANELS */
  .up-panel { background: var(--cc-surface); border: 1px solid var(--cc-line); padding: 14px; }
  .up-panel-hd { font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cc-muted); font-weight: 600; margin-bottom: 10px; }
  .up-row { display: flex; justify-content: space-between; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--cc-line-soft); font-size: 12px; }
  .up-row:last-child { border-bottom: none; }
  .up-row span { color: var(--cc-muted); }
  .up-row b { font-weight: 500; text-align: right; }
  .up-empty { color: var(--cc-muted); font-style: italic; font-size: 12px; padding: 4px 0; }
  .up-price-panel { background: var(--cc-ink); color: var(--cc-bg); border-color: var(--cc-ink); }
  .up-price-panel .up-panel-hd { color: var(--cc-platinum); }
  .up-price { font-family: var(--cc-font-mono); font-size: 24px; font-weight: 600; letter-spacing: -0.01em; padding: 4px 0; }
  .up-price-meta { padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.1); margin-top: 8px; }
  .up-price-row { display: flex; justify-content: space-between; gap: 10px; padding: 4px 0; font-size: 11px; color: var(--cc-platinum); }
  .up-price-row b { color: var(--cc-bg); font-weight: 500; }

  .up-docs { display: flex; flex-direction: column; }
  .up-doc { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--cc-line-soft); font-size: 12px; }
  .up-doc:last-child { border-bottom: none; }
  .up-doc-status { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.15em; padding: 2px 6px; border: 1px solid var(--cc-line); }
  .doc-ok { background: var(--cc-ok-soft); color: var(--cc-ok); border-color: var(--cc-ok); }
  .doc-pendiente { background: var(--cc-warn-soft); color: var(--cc-warn); border-color: var(--cc-warn); }
  .doc-en_tramite { background: var(--cc-info-soft); color: var(--cc-info); border-color: var(--cc-info); }
  .doc-vencido { background: var(--cc-danger-soft); color: var(--cc-danger); border-color: var(--cc-danger); }

  /* PUBLICACIONES */
  .up-pub-panel { border-left: 3px solid var(--cc-champagne); }
  .up-pubs { display: flex; flex-direction: column; gap: 8px; }
  .up-pub-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--cc-line-soft); gap: 8px; flex-wrap: wrap; }
  .up-pub-row:last-child { border-bottom: none; }
  .up-pub-info { flex: 1; min-width: 0; }
  .up-pub-label { font-weight: 600; font-size: 12px; }
  .up-pub-meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 3px; font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.05em; }
  .up-pub-status { padding: 1px 5px; background: var(--cc-bg-alt); border: 1px solid var(--cc-line); }
  .up-pub-status.status-activa { background: var(--cc-ok-soft); color: var(--cc-ok); border-color: var(--cc-ok); }
  .up-pub-status.status-pausada { background: var(--cc-warn-soft); color: var(--cc-warn); border-color: var(--cc-warn); }
  .up-pub-status.status-cerrada { background: var(--cc-bg-alt); color: var(--cc-muted); }
  .up-pub-status.err { background: var(--cc-danger-soft); color: var(--cc-danger); border-color: var(--cc-danger); }
  .up-pub-link { color: var(--cc-info); text-decoration: underline; cursor: pointer; }
  .up-pub-time { color: var(--cc-muted); }
  .up-pub-err-msg { font-size: 10px; color: var(--cc-danger); margin-top: 4px; line-height: 1.4; }
  .up-pub-actions { display: flex; gap: 4px; flex-shrink: 0; }

  .up-opps { display: flex; flex-direction: column; gap: 6px; }
  .up-opp { display: block; padding: 8px 10px; background: var(--cc-bg-alt); border: 1px solid var(--cc-line-soft); cursor: pointer; text-decoration: none; color: inherit; }
  .up-opp:hover { border-color: var(--cc-ink); }
  .up-opp-name { font-size: 12px; font-weight: 500; }
  .up-opp-meta { display: flex; gap: 6px; font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.05em; color: var(--cc-muted); margin-top: 2px; }
  .up-opp-stage { color: var(--cc-champagne); font-weight: 600; }

  /* RECIPIENT AUTOCOMPLETE */
  .recipient-matches { display: flex; flex-direction: column; max-height: 180px; overflow-y: auto; }
  .recipient-match { padding: 8px 10px; border: 1px solid var(--cc-line-soft); cursor: pointer; background: var(--cc-bg); margin-bottom: -1px; }
  .recipient-match:hover { background: var(--cc-bg-alt); border-color: var(--cc-ink); }
  .rm-name { font-weight: 500; font-size: 13px; }
  .rm-meta { font-size: 11px; color: var(--cc-muted); margin-top: 2px; }
  .photos-toggle { padding-top: 8px; }
`;
