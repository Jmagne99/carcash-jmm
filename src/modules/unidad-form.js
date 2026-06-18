// ============================================================
// CARCASH · MÓDULO ALTA/EDICIÓN DE UNIDAD
// Rutas:
//   /unidades/nueva
//   /unidades/:id/editar
// Solo admin / gerente.
//
// Características:
//   - Form completo con todos los campos del schema
//   - Subida múltiple de fotos a Supabase Storage (bucket unit-photos)
//   - Reconocimiento de cédula/título via Claude Vision (stub si no hay Edge Function)
//   - Validaciones (patente, VIN, año, precios)
//   - Borrado lógico (soft delete) de unidades
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { state, isAdmin, currentUserId } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { isValidPlate, isValidVIN, isValidCarYear, isValidAmount } from '../lib/validators.js';
import { $, $$, el, toast, injectStyles, confirmDialog } from '../lib/dom.js';
import { navigate } from '../lib/router.js';
import { triggerAutoPublish } from '../lib/publish.js';

// ============================================================
// CONFIG
// ============================================================
const FUEL_TYPES = ['nafta', 'diesel', 'híbrido', 'eléctrico', 'GNC', 'flex'];
const TRANSMISSIONS = ['manual', 'automática', 'CVT', 'DCT', 'PDK'];
const BODY_TYPES = ['sedán', 'coupé', 'hatchback', 'SUV', 'pickup', 'familiar', 'cabrio', 'monovolumen', 'crossover'];
const STATUS_OPTIONS = [
  { id: 'en_preparacion', label: 'En preparación' },
  { id: 'disponible', label: 'Disponible para venta' },
  { id: 'reservado', label: 'Reservado' },
  { id: 'vendido', label: 'Vendido' },
  { id: 'entregado', label: 'Entregado' },
  { id: 'devuelto', label: 'Devuelto al consignante' },
  { id: 'baja', label: 'Baja' },
];
const LOCATION_OPTIONS = [
  { id: 'showroom', label: 'Showroom' },
  { id: 'deposito', label: 'Depósito' },
  { id: 'taller', label: 'Taller' },
  { id: 'en_transferencia', label: 'En transferencia' },
  { id: 'entregado', label: 'Entregado' },
];
const MODALITY_OPTIONS = [
  { id: 'propio', label: 'Propio (compra-venta directa)' },
  { id: 'consignacion', label: 'Consignación (de un tercero)' },
  { id: 'permuta_tomada', label: 'Permuta tomada' },
];

// Marcas premium frecuentes
const COMMON_BRANDS = [
  'Audi', 'BMW', 'Mercedes-Benz', 'Porsche', 'Land Rover', 'Range Rover',
  'Lexus', 'Volvo', 'Mini', 'Volkswagen', 'Jeep', 'Ford', 'Toyota',
  'Honda', 'Nissan', 'Mazda', 'Fiat', 'Renault', 'Peugeot', 'Citroën',
  'Chevrolet', 'Ferrari', 'Lamborghini', 'Maserati', 'McLaren',
];

const local = {
  unit: null,         // si está en modo edición, la unidad cargada
  consignors: [],     // contactos para selector de consignante
  branches: [],       // sucursales disponibles
  photos: [],         // array temporal de URLs de fotos (existentes + nuevas)
  pendingUploads: 0,
  ocrLoading: false,
};

// ============================================================
// MOUNT
// ============================================================
export async function mount(params = {}) {
  injectStyles('unidad-form-styles', styles);

  if (!isAdmin()) {
    $('#view').innerHTML = `
      <div class="placeholder">
        <div class="placeholder-content">
          <div class="placeholder-num">×</div>
          <div class="placeholder-title">Acceso <i>restringido</i></div>
          <div class="placeholder-desc">Solo dueño/gerente pueden cargar o editar unidades.</div>
          <div class="placeholder-status">NO AUTORIZADO</div>
        </div>
      </div>
    `;
    return;
  }

  // Cargar consignores y sucursales en paralelo
  fetchConsignors();
  fetchBranches();

  if (params.id) {
    await loadUnit(params.id);
    if (!local.unit) {
      $('#view').innerHTML = `
        <div class="placeholder">
          <div class="placeholder-content">
            <div class="placeholder-num">404</div>
            <div class="placeholder-title">Unidad no <i>encontrada</i></div>
            <div class="placeholder-status" style="cursor:pointer" onclick="location.hash='#/unidades'">VOLVER</div>
          </div>
        </div>
      `;
      return;
    }
    local.photos = collectPhotos(local.unit);
  } else {
    local.unit = null;
    local.photos = [];
  }
  renderForm();
}

export default mount;

// ============================================================
// FETCH
// ============================================================
async function loadUnit(idOrCode) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(idOrCode);
  let q = supabase.from('units').select('*').is('deleted_at', null);
  if (isUuid) q = q.eq('id', idOrCode);
  else q = q.ilike('unit_code', idOrCode.toUpperCase());
  const { data, error } = await q.maybeSingle();
  if (error) {
    toast('Error', error.message, 'error');
    return;
  }
  local.unit = data;
}

