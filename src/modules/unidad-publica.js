// ============================================================
// CARCASH · LANDING PÚBLICA DE UNIDAD
// Ruta: /u/:code (sin auth, accesible para cualquiera)
// Diseño: standalone, sin sidebar/topbar del CRM
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, el, injectStyles } from '../lib/dom.js';

const STATUS_LABELS = {
  disponible: 'Disponible',
  reservado: 'Reservado',
};

const local = {
  unit: null,
  business: null,
  galleryIndex: 0,
};

// ============================================================
// MOUNT (público — bypassea el flujo de login)
// ============================================================
export async function mount(params = {}) {
  injectStyles('unidad-publica-styles', styles);

  // Ocultar shell del CRM
  $('#loading')?.classList.add('hidden');
  $('#login')?.classList.add('hidden');
  $('#app')?.classList.add('hidden');

  // Crear contenedor public si no existe
  let host = document.getElementById('public-view');
  if (!host) {
    host = document.createElement('div');
    host.id = 'public-view';
    document.body.appendChild(host);
  }
  host.innerHTML = `<div class="pub-loading">Cargando unidad…</div>`;

  if (!params.code) {
    host.innerHTML = renderError('Link inválido', 'Falta el código de la unidad.');
    return;
  }

  try {
    const [unit, business] = await Promise.all([
      fetchPublicUnit(params.code),
      fetchBusiness(),
    ]);

    if (!unit) {
      host.innerHTML = renderError(
        'Unidad no disponible',
        'Esta unidad ya no está publicada o el link es incorrecto.'
      );
      return;
    }

    local.unit = unit;
    local.business = business;
    local.galleryIndex = 0;
    host.innerHTML = renderUnit();
    attachHandlers();
  } catch (err) {
    console.error(err);
    host.innerHTML = renderError('Error', err.message || 'No se pudo cargar la unidad');
  }
}

export default mount;

// ============================================================
// FETCH (usa la VIEW units_public, no la tabla units)
// Esa view es accesible para anon (sin login)
// ============================================================
async function fetchPublicUnit(code) {
  const { data, error } = await supabase
    .from('units_public')
    .select('*')
    .ilike('unit_code', code.toUpperCase())
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function fetchBusiness() {
  const { data } = await supabase
    .from('business_public')
    .select('*')
    .maybeSingle();
  return data || { name: 'CarCash', phone: null, email: null, address: null };
}

// ============================================================
// RENDER
// ============================================================
function renderError(title, desc) {
  return `
    <div class="pub-wrap pub-error">
      <div class="pub-logo-block">
        <div class="pub-logo">Car<b>Cash</b></div>
        <div class="pub-logo-sub">Premium Motors</div>
      </div>
      <div class="pub-error-card">
        <div class="pub-error-title">${escapeHtml(title)}</div>
        <div class="pub-error-desc">${escapeHtml(desc)}</div>
      </div>
    </div>
  `;
}

function renderUnit() {
  const u = local.unit;
  const b = local.business;
  const photos = collectPhotos(u);

  return `
    <div class="pub-wrap">
      <!-- HEADER -->
      <header class="pub-header">
        <div class="pub-logo-block">
          <div class="pub-logo">Car<b>Cash</b></div>
          <div class="pub-logo-sub">Premium Motors</div>
        </div>
        <div class="pub-status">
          <span class="badge badge-pub-${u.status}">${escapeHtml(STATUS_LABELS[u.status] || u.status)}</span>
        </div>
      </header>

      <!-- HERO: marca/modelo + precio -->
      <section class="pub-hero">
        <div class="pub-hero-head">
          <div class="pub-hero-id">${escapeHtml(u.unit_code)}</div>
          <h1 class="pub-hero-title">
            ${escapeHtml(u.brand)} <i>${escapeHtml(u.model)}</i> <span class="pub-hero-year">'${String(u.year).slice(2)}</span>
          </h1>
          ${u.version ? `<div class="pub-hero-version">${escapeHtml(u.version)}</div>` : ''}
          <div class="pub-hero-price">USD ${escapeHtml(fmt.usd(u.public_price))}</div>
        </div>
      </section>

      <!-- GALERÍA -->
      <section class="pub-gallery">
        ${photos.length ? `
          <div class="pub-gallery-main">
            <img id="pub-gal-img" src="${escapeHtml(photos[0])}" alt="${escapeHtml(u.brand + ' ' + u.model)}">
            ${photos.length > 1 ? `
              <button class="pub-gal-nav prev" id="pub-gal-prev" aria-label="Anterior">‹</button>
              <button class="pub-gal-nav next" id="pub-gal-next" aria-label="Siguiente">›</button>
              <div class="pub-gal-counter"><span id="pub-gal-pos">1</span>/${photos.length}</div>
            ` : ''}
          </div>
          ${photos.length > 1 ? `
            <div class="pub-gal-thumbs" id="pub-gal-thumbs">
              ${photos.map((p, i) => `<div class="pub-gal-thumb ${i === 0 ? 'active' : ''}" data-idx="${i}" style="background-image: url('${escapeHtml(p)}')"></div>`).join('')}
            </div>
          ` : ''}
        ` : '<div class="pub-no-photos">Sin fotos disponibles</div>'}
      </section>

      <!-- HIGHLIGHTS -->
      <section class="pub-highlights">
        ${highlight('Año', u.year)}
        ${highlight('Kilómetros', fmt.km(u.mileage))}
        ${u.color_exterior ? highlight('Color', u.color_exterior) : ''}
        ${u.transmission ? highlight('Caja', u.transmission) : ''}
        ${u.fuel_type ? highlight('Combustible', u.fuel_type) : ''}
        ${u.horsepower ? highlight('Potencia', u.horsepower + ' hp') : ''}
      </section>

      <!-- DESCRIPCIÓN + EQUIPAMIENTO + FICHA -->
      <section class="pub-content">
        ${u.description ? `
          <div class="pub-block">
            <h2 class="pub-block-hd">Descripción</h2>
            <p class="pub-desc">${escapeHtml(u.description)}</p>
          </div>
        ` : ''}

        ${u.featured_equipment?.length ? `
          <div class="pub-block">
            <h2 class="pub-block-hd">Equipamiento destacado</h2>
            <ul class="pub-features">
              ${u.featured_equipment.map(f => `<li>${escapeHtml(f)}</li>`).join('')}
            </ul>
          </div>
        ` : ''}

        <div class="pub-block">
          <h2 class="pub-block-hd">Ficha técnica</h2>
          <div class="pub-specs">
            ${specRow('Marca', u.brand)}
            ${specRow('Modelo', u.model)}
            ${specRow('Versión', u.version)}
            ${specRow('Año', u.year)}
            ${specRow('Tipo de carrocería', u.body_type)}
            ${specRow('Combustible', u.fuel_type)}
            ${specRow('Transmisión', u.transmission)}
            ${specRow('Cilindrada', u.displacement_cc ? u.displacement_cc + ' cc' : null)}
            ${specRow('Potencia', u.horsepower ? u.horsepower + ' hp' : null)}
            ${specRow('Kilometraje', fmt.km(u.mileage))}
            ${specRow('Color exterior', u.color_exterior)}
            ${specRow('Color interior', u.color_interior)}
          </div>
        </div>
      </section>

      <!-- CTA: contacto -->
      <section class="pub-cta">
        <div class="pub-cta-card">
          <h3 class="pub-cta-title">¿Te interesa esta unidad?</h3>
          <p class="pub-cta-desc">Coordiná una visita o consultá por más detalles.</p>
          <div class="pub-cta-actions">
            ${b.phone ? `
              <a class="pub-btn pub-btn-wsp" id="pub-btn-wsp" target="_blank" rel="noopener">
                <span>●</span> Consultar por WhatsApp
              </a>
            ` : ''}
            ${b.phone ? `
              <a class="pub-btn pub-btn-call" href="tel:${escapeHtml(String(b.phone).replace(/\s/g, ''))}">
                <span>☎</span> Llamar al ${escapeHtml(b.phone)}
              </a>
            ` : ''}
            ${b.email ? `
              <a class="pub-btn pub-btn-mail" id="pub-btn-mail">
                <span>✉</span> Email
              </a>
            ` : ''}
          </div>
        </div>
      </section>

      <!-- FOOTER -->
      <footer class="pub-footer">
        <div class="pub-footer-brand">
          <div class="pub-logo">Car<b>Cash</b></div>
          <div class="pub-logo-sub">${escapeHtml(b.name || 'Premium Motors')}</div>
        </div>
        ${b.address ? `<div class="pub-footer-addr">${escapeHtml(b.address)}</div>` : ''}
        ${b.email ? `<div class="pub-footer-mail"><a href="mailto:${escapeHtml(b.email)}">${escapeHtml(b.email)}</a></div>` : ''}
        <div class="pub-footer-meta">${escapeHtml(u.unit_code)} · Consulta sujeta a disponibilidad. Precios en dólares.</div>
      </footer>
    </div>
  `;
}

function highlight(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return `
    <div class="pub-hl">
      <div class="pub-hl-label">${escapeHtml(label)}</div>
      <div class="pub-hl-value">${escapeHtml(value)}</div>
    </div>
  `;
}

function specRow(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return `
    <div class="pub-spec-row">
      <span>${escapeHtml(label)}</span>
      <b>${escapeHtml(value)}</b>
    </div>
  `;
}

function collectPhotos(u) {
  const all = [u.main_photo_url, ...(u.photos || [])].filter(Boolean);
  return [...new Set(all)];
}

// ============================================================
// HANDLERS
// ============================================================
function attachHandlers() {
  const photos = collectPhotos(local.unit);

  // Galería
  if (photos.length > 1) {
    $('#pub-gal-prev')?.addEventListener('click', () => setGallery(photos, local.galleryIndex - 1));
    $('#pub-gal-next')?.addEventListener('click', () => setGallery(photos, local.galleryIndex + 1));
    $('#pub-gal-thumbs')?.addEventListener('click', (e) => {
      const t = e.target.closest('.pub-gal-thumb');
      if (!t) return;
      setGallery(photos, parseInt(t.dataset.idx, 10));
    });
    document.addEventListener('keydown', galleryKeyHandler);
  }

  // Botón WhatsApp con mensaje pre-armado
  const wspBtn = $('#pub-btn-wsp');
  if (wspBtn && local.business.phone) {
    const u = local.unit;
    const phone = String(local.business.phone).replace(/\D/g, '');
    const msg = `Hola! Me interesa la unidad *${u.brand} ${u.model} ${u.year}* (${u.unit_code}) que tienen publicada por USD ${fmt.usd(u.public_price)}. ¿Sigue disponible?`;
    wspBtn.href = `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
  }

  // Botón Email con asunto pre-armado
  const mailBtn = $('#pub-btn-mail');
  if (mailBtn && local.business.email) {
    const u = local.unit;
    const subject = `Consulta · ${u.brand} ${u.model} ${u.year} (${u.unit_code})`;
    const body = `Hola, me interesa la unidad ${u.brand} ${u.model} ${u.year} (${u.unit_code}) publicada por USD ${fmt.usd(u.public_price)}. Quisiera coordinar una visita.\n\nGracias.`;
    mailBtn.href = `mailto:${local.business.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }
}

function galleryKeyHandler(e) {
  if (!document.getElementById('pub-gal-img')) {
    document.removeEventListener('keydown', galleryKeyHandler);
    return;
  }
  const photos = collectPhotos(local.unit);
  if (e.key === 'ArrowLeft') setGallery(photos, local.galleryIndex - 1);
  else if (e.key === 'ArrowRight') setGallery(photos, local.galleryIndex + 1);
}

function setGallery(photos, idx) {
  if (idx < 0) idx = photos.length - 1;
  if (idx >= photos.length) idx = 0;
  local.galleryIndex = idx;
  $('#pub-gal-img').src = photos[idx];
  $('#pub-gal-pos').textContent = String(idx + 1);
  document.querySelectorAll('.pub-gal-thumb').forEach((t, i) => {
    t.classList.toggle('active', i === idx);
  });
}

// ============================================================
// STYLES (standalone, no depende del shell del CRM)
// ============================================================
const styles = `
  #public-view {
    min-height: 100vh;
    background: var(--cc-bg);
    position: relative;
    z-index: 1;
  }
  .pub-wrap {
    max-width: 980px;
    margin: 0 auto;
    padding: 0 16px;
  }
  @media (min-width: 700px) {
    .pub-wrap { padding: 0 24px; }
  }

  .pub-loading {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--cc-font-mono);
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--cc-muted);
  }

  /* HEADER */
  .pub-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 22px 0 16px;
    border-bottom: 1px solid var(--cc-line);
    margin-bottom: 30px;
  }
  .pub-logo-block { display: flex; flex-direction: column; gap: 4px; }
  .pub-logo {
    font-family: var(--cc-font-display);
    font-weight: 300;
    font-size: 24px;
    letter-spacing: -0.01em;
  }
  .pub-logo b { font-weight: 600; font-style: italic; color: var(--cc-champagne); }
  .pub-logo-sub {
    font-family: var(--cc-font-mono);
    font-size: 9px;
    letter-spacing: 0.3em;
    text-transform: uppercase;
    color: var(--cc-muted);
  }
  .badge-pub-disponible {
    background: var(--cc-ok);
    color: white;
    border-color: var(--cc-ok);
    padding: 4px 12px;
    font-family: var(--cc-font-mono);
    font-size: 10px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .badge-pub-reservado {
    background: var(--cc-champagne);
    color: var(--cc-ink);
    border-color: var(--cc-champagne);
    padding: 4px 12px;
    font-family: var(--cc-font-mono);
    font-size: 10px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    font-weight: 600;
  }

  /* HERO */
  .pub-hero { margin-bottom: 28px; }
  .pub-hero-id {
    font-family: var(--cc-font-mono);
    font-size: 10px;
    letter-spacing: 0.3em;
    text-transform: uppercase;
    color: var(--cc-champagne);
    font-weight: 600;
    margin-bottom: 8px;
  }
  .pub-hero-title {
    font-family: var(--cc-font-display);
    font-weight: 300;
    font-size: 38px;
    letter-spacing: -0.025em;
    line-height: 1.05;
    margin: 0;
  }
  @media (min-width: 700px) {
    .pub-hero-title { font-size: 56px; }
  }
  .pub-hero-title i { font-style: italic; font-weight: 500; }
  .pub-hero-year {
    font-family: var(--cc-font-mono);
    font-size: 0.55em;
    color: var(--cc-muted);
    font-weight: 400;
    letter-spacing: 0;
    margin-left: 6px;
  }
  .pub-hero-version {
    font-size: 14px;
    color: var(--cc-muted);
    margin-top: 6px;
  }
  .pub-hero-price {
    font-family: var(--cc-font-mono);
    font-weight: 600;
    font-size: 28px;
    color: var(--cc-ink);
    margin-top: 18px;
    padding: 10px 0;
    border-top: 1px solid var(--cc-line);
    border-bottom: 1px solid var(--cc-line);
  }
  @media (min-width: 700px) {
    .pub-hero-price { font-size: 36px; }
  }

  /* GALERÍA */
  .pub-gallery { margin-bottom: 28px; background: var(--cc-surface); border: 1px solid var(--cc-line); }
  .pub-gallery-main { aspect-ratio: 16/9; background: var(--cc-bg-alt); position: relative; overflow: hidden; }
  .pub-gallery-main img { width: 100%; height: 100%; object-fit: cover; }
  .pub-gal-nav {
    position: absolute; top: 50%; transform: translateY(-50%);
    background: rgba(17,17,17,0.6); color: white; border: none;
    width: 44px; height: 44px; font-size: 26px; cursor: pointer;
    transition: background 0.15s;
  }
  .pub-gal-nav:hover { background: rgba(17,17,17,0.85); }
  .pub-gal-nav.prev { left: 16px; }
  .pub-gal-nav.next { right: 16px; }
  .pub-gal-counter {
    position: absolute; bottom: 16px; right: 16px;
    background: rgba(17,17,17,0.7); color: white;
    padding: 5px 12px;
    font-family: var(--cc-font-mono); font-size: 10px;
    letter-spacing: 0.1em;
  }
  .pub-gal-thumbs {
    display: flex; gap: 1px; padding: 8px;
    background: var(--cc-bg-alt); overflow-x: auto;
  }
  .pub-gal-thumb {
    width: 92px; height: 60px; flex-shrink: 0;
    background-size: cover; background-position: center;
    cursor: pointer; opacity: 0.55;
    border: 2px solid transparent;
  }
  .pub-gal-thumb:hover { opacity: 1; }
  .pub-gal-thumb.active { opacity: 1; border-color: var(--cc-ink); }

  /* HIGHLIGHTS */
  .pub-highlights {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1px;
    background: var(--cc-line);
    margin-bottom: 28px;
    border: 1px solid var(--cc-line);
  }
  @media (min-width: 700px) {
    .pub-highlights { grid-template-columns: repeat(3, 1fr); }
  }
  @media (min-width: 900px) {
    .pub-highlights { grid-template-columns: repeat(6, 1fr); }
  }
  .pub-hl { background: var(--cc-surface); padding: 14px 16px; }
  .pub-hl-label {
    font-family: var(--cc-font-mono);
    font-size: 9px;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--cc-muted);
    font-weight: 500;
    margin-bottom: 4px;
  }
  .pub-hl-value {
    font-size: 15px;
    font-weight: 500;
  }

  /* CONTENT BLOCKS */
  .pub-content { margin-bottom: 28px; }
  .pub-block {
    background: var(--cc-surface);
    border: 1px solid var(--cc-line);
    margin-bottom: 18px;
  }
  .pub-block-hd {
    padding: 14px 18px;
    border-bottom: 1px solid var(--cc-line-soft);
    font-family: var(--cc-font-mono);
    font-size: 10px;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--cc-ink);
    font-weight: 600;
    margin: 0;
  }
  .pub-desc {
    padding: 16px 18px;
    font-size: 14px;
    line-height: 1.7;
    color: var(--cc-ink-soft);
    margin: 0;
  }
  .pub-features {
    padding: 14px 18px 18px;
    list-style: none;
    margin: 0;
    display: grid;
    grid-template-columns: 1fr;
    gap: 6px 20px;
  }
  @media (min-width: 600px) {
    .pub-features { grid-template-columns: 1fr 1fr; }
  }
  .pub-features li {
    padding: 5px 0 5px 18px;
    position: relative;
    font-size: 13px;
  }
  .pub-features li::before {
    content: '◆';
    position: absolute;
    left: 0;
    color: var(--cc-champagne);
    font-size: 9px;
    top: 8px;
  }
  .pub-specs { padding: 4px 0; }
  .pub-spec-row {
    display: flex;
    justify-content: space-between;
    padding: 9px 18px;
    border-bottom: 1px solid var(--cc-line-soft);
    font-size: 13px;
  }
  .pub-spec-row:last-child { border-bottom: none; }
  .pub-spec-row span { color: var(--cc-muted); }
  .pub-spec-row b { font-weight: 500; text-align: right; }

  /* CTA */
  .pub-cta {
    margin-bottom: 28px;
  }
  .pub-cta-card {
    background: var(--cc-ink);
    color: var(--cc-bg);
    padding: 28px 24px;
    text-align: center;
  }
  .pub-cta-title {
    font-family: var(--cc-font-display);
    font-weight: 400;
    font-size: 24px;
    margin: 0 0 8px;
    letter-spacing: -0.01em;
  }
  .pub-cta-desc {
    font-size: 13px;
    color: var(--cc-platinum);
    margin: 0 0 22px;
  }
  .pub-cta-actions {
    display: flex;
    gap: 8px;
    justify-content: center;
    flex-wrap: wrap;
  }
  .pub-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 11px 18px;
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.05em;
    text-decoration: none;
    cursor: pointer;
    border: 1px solid var(--cc-bg);
    transition: all 0.15s;
  }
  .pub-btn-wsp {
    background: var(--cc-wsp);
    color: white;
    border-color: var(--cc-wsp);
  }
  .pub-btn-wsp:hover {
    opacity: 0.9;
  }
  .pub-btn-call {
    background: var(--cc-bg);
    color: var(--cc-ink);
    border-color: var(--cc-bg);
  }
  .pub-btn-call:hover {
    background: transparent;
    color: var(--cc-bg);
    border-color: var(--cc-bg);
  }
  .pub-btn-mail {
    background: transparent;
    color: var(--cc-bg);
    border-color: var(--cc-platinum);
  }
  .pub-btn-mail:hover {
    background: var(--cc-bg);
    color: var(--cc-ink);
  }

  /* FOOTER */
  .pub-footer {
    padding: 28px 0;
    border-top: 1px solid var(--cc-line);
    text-align: center;
    color: var(--cc-muted);
    font-size: 12px;
  }
  .pub-footer-brand { margin-bottom: 12px; display: inline-flex; flex-direction: column; gap: 2px; align-items: center; }
  .pub-footer-addr { margin-bottom: 4px; font-size: 12px; }
  .pub-footer-mail { margin-bottom: 12px; }
  .pub-footer-mail a { color: var(--cc-ink); text-decoration: underline; }
  .pub-footer-meta {
    font-family: var(--cc-font-mono);
    font-size: 9px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--cc-steel);
    margin-top: 12px;
  }

  /* ERROR STATE */
  .pub-error {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    text-align: center;
    padding: 40px 20px;
  }
  .pub-error-card {
    background: var(--cc-surface);
    border: 1px solid var(--cc-line);
    padding: 32px;
    max-width: 420px;
    margin-top: 28px;
  }
  .pub-error-title {
    font-family: var(--cc-font-display);
    font-weight: 400;
    font-size: 24px;
    margin-bottom: 10px;
  }
  .pub-error-desc { font-size: 13px; color: var(--cc-muted); line-height: 1.6; }

  .pub-no-photos {
    aspect-ratio: 16/9;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--cc-muted);
    font-family: var(--cc-font-mono);
    font-size: 11px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    background: var(--cc-bg-alt);
  }
`;