async function fetchBranches() {
  const { data } = await supabase
    .from('branches')
    .select('id, code, name')
    .eq('is_active', true)
    .order('name');
  local.branches = data || [];
  // Re-render del select si ya está montado
  const sel = $('#f-branch');
  if (sel) populateBranchSelect(sel);
}

function populateBranchSelect(sel) {
  const current = local.unit?.branch_id;
  sel.innerHTML = '';
  for (const b of local.branches) {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.name;
    if (b.id === current || (!current && b.code === 'caning')) opt.selected = true;
    sel.appendChild(opt);
  }
}

async function fetchConsignors() {
  const { data } = await supabase
    .from('contacts')
    .select('id, full_name, phone, dni_cuit')
    .is('deleted_at', null)
    .order('full_name')
    .limit(100);
  local.consignors = data || [];
  // Re-render del select si ya está montado
  const sel = $('#f-consignor');
  if (sel) populateConsignorSelect(sel);
}

function collectPhotos(u) {
  const all = [u.main_photo_url, ...(u.photos || [])].filter(Boolean);
  return [...new Set(all)];
}

// ============================================================
// RENDER
// ============================================================
function renderForm() {
  const u = local.unit || {};
  const isEdit = !!local.unit;

  $('#view').innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">MÓDULO 06 · STOCK</div>
          <div class="page-title">${isEdit ? `Editar <i>${escapeHtml(u.brand + ' ' + u.model)}</i>` : 'Nueva <i>unidad</i>'}</div>
          <div class="page-sub">${isEdit ? `${escapeHtml(u.unit_code)} · ${escapeHtml(fmt.plate(u.license_plate))}` : 'Cargá los datos del auto · podés autocompletar con foto de cédula verde'}</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-ghost" id="btn-cancel">Cancelar</button>
          ${isEdit ? '<button class="btn btn-danger" id="btn-delete">Dar de baja</button>' : ''}
          <button class="btn btn-ok" id="btn-save">${isEdit ? 'Guardar cambios' : 'Crear unidad'}</button>
        </div>
      </div>
    </div>

    <form class="unit-form" id="unit-form" autocomplete="off">

      <!-- ASISTENTE OCR -->
      <div class="form-section ocr-banner">
        <div class="ocr-content">
          <div class="ocr-icon">📷</div>
          <div class="ocr-text">
            <div class="ocr-title">Autocompletar desde foto</div>
            <div class="ocr-desc">Subí una foto clara de la cédula verde, título o cédula azul y se autocompletan los campos. Lo extrae Claude Vision.</div>
          </div>
          <div class="ocr-actions">
            <input type="file" id="ocr-file" accept="image/*" hidden>
            <button type="button" class="btn" id="btn-ocr">📷 Subir cédula/título</button>
          </div>
        </div>
      </div>

      <!-- IDENTIFICACIÓN -->
      <div class="form-section">
        <div class="form-section-hd">Identificación</div>
        <div class="form-section-body">
          <div class="field-row">
            <div class="field">
              <label class="loss-label">Patente <span class="req">*</span></label>
              <input type="text" id="f-plate" class="loss-select" placeholder="AB123CD o ABC123" value="${escapeHtml(fmt.plate(u.license_plate))}" required maxlength="8">
              <div class="field-err" id="err-plate"></div>
            </div>
            <div class="field">
              <label class="loss-label">VIN / Chasis</label>
              <input type="text" id="f-vin" class="loss-select" placeholder="17 caracteres" value="${escapeHtml(u.vin || '')}" maxlength="17">
              <div class="field-err" id="err-vin"></div>
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label class="loss-label">Número de motor</label>
              <input type="text" id="f-engine" class="loss-select" value="${escapeHtml(u.engine_number || '')}">
            </div>
            <div class="field">
              <label class="loss-label">Año <span class="req">*</span></label>
              <input type="number" id="f-year" class="loss-select" min="1950" max="${new Date().getFullYear() + 1}" value="${u.year || new Date().getFullYear()}" required>
              <div class="field-err" id="err-year"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- FICHA TÉCNICA -->
      <div class="form-section">
        <div class="form-section-hd">Ficha técnica</div>
        <div class="form-section-body">
          <div class="field-row">
            <div class="field">
              <label class="loss-label">Marca <span class="req">*</span></label>
              <input type="text" id="f-brand" class="loss-select" list="brand-list" value="${escapeHtml(u.brand || '')}" required>
              <datalist id="brand-list">
                ${COMMON_BRANDS.map(b => `<option value="${b}">`).join('')}
              </datalist>
            </div>
            <div class="field">
              <label class="loss-label">Modelo <span class="req">*</span></label>
              <input type="text" id="f-model" class="loss-select" value="${escapeHtml(u.model || '')}" required>
            </div>
            <div class="field">
              <label class="loss-label">Versión</label>
              <input type="text" id="f-version" class="loss-select" placeholder="Ej: PDK 8v" value="${escapeHtml(u.version || '')}">
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label class="loss-label">Tipo de carrocería</label>
              <select id="f-body-type" class="loss-select">
                <option value="">—</option>
                ${BODY_TYPES.map(b => `<option value="${b}" ${u.body_type === b ? 'selected' : ''}>${b}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label class="loss-label">Combustible</label>
              <select id="f-fuel" class="loss-select">
                <option value="">—</option>
                ${FUEL_TYPES.map(f => `<option value="${f}" ${u.fuel_type === f ? 'selected' : ''}>${f}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label class="loss-label">Transmisión</label>
              <select id="f-transmission" class="loss-select">
                <option value="">—</option>
                ${TRANSMISSIONS.map(t => `<option value="${t}" ${u.transmission === t ? 'selected' : ''}>${t}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label class="loss-label">Cilindrada (cc)</label>
              <input type="number" id="f-displacement" class="loss-select" value="${u.displacement_cc || ''}" min="0" max="10000">
            </div>
            <div class="field">
              <label class="loss-label">Potencia (hp)</label>
              <input type="number" id="f-horsepower" class="loss-select" value="${u.horsepower || ''}" min="0" max="2000">
            </div>
            <div class="field">
              <label class="loss-label">Kilometraje <span class="req">*</span></label>
              <input type="number" id="f-mileage" class="loss-select" value="${u.mileage || 0}" min="0" required>
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label class="loss-label">Color exterior</label>
              <input type="text" id="f-color-ext" class="loss-select" value="${escapeHtml(u.color_exterior || '')}">
            </div>
            <div class="field">
              <label class="loss-label">Color interior</label>
              <input type="text" id="f-color-int" class="loss-select" value="${escapeHtml(u.color_interior || '')}">
            </div>
          </div>
        </div>
      </div>

      <!-- MODALIDAD COMERCIAL -->
      <div class="form-section">
        <div class="form-section-hd">Modalidad comercial</div>
        <div class="form-section-body">
          <div class="field-row">
            <div class="field">
              <label class="loss-label">Modalidad <span class="req">*</span></label>
              <select id="f-modality" class="loss-select" required>
                ${MODALITY_OPTIONS.map(m => `<option value="${m.id}" ${u.modality === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}
              </select>
            </div>
          </div>
          <div id="consignment-section" class="${u.modality === 'consignacion' ? '' : 'hidden'}">
            <div class="field-row">
              <div class="field" style="flex:2">
                <label class="loss-label">Consignante</label>
                <select id="f-consignor" class="loss-select"></select>
                <div class="field-hint">Cargá primero el contacto en /contactos si no aparece</div>
              </div>
              <div class="field">
                <label class="loss-label">Precio acordado (USD)</label>
                <input type="number" id="f-cons-price" class="loss-select" value="${u.consignor_agreed_price || ''}" min="0">
              </div>
              <div class="field">
                <label class="loss-label">Comisión (%)</label>
                <input type="number" id="f-cons-comm" class="loss-select" value="${u.consignor_commission_pct || ''}" min="0" max="50" step="0.5">
              </div>
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label class="loss-label">Costo de adquisición (USD)</label>
              <input type="number" id="f-acq-cost" class="loss-select" value="${u.acquisition_cost || ''}" min="0">
              <div class="field-hint">Lo que pagaste por el auto · No se muestra al público</div>
            </div>
            <div class="field">
              <label class="loss-label">Fecha de ingreso</label>
              <input type="date" id="f-acq-date" class="loss-select" value="${u.acquisition_date || new Date().toISOString().slice(0, 10)}">
            </div>
          </div>
        </div>
      </div>

      <!-- PRECIOS -->
      <div class="form-section">
        <div class="form-section-hd">Precios</div>
        <div class="form-section-body">
          <div class="field-row">
            <div class="field">
              <label class="loss-label">Precio público (USD) <span class="req">*</span></label>
              <input type="number" id="f-public-price" class="loss-select" value="${u.public_price || ''}" min="0" step="500" required>
              <div class="field-hint">Visible en publicaciones y landing pública</div>
            </div>
            <div class="field">
              <label class="loss-label">Precio mínimo autorizado (USD) <span class="req">*</span></label>
              <input type="number" id="f-min-price" class="loss-select" value="${u.minimum_price || ''}" min="0" step="500" required>
              <div class="field-hint">El vendedor no puede cerrar abajo de este monto</div>
            </div>
          </div>
          <div class="margin-preview" id="margin-preview"></div>
        </div>
      </div>

      <!-- ESTADO Y UBICACIÓN -->
      <div class="form-section">
        <div class="form-section-hd">Estado y ubicación</div>
        <div class="form-section-body">
          <div class="field-row">
            <div class="field">
              <label class="loss-label">Sucursal <span class="req">*</span></label>
              <select id="f-branch" class="loss-select" required></select>
              <div class="field-hint">Determina dónde se contabiliza el stock y las ventas</div>
            </div>
            <div class="field">
              <label class="loss-label">Estado <span class="req">*</span></label>
              <select id="f-status" class="loss-select" required>
                ${STATUS_OPTIONS.map(s => `<option value="${s.id}" ${(u.status || 'en_preparacion') === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label class="loss-label">Ubicación física</label>
              <select id="f-location" class="loss-select">
                ${LOCATION_OPTIONS.map(l => `<option value="${l.id}" ${(u.location || 'deposito') === l.id ? 'selected' : ''}>${l.label}</option>`).join('')}
              </select>
            </div>
          </div>
        </div>
      </div>

      <!-- DESCRIPCIÓN COMERCIAL -->
      <div class="form-section">
        <div class="form-section-hd">Descripción y equipamiento</div>
        <div class="form-section-body">
          <div class="field">
            <label class="loss-label">Descripción comercial</label>
            <textarea id="f-description" class="loss-notes" rows="3" placeholder="Texto que se va a usar en las publicaciones y landing pública">${escapeHtml(u.description || '')}</textarea>
          </div>
          <div class="field">
            <label class="loss-label">Equipamiento destacado</label>
            <textarea id="f-equipment" class="loss-notes" rows="3" placeholder="Una característica por línea&#10;Ej:&#10;Techo panorámico&#10;Cuero nappa&#10;Sport Chrono">${escapeHtml((u.featured_equipment || []).join('\n'))}</textarea>
            <div class="field-hint">Una característica por línea</div>
          </div>
        </div>
      </div>

      <!-- AUTO-PUBLISH -->
      <div class="form-section">
        <div class="form-section-hd">Publicación automática</div>
        <div class="form-section-body">
          <div class="ap-intro">Al guardar la unidad como <b>Disponible</b>, se publica automáticamente en los canales seleccionados.</div>
          <div class="ap-channels">
            <label class="ap-channel">
              <input type="checkbox" id="ap-ml" ${(u.auto_publish_channels || []).includes('mercado_libre') ? 'checked' : ''}>
              <span class="ap-ch-icon" style="color: var(--cc-ml)">◆</span>
              <span class="ap-ch-info">
                <b>Mercado Libre</b>
                <small>Crea / actualiza la publicación con todos los datos y fotos</small>
              </span>
            </label>
            <label class="ap-channel">
              <input type="checkbox" id="ap-ig" ${(u.auto_publish_channels || []).includes('instagram') ? 'checked' : ''}>
              <span class="ap-ch-icon" style="color: var(--cc-ig)">◉</span>
              <span class="ap-ch-info">
                <b>Instagram</b>
                <small>Carrusel con todas las fotos + caption con datos y link público</small>
              </span>
            </label>
          </div>
          <div class="ap-hint">⚠ Las API keys se configuran en Vault de credenciales. Sin ellas, el sistema queda en stand-by hasta que estén disponibles.</div>
        </div>
      </div>

      <!-- FOTOS -->
      <div class="form-section">
        <div class="form-section-hd">Fotos
          <span class="form-section-tag" id="photos-counter">${local.photos.length} fotos</span>
        </div>
        <div class="form-section-body">
          <div class="photos-grid" id="photos-grid">
            ${renderPhotosGrid()}
          </div>
          <div class="photos-actions">
            <input type="file" id="f-photos" accept="image/*" multiple hidden>
            <button type="button" class="btn btn-ghost btn-sm" id="btn-upload-photos">+ Subir fotos</button>
            <button type="button" class="btn btn-ghost btn-sm" id="btn-paste-url">+ Pegar URL</button>
            <span class="photos-hint">La primera foto es la principal · Click en una para hacerla principal · Drag para reordenar</span>
          </div>
        </div>
      </div>

    </form>
  `;

  attachHandlers();
}

function renderPhotosGrid() {
  if (!local.photos.length) {
    return `<div class="photos-empty">Sin fotos cargadas todavía</div>`;
  }
  return local.photos.map((url, i) => `
    <div class="photo-item ${i === 0 ? 'main' : ''}" data-idx="${i}" draggable="true">
      <img src="${escapeHtml(url)}" alt="Foto ${i + 1}" loading="lazy">
      ${i === 0 ? '<div class="photo-badge">PRINCIPAL</div>' : ''}
      <button type="button" class="photo-remove" data-idx="${i}" aria-label="Quitar">×</button>
    </div>
  `).join('');
}

function populateConsignorSelect(sel) {
  const current = local.unit?.consignor_contact_id;
  sel.innerHTML = '<option value="">— Seleccionar contacto —</option>';
  for (const c of local.consignors) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.full_name}${c.dni_cuit ? ' · ' + c.dni_cuit : ''}`;
    if (c.id === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

// ============================================================
// HANDLERS
// ============================================================
function attachHandlers() {
  $('#btn-cancel').addEventListener('click', () => {
    if (local.unit) navigate(`/unidades/${local.unit.unit_code.toLowerCase()}`);
    else navigate('/unidades');
  });

  $('#btn-save').addEventListener('click', submitForm);

  if (local.unit) {
    $('#btn-delete').addEventListener('click', deleteUnit);
  }

  // Modalidad → mostrar/ocultar consignante
  $('#f-modality').addEventListener('change', (e) => {
    const consSection = $('#consignment-section');
    if (e.target.value === 'consignacion') consSection.classList.remove('hidden');
    else consSection.classList.add('hidden');
  });

  // Consignor select
  populateConsignorSelect($('#f-consignor'));

  // Branch select
  if (local.branches.length) populateBranchSelect($('#f-branch'));

  // Margen preview
  const recompute = () => {
    const pub = parseFloat($('#f-public-price').value) || 0;
    const min = parseFloat($('#f-min-price').value) || 0;
    const cost = parseFloat($('#f-acq-cost').value) || 0;
    const margin = pub - cost;
    const marginPct = pub > 0 ? (margin / pub) * 100 : 0;
    const minMargin = min - cost;
    const minMarginPct = min > 0 ? (minMargin / min) * 100 : 0;
    const preview = $('#margin-preview');
    if (cost > 0) {
      preview.innerHTML = `
        <div class="mp-row"><span>Margen al precio público</span><b class="${margin > 0 ? 'ok' : 'danger'}">USD ${fmt.usd(margin)} (${marginPct.toFixed(1)}%)</b></div>
        <div class="mp-row"><span>Margen al precio mínimo</span><b class="${minMargin > 0 ? 'ok' : 'danger'}">USD ${fmt.usd(minMargin)} (${minMarginPct.toFixed(1)}%)</b></div>
      `;
    } else {
      preview.innerHTML = '';
    }
  };
  ['f-public-price', 'f-min-price', 'f-acq-cost'].forEach(id => {
    $('#' + id)?.addEventListener('input', recompute);
  });
  recompute();

  // Fotos
  $('#btn-upload-photos').addEventListener('click', () => $('#f-photos').click());
  $('#f-photos').addEventListener('change', handlePhotoUpload);
  $('#btn-paste-url').addEventListener('click', () => {
    const url = prompt('URL de la foto:');
    if (url && url.trim()) {
      local.photos.push(url.trim());
      refreshPhotosGrid();
    }
  });

  // Click en thumbnail → set principal
  $('#photos-grid').addEventListener('click', (e) => {
    if (e.target.classList.contains('photo-remove')) {
      const idx = parseInt(e.target.dataset.idx, 10);
      local.photos.splice(idx, 1);
      refreshPhotosGrid();
      return;
    }
    const item = e.target.closest('.photo-item');
    if (!item) return;
    const idx = parseInt(item.dataset.idx, 10);
    if (idx === 0) return;
    // Hacer principal: mover al inicio
    const [photo] = local.photos.splice(idx, 1);
    local.photos.unshift(photo);
    refreshPhotosGrid();
  });

  // Drag & drop reorder
  let dragSrc = null;
  $('#photos-grid').addEventListener('dragstart', (e) => {
    const item = e.target.closest('.photo-item');
    if (!item) return;
    dragSrc = parseInt(item.dataset.idx, 10);
    item.style.opacity = '0.4';
  });
  $('#photos-grid').addEventListener('dragend', (e) => {
    const item = e.target.closest('.photo-item');
    if (item) item.style.opacity = '1';
    dragSrc = null;
  });
  $('#photos-grid').addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  $('#photos-grid').addEventListener('drop', (e) => {
    e.preventDefault();
    const item = e.target.closest('.photo-item');
    if (!item || dragSrc === null) return;
    const dst = parseInt(item.dataset.idx, 10);
    if (dst === dragSrc) return;
    const [moved] = local.photos.splice(dragSrc, 1);
    local.photos.splice(dst, 0, moved);
    refreshPhotosGrid();
  });

  // OCR
  $('#btn-ocr').addEventListener('click', () => $('#ocr-file').click());
  $('#ocr-file').addEventListener('change', handleOCR);
}

function refreshPhotosGrid() {
  $('#photos-grid').innerHTML = renderPhotosGrid();
  $('#photos-counter').textContent = `${local.photos.length} fotos`;
}

// ============================================================
// SUBIDA DE FOTOS A SUPABASE STORAGE
// ============================================================
async function handlePhotoUpload(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;

  toast('Subiendo fotos…', `${files.length} archivo${files.length > 1 ? 's' : ''}`, 'info');

  for (const file of files) {
    try {
      // Path: <user_id>/<timestamp>-<random>-<filename>
      const ext = file.name.split('.').pop().toLowerCase();
      const path = `${currentUserId()}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { data, error } = await supabase.storage
        .from('unit-photos')
        .upload(path, file, { contentType: file.type, cacheControl: '3600', upsert: false });
      if (error) throw error;

      // Obtener URL pública
      const { data: urlData } = supabase.storage.from('unit-photos').getPublicUrl(data.path);
      if (urlData?.publicUrl) {
        local.photos.push(urlData.publicUrl);
      }
    } catch (err) {
      console.error('upload error', err);
      toast('Error subiendo foto', `${file.name}: ${err.message}`, 'error');
    }
  }

  refreshPhotosGrid();
  toast('Fotos subidas', `${local.photos.length} totales`, 'ok');
  e.target.value = ''; // reset input
}

// ============================================================
// OCR DE CÉDULA / TÍTULO (stub mientras no haya Edge Function)
// ============================================================
async function handleOCR(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (local.ocrLoading) return;
  local.ocrLoading = true;

  const btn = $('#btn-ocr');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Analizando…';

  try {
    // Subir la foto al bucket privado de documentos primero
    const ext = file.name.split('.').pop().toLowerCase();
    const path = `${currentUserId()}/ocr-${Date.now()}.${ext}`;
    await supabase.storage
      .from('unit-documents')
      .upload(path, file, { contentType: file.type, upsert: false })
      .catch(err => console.warn('upload OCR doc fallo:', err));

    // Llamar a la Edge Function de OCR
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;

    let result;
    try {
      const res = await fetch('/.netlify/functions/ocr-document', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ document_path: path, document_type: 'cedula_verde' }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      result = await res.json();
    } catch (fetchErr) {
      // Edge Function no disponible aún → mock
      console.warn('OCR Edge Function no disponible, usando mock', fetchErr);
      result = mockOCRResult();
      toast('OCR simulado', 'La Edge Function de Claude Vision no está deployada todavía. Mostrando datos de ejemplo.', 'warn');
    }

    // Aplicar campos al form
    applyOCRFields(result);
    toast('Datos extraídos', 'Revisá los campos antes de guardar', 'ok');
  } catch (err) {
    console.error(err);
    toast('Error en OCR', err.message, 'error');
  } finally {
    local.ocrLoading = false;
    btn.disabled = false;
    btn.textContent = originalText;
    e.target.value = '';
  }
}

function mockOCRResult() {
  return {
    license_plate: 'AE742KP',
    vin: '1HGBH41JXMN109186',
    engine_number: 'M96.05A',
    brand: 'Porsche',
    model: '911 Carrera S',
    year: 2023,
    color_exterior: 'Gris GT Plata',
    fuel_type: 'nafta',
    _mock: true,
    _confidence: 0.87,
  };
}

function applyOCRFields(data) {
  const fieldMap = {
    license_plate: 'f-plate',
    vin: 'f-vin',
    engine_number: 'f-engine',
    brand: 'f-brand',
    model: 'f-model',
    version: 'f-version',
    year: 'f-year',
    body_type: 'f-body-type',
    fuel_type: 'f-fuel',
    transmission: 'f-transmission',
    color_exterior: 'f-color-ext',
    color_interior: 'f-color-int',
    displacement_cc: 'f-displacement',
    horsepower: 'f-horsepower',
  };
  for (const [key, fieldId] of Object.entries(fieldMap)) {
    if (data[key] !== undefined && data[key] !== null && data[key] !== '') {
      const input = $('#' + fieldId);
      if (input) {
        input.value = data[key];
        input.classList.add('field-filled');
        setTimeout(() => input.classList.remove('field-filled'), 2000);
      }
    }
  }
}

// ============================================================
// SUBMIT
// ============================================================
async function submitForm() {
  const btn = $('#btn-save');
  btn.disabled = true;
  btn.textContent = 'Guardando…';

  // Limpiar errores previos
  $$('.field-err').forEach(e => e.textContent = '');

  // Recolectar valores
  const equipmentText = $('#f-equipment').value.trim();
  const equipment = equipmentText ? equipmentText.split('\n').map(s => s.trim()).filter(Boolean) : [];

  // Auto-publish channels seleccionados
  const autoChannels = [];
  if ($('#ap-ml')?.checked) autoChannels.push('mercado_libre');
  if ($('#ap-ig')?.checked) autoChannels.push('instagram');

  const payload = {
    auto_publish_channels: autoChannels,
    license_plate: $('#f-plate').value.trim().toUpperCase(),
    vin: $('#f-vin').value.trim() || null,
    engine_number: $('#f-engine').value.trim() || null,
    year: parseInt($('#f-year').value, 10),
    brand: $('#f-brand').value.trim(),
    model: $('#f-model').value.trim(),
    version: $('#f-version').value.trim() || null,
    body_type: $('#f-body-type').value || null,
    fuel_type: $('#f-fuel').value || null,
    transmission: $('#f-transmission').value || null,
    displacement_cc: parseInt($('#f-displacement').value, 10) || null,
    horsepower: parseInt($('#f-horsepower').value, 10) || null,
    mileage: parseInt($('#f-mileage').value, 10) || 0,
    color_exterior: $('#f-color-ext').value.trim() || null,
    color_interior: $('#f-color-int').value.trim() || null,
    modality: $('#f-modality').value,
    consignor_contact_id: $('#f-modality').value === 'consignacion' ? ($('#f-consignor').value || null) : null,
    consignor_agreed_price: $('#f-modality').value === 'consignacion' ? (parseFloat($('#f-cons-price').value) || null) : null,
    consignor_commission_pct: $('#f-modality').value === 'consignacion' ? (parseFloat($('#f-cons-comm').value) || null) : null,
    acquisition_cost: parseFloat($('#f-acq-cost').value) || null,
    acquisition_date: $('#f-acq-date').value || null,
    public_price: parseFloat($('#f-public-price').value),
    minimum_price: parseFloat($('#f-min-price').value),
    status: $('#f-status').value,
    location: $('#f-location').value,
    branch_id: $('#f-branch')?.value || null,
    description: $('#f-description').value.trim() || null,
    featured_equipment: equipment.length ? equipment : null,
    photos: local.photos,
    main_photo_url: local.photos[0] || null,
  };

  // Validaciones
  const errors = {};
  if (!payload.brand) errors['err-plate'] = 'La marca es obligatoria';
  if (!payload.model) errors['err-plate'] = 'El modelo es obligatorio';
  if (!isValidPlate(payload.license_plate)) errors['err-plate'] = 'Patente inválida (formato AB123CD o ABC123)';
  if (payload.vin && !isValidVIN(payload.vin)) errors['err-vin'] = 'VIN inválido (17 caracteres alfanuméricos sin I/O/Q)';
  if (!isValidCarYear(payload.year)) errors['err-year'] = 'Año fuera de rango';
  if (!payload.public_price || payload.public_price <= 0) errors['err-plate'] = 'El precio público es obligatorio';
  if (!payload.minimum_price || payload.minimum_price <= 0) errors['err-plate'] = 'El precio mínimo es obligatorio';
  if (payload.minimum_price > payload.public_price) errors['err-plate'] = 'El precio mínimo no puede ser mayor al público';

  if (Object.keys(errors).length) {
    for (const [id, msg] of Object.entries(errors)) {
      const el2 = $('#' + id);
      if (el2) el2.textContent = msg;
    }
    toast('Revisá los campos marcados', null, 'warn');
    btn.disabled = false;
    btn.textContent = local.unit ? 'Guardar cambios' : 'Crear unidad';
    return;
  }

  try {
    let savedUnitId, savedUnitCode;
    if (local.unit) {
      // UPDATE
      const { error } = await supabase
        .from('units')
        .update(payload)
        .eq('id', local.unit.id);
      if (error) throw error;
      savedUnitId = local.unit.id;
      savedUnitCode = local.unit.unit_code;
      toast('Unidad actualizada', payload.brand + ' ' + payload.model, 'ok');
    } else {
      // INSERT
      payload.created_by = currentUserId();
      const { data, error } = await supabase
        .from('units')
        .insert(payload)
        .select('id, unit_code')
        .single();
      if (error) throw error;
      savedUnitId = data.id;
      savedUnitCode = data.unit_code;
      toast(`Unidad ${data.unit_code} creada`, payload.brand + ' ' + payload.model, 'ok');
    }

    // Auto-publish si está disponible y hay canales seleccionados
    if (payload.status === 'disponible' && autoChannels.length) {
      toast('Publicando…', `Disparando publicación a ${autoChannels.length} canal${autoChannels.length > 1 ? 'es' : ''}`, 'info');
      const results = await triggerAutoPublish(savedUnitId, autoChannels);
      results.forEach(r => {
        if (r.ok) toast(`✓ Publicado en ${r.channel}`, r.url || '', 'ok');
        else if (r.mock) toast(`◌ ${r.channel} en stand-by`, 'Edge Functions todavía no deployadas', 'warn');
        else toast(`✗ Error en ${r.channel}`, r.error, 'error');
      });
    }

    navigate(`/unidades/${savedUnitCode.toLowerCase()}`);
  } catch (err) {
    console.error(err);
    toast('Error guardando unidad', err.message, 'error');
    btn.disabled = false;
    btn.textContent = local.unit ? 'Guardar cambios' : 'Crear unidad';
  }
}

async function deleteUnit() {
  if (!local.unit) return;
  const ok = await confirmDialog(
    `¿Dar de baja ${local.unit.brand} ${local.unit.model} (${local.unit.unit_code})? Sale del stock pero se mantiene el historial.`,
    { okText: 'Dar de baja' }
  );
  if (!ok) return;

  try {
    const { error } = await supabase
      .from('units')
      .update({ deleted_at: new Date().toISOString(), status: 'baja' })
      .eq('id', local.unit.id);
    if (error) throw error;
    toast('Unidad dada de baja', local.unit.unit_code, 'warn');
    navigate('/unidades');
  } catch (err) {
    toast('Error', err.message, 'error');
  }
}

// ============================================================
// STYLES
// ============================================================
const styles = `
  .unit-form { padding: 0 20px 32px; max-width: 920px; }
  @container app (min-width: 900px) { .unit-form { padding: 0 32px 40px; } }

  .form-section { background: var(--cc-surface); border: 1px solid var(--cc-line); margin-bottom: 16px; }
  .form-section-hd { padding: 12px 16px; border-bottom: 1px solid var(--cc-line-soft); font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; font-weight: 600; color: var(--cc-ink); display: flex; justify-content: space-between; align-items: center; }
  .form-section-tag { font-family: var(--cc-font-mono); font-size: 9px; padding: 2px 6px; background: var(--cc-bg-alt); color: var(--cc-muted); letter-spacing: 0.15em; text-transform: none; font-weight: 400; }
  .form-section-body { padding: 16px; }
  .field-row { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
  .field-row:last-child { margin-bottom: 0; }
  .field-row .field { flex: 1; min-width: 180px; }
  .field { display: flex; flex-direction: column; }
  .req { color: var(--cc-danger); }
  .field-hint { font-size: 11px; color: var(--cc-muted); margin-top: 4px; line-height: 1.4; }
  .field-err { color: var(--cc-danger); font-size: 11px; margin-top: 4px; min-height: 14px; }
  .hidden { display: none !important; }

  .loss-select, .loss-notes { width: 100%; padding: 10px 12px; border: 1px solid var(--cc-line); background: var(--cc-bg); font-family: inherit; font-size: 13px; color: var(--cc-ink); }
  .loss-select:focus, .loss-notes:focus { outline: none; border-color: var(--cc-ink); }
  .loss-label { display: block; font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cc-muted); font-weight: 500; margin-bottom: 6px; }
  .loss-notes { resize: vertical; min-height: 70px; }
  .field-filled { background: var(--cc-ok-soft); border-color: var(--cc-ok); transition: all 0.4s; }

  /* OCR BANNER */
  .ocr-banner { background: linear-gradient(135deg, var(--cc-bg-alt), var(--cc-surface)); border-color: var(--cc-champagne); }
  .ocr-content { display: flex; align-items: center; gap: 16px; padding: 16px; }
  .ocr-icon { font-size: 32px; flex-shrink: 0; }
  .ocr-text { flex: 1; min-width: 0; }
  .ocr-title { font-family: var(--cc-font-display); font-weight: 400; font-size: 17px; margin-bottom: 4px; }
  .ocr-desc { font-size: 12px; color: var(--cc-muted); line-height: 1.5; }
  .ocr-actions { flex-shrink: 0; }
  @container app (max-width: 700px) { .ocr-content { flex-direction: column; align-items: stretch; text-align: center; } }

  /* MARGEN PREVIEW */
  .margin-preview { background: var(--cc-bg-alt); border: 1px solid var(--cc-line-soft); padding: 10px 14px; margin-top: 8px; }
  .margin-preview:empty { display: none; }
  .mp-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12px; }
  .mp-row span { color: var(--cc-muted); }
  .mp-row b { font-family: var(--cc-font-mono); }
  .mp-row b.ok { color: var(--cc-ok); }
  .mp-row b.danger { color: var(--cc-danger); }

  /* AUTO-PUBLISH */
  .ap-intro { font-size: 12px; color: var(--cc-muted); margin-bottom: 12px; padding: 10px 12px; background: var(--cc-bg-alt); border-left: 3px solid var(--cc-champagne); line-height: 1.5; }
  .ap-channels { display: flex; flex-direction: column; gap: 8px; }
  .ap-channel { display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; border: 1px solid var(--cc-line); cursor: pointer; transition: all 0.15s; background: var(--cc-bg); }
  .ap-channel:hover { border-color: var(--cc-ink); }
  .ap-channel:has(input:checked) { border-color: var(--cc-champagne); background: var(--cc-surface); border-width: 2px; }
  .ap-channel input { margin-top: 4px; flex-shrink: 0; }
  .ap-ch-icon { font-size: 22px; line-height: 1; flex-shrink: 0; }
  .ap-ch-info { display: flex; flex-direction: column; gap: 2px; }
  .ap-ch-info b { font-size: 13px; }
  .ap-ch-info small { font-size: 11px; color: var(--cc-muted); }
  .ap-hint { font-size: 11px; color: var(--cc-warn); margin-top: 12px; line-height: 1.4; }

  /* PHOTOS */
  .photos-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; margin-bottom: 14px; min-height: 80px; }
  .photos-empty { grid-column: 1 / -1; padding: 30px; text-align: center; color: var(--cc-muted); font-style: italic; font-size: 12px; background: var(--cc-bg-alt); border: 1px dashed var(--cc-line); }
  .photo-item { position: relative; aspect-ratio: 4/3; background: var(--cc-bg-alt); border: 1px solid var(--cc-line); cursor: pointer; overflow: hidden; }
  .photo-item.main { border-color: var(--cc-champagne); border-width: 2px; }
  .photo-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .photo-item:hover { border-color: var(--cc-ink); }
  .photo-badge { position: absolute; top: 6px; left: 6px; padding: 2px 6px; background: var(--cc-champagne); color: var(--cc-ink); font-family: var(--cc-font-mono); font-size: 8px; letter-spacing: 0.15em; font-weight: 700; }
  .photo-remove { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; background: rgba(17,17,17,0.8); color: white; border: none; cursor: pointer; font-size: 16px; line-height: 1; display: flex; align-items: center; justify-content: center; }
  .photo-remove:hover { background: var(--cc-danger); }
  .photos-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .photos-hint { font-size: 11px; color: var(--cc-muted); flex: 1; min-width: 200px; }
`;
