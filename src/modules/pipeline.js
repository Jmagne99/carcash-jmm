// ============================================================
// CARCASH · MÓDULO PIPELINE KANBAN
// Se registra en el router como: #/pipeline
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { state, isAdmin } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles, confirmDialog, debounce } from '../lib/dom.js';
import { navigate } from '../lib/router.js';
import { loadThresholds, levelForHours } from '../lib/contact-alerts.js';

// ============================================================
// CONFIGURACIÓN
// ============================================================
const STAGES = [
  { id: 'nuevo',        name: 'Nuevo',        num: '01' },
  { id: 'contactado',   name: 'Contactado',   num: '02' },
  { id: 'visita_test',  name: 'Visita/Test',  num: '03' },
  { id: 'presupuesto',  name: 'Presupuesto',  num: '04' },
  { id: 'negociacion',  name: 'Negociación',  num: '05' },
  { id: 'reserva',      name: 'Reserva',      num: '06' },
  { id: 'ganada',       name: 'Ganada',       num: '07' },
];

const ORIGIN_LABELS = {
  mercado_libre: 'ML',
  instagram: 'IG',
  meta_ads: 'META',
  whatsapp: 'WSP',
  web: 'WEB',
  walk_in: 'SHOW',
  referido: 'REF',
  google_ads: 'GADS',
  otro: 'OTRO',
};

// ============================================================
// TERMÓMETRO DE LEADS · temperatura por horas sin contacto
// ============================================================
const TEMP = {
  hot:     { label: 'Caliente',    dot: '🔥' },
  warm:    { label: 'Tibio',       dot: '🌤' },
  cooling: { label: 'Enfriándose', dot: '❄' },
  cold:    { label: 'Frío',        dot: '🧊' },
};
function leadTemp(opp) {
  // Las ganadas siempre "calientes" (cerradas ok); el resto, por contacto.
  if (opp.stage === 'ganada') return 'hot';
  const h = opp.hours_since_contact;
  const t = local.thresholds || {};
  const cold = t.cold ?? 96, danger = t.danger ?? 72, warn = t.warn ?? 24;
  if (h == null) return 'hot';
  if (h >= cold) return 'cold';
  if (h >= danger) return 'cooling';
  if (h >= warn) return 'warm';
  return 'hot';
}

// ============================================================
// ESTADO LOCAL DEL MÓDULO
// ============================================================
const local = {
  opportunities: [],
  sellers: [],
  thresholds: { warn: 24, warn2: 48, danger: 72 },
  filters: {
    seller: 'all',
    origin: 'all',
    search: '',
  },
  loading: false,
};

// ============================================================
// DATA FETCH
// ============================================================
async function fetchOpportunities() {
  local.loading = true;

  // Usar la vista con cálculo de horas sin contactar
  const { data, error } = await supabase
    .from('opportunities_with_contact_alerts')
    .select(`
      id, opp_code, stage, origin,
      ai_score, expected_amount,
      next_action_title, next_action_due_at, next_action_done,
      assigned_to, hours_since_contact, last_contact_at,
      contact:contacts(id, full_name),
      unit:units!unit_of_interest_id(id, brand, model, year)
    `)
    .order('created_at', { ascending: false });

  // Cargar umbrales en paralelo (cached)
  local.thresholds = await loadThresholds();

  local.loading = false;

  if (error) {
    toast('Error cargando pipeline', error.message, 'error');
    return [];
  }

  return data || [];
}

async function fetchSellers() {
  const { data, error } = await supabase
    .from('users_profile')
    .select('id, full_name, avatar_initials, role')
    .eq('active', true)
    .in('role', ['vendedor', 'gerente'])
    .order('full_name');

  if (error) {
    console.error('Error loading sellers:', error);
    return [];
  }
  return data || [];
}

async function updateStage(oppId, newStage, oldStage) {
  const { error } = await supabase
    .from('opportunities')
    .update({ stage: newStage })
    .eq('id', oppId);

  if (error) {
    toast('Error actualizando etapa', error.message, 'error');
    // Revertir en local
    const opp = local.opportunities.find(o => o.id === oppId);
    if (opp) opp.stage = oldStage;
    render();
    return false;
  }

  // El trigger de Supabase registra el cambio en timeline_events
  toast(`Movido a ${STAGES.find(s => s.id === newStage).name}`, null, 'ok');
  return true;
}

// ============================================================
// FILTROS
// ============================================================
function getFiltered() {
  return local.opportunities.filter(opp => {
    if (local.filters.seller !== 'all' && opp.assigned_to !== local.filters.seller) return false;
    if (local.filters.origin !== 'all' && opp.origin !== local.filters.origin) return false;
    if (local.filters.search) {
      const q = local.filters.search.toLowerCase();
      const name = opp.contact?.full_name?.toLowerCase() || '';
      const unit = [opp.unit?.brand, opp.unit?.model].filter(Boolean).join(' ').toLowerCase();
      const code = opp.opp_code.toLowerCase();
      if (!name.includes(q) && !unit.includes(q) && !code.includes(q)) return false;
    }
    return true;
  });
}

function isUrgent(opp) {
  if (!opp.next_action_due_at || opp.next_action_done) return false;
  return new Date(opp.next_action_due_at) < new Date();
}

// ============================================================
// RENDER
// ============================================================
export function render() {
  const view = $('#view');

  view.innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">MÓDULO 02 · COMERCIAL</div>
          <div class="page-title">Pipeline <i>comercial</i></div>
          <div class="page-sub" id="pipeline-meta-sub">Cargando…</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-ghost" id="btn-refresh">Actualizar</button>
          <button class="btn" id="btn-new-opp">+ Nueva oportunidad</button>
        </div>
      </div>
      <div class="filters" id="filters"></div>
    </div>

    <div class="kanban-meta" id="kanban-meta"></div>
    <div class="kanban" id="kanban"></div>
  `;

  renderFilters();
  renderKanban();
  attachHandlers();
}

function renderFilters() {
  const container = $('#filters');
  container.innerHTML = '';

  // Filtro por vendedor (solo visible si el user actual es admin)
  if (isAdmin() && local.sellers.length > 0) {
    const sellerGroup = el('div', { class: 'filter-group' });
    sellerGroup.appendChild(el('span', { class: 'filter-lbl' }, 'Vendedor'));

    const chips = el('div', { class: 'filter-chips', id: 'filter-seller' });
    chips.appendChild(chip('all', 'Todos', local.filters.seller === 'all'));
    local.sellers.forEach(s => {
      chips.appendChild(chip(s.id, s.full_name.split(' ')[0], local.filters.seller === s.id));
    });
    sellerGroup.appendChild(chips);
    container.appendChild(sellerGroup);
  }

  // Filtro por origen
  const originGroup = el('div', { class: 'filter-group' });
  originGroup.appendChild(el('span', { class: 'filter-lbl' }, 'Origen'));
  const originChips = el('div', { class: 'filter-chips', id: 'filter-origin' });
  originChips.appendChild(chip('all', 'Todos', local.filters.origin === 'all'));
  Object.entries(ORIGIN_LABELS).forEach(([key, label]) => {
    originChips.appendChild(chip(key, label, local.filters.origin === key));
  });
  originGroup.appendChild(originChips);
  container.appendChild(originGroup);

  container.appendChild(
    el('button', {
      class: 'filter-reset',
      onClick: () => {
        local.filters = { seller: 'all', origin: 'all', search: '' };
        render();
      }
    }, 'Limpiar')
  );
}

function chip(value, label, active) {
  return el('div', {
    class: 'filter-chip' + (active ? ' active' : ''),
    dataset: { value },
  }, label);
}

function renderKanban() {
  const filtered = getFiltered();
  const kanban = $('#kanban');
  kanban.innerHTML = '';

  STAGES.forEach(stage => {
    const stageOpps = filtered.filter(o => o.stage === stage.id);
    const total = stageOpps.reduce((sum, o) => sum + (o.expected_amount || 0), 0);

    const col = el('div', { class: 'stage', dataset: { stage: stage.id } });

    // Header
    col.appendChild(
      el('div', { class: 'stage-hd' },
        el('div', { class: 'stage-hd-row' },
          el('div', { class: 'stage-name' }, stage.name),
          el('div', { class: 'stage-count' }, String(stageOpps.length).padStart(2, '0'))
        ),
        el('div', { class: 'stage-amount' }, total > 0 ? `USD ${fmt.usd(total)}` : '—')
      )
    );

    // Body
    const body = el('div', { class: 'stage-body', dataset: { stage: stage.id } });
    if (stageOpps.length === 0) {
      body.appendChild(el('div', { class: 'empty-state' }, 'Sin oportunidades'));
    } else {
      stageOpps.forEach(opp => body.appendChild(renderCard(opp)));
    }
    col.appendChild(body);

    kanban.appendChild(col);
  });

  // Meta
  const totalValue = filtered.reduce((sum, o) => sum + (o.expected_amount || 0), 0);
  const avg = filtered.length > 0 ? totalValue / filtered.length : 0;
  $('#kanban-meta').innerHTML = `
    <div><b>${filtered.length}</b> DE ${local.opportunities.length} OPORTUNIDADES</div>
    <div class="sum">
      <div>PIPELINE TOTAL: <b>USD ${fmt.usd(totalValue)}</b></div>
      <div>TICKET PROM.: <b>USD ${fmt.usd(avg)}</b></div>
    </div>
    <div class="temp-legend" title="Temperatura del lead según hace cuánto que no se lo contacta">
      <span class="tl hot"><i></i>Caliente</span>
      <span class="tl warm"><i></i>Tibio</span>
      <span class="tl cooling"><i></i>Enfriándose</span>
      <span class="tl cold"><i></i>Frío</span>
    </div>
  `;

  // Sub de página
  const urgentCount = filtered.filter(isUrgent).length;
  $('#pipeline-meta-sub').innerHTML = `
    ABRIL 2026 · <b>${filtered.length} OPORTUNIDADES ACTIVAS</b>${urgentCount > 0 ? ` · ${urgentCount} REQUIEREN ACCIÓN URGENTE` : ''}
  `;

  enableDragDrop();
}

function renderCard(opp) {
  const urgent = isUrgent(opp);
  const contactLevel = levelForHours(opp.hours_since_contact, local.thresholds);
  const temp = leadTemp(opp);
  const card = el('div', {
    class: 'card temp-' + temp + (urgent ? ' urgent' : '') + (contactLevel !== 'ok' ? ' contact-' + contactLevel : ''),
    draggable: 'true',
    dataset: { oppId: opp.id },
  });

  const scoreClass = opp.ai_score >= 85 ? 'hot' : (opp.ai_score < 60 ? 'cold' : '');

  const unitName = opp.unit
    ? `${opp.unit.brand || ''} ${opp.unit.model || ''}${opp.unit.year ? ' \'' + String(opp.unit.year).slice(2) : ''}`.trim()
    : 'Sin unidad asignada';

  // Badge de horas sin contactar
  const hours = Math.floor(opp.hours_since_contact || 0);
  let contactBadge = '';
  if (contactLevel !== 'ok') {
    const display = hours >= 24 ? `${Math.floor(hours / 24)}d` : `${hours}h`;
    contactBadge = `<div class="card-contact-badge level-${contactLevel}" title="${hours}h sin contactar">⏱ ${display}</div>`;
  }

  card.innerHTML = `
    <div class="card-top">
      <div class="card-name">${escapeHtml(opp.contact?.full_name || 'Sin nombre')}</div>
      <div class="card-score ${scoreClass}">${opp.ai_score ?? '—'}</div>
    </div>
    <div class="card-unit">${escapeHtml(unitName)}</div>
    <div class="card-temp temp-${temp}"><span class="ct-bar"></span>${TEMP[temp].label}${hours ? ` · ${hours >= 24 ? Math.floor(hours / 24) + 'd' : hours + 'h'}` : ''}</div>
    <div class="card-bottom">
      <div class="card-next ${urgent ? 'urgent' : ''}">${urgent ? '● ' : ''}${escapeHtml(opp.next_action_title || '—')}</div>
      <div class="card-origin">${ORIGIN_LABELS[opp.origin] || opp.origin}</div>
    </div>
    <div class="card-value">${opp.opp_code} · <b>USD ${fmt.usd(opp.expected_amount || 0)}</b>${contactBadge}</div>
  `;

  card.addEventListener('click', (e) => {
    if (!card.classList.contains('dragging')) {
      navigate(`/pipeline/${opp.opp_code.toLowerCase()}`);
    }
  });

  return card;
}

// ============================================================
// DRAG & DROP
// ============================================================
let draggedCard = null;

function enableDragDrop() {
  $$('.card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      draggedCard = card;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      $$('.stage-body').forEach(b => b.classList.remove('dropzone-active'));
      draggedCard = null;
    });
  });

  $$('.stage-body').forEach(body => {
    body.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      body.classList.add('dropzone-active');
    });

    body.addEventListener('dragleave', (e) => {
      if (!body.contains(e.relatedTarget)) {
        body.classList.remove('dropzone-active');
      }
    });

    body.addEventListener('drop', async (e) => {
      e.preventDefault();
      body.classList.remove('dropzone-active');
      if (!draggedCard) return;

      const oppId = draggedCard.dataset.oppId;
      const newStage = body.dataset.stage;
      const opp = local.opportunities.find(o => o.id === oppId);
      if (!opp || opp.stage === newStage) return;

      // Confirmación si pasa a ganada
      if (newStage === 'ganada') {
        const ok = await confirmDialog(
          '¿Marcar esta oportunidad como GANADA? Esto generará la venta y pedirá completar datos de cierre.',
          { okText: 'Marcar ganada' }
        );
        if (!ok) return;
      }
      if (newStage === 'perdida') {
        const reason = await promptLossReason();
        if (!reason) return;
        const oldStage = opp.stage;
        opp.stage = newStage;
        renderKanban();
        await updateStageWithLoss(oppId, newStage, oldStage, reason);
        return;
      }

      const oldStage = opp.stage;
      opp.stage = newStage;
      renderKanban(); // UI optimista
      await updateStage(oppId, newStage, oldStage);
    });
  });
}

// ============================================================
// MODAL DE MOTIVO DE PÉRDIDA
// ============================================================
const LOSS_REASONS = [
  { id: 'precio',                 label: 'Precio' },
  { id: 'no_respondio',           label: 'No respondió' },
  { id: 'compro_en_competencia',  label: 'Compró en competencia' },
  { id: 'no_califica_credito',    label: 'No califica crédito' },
  { id: 'cambio_de_planes',       label: 'Cambió de planes' },
  { id: 'producto_no_disponible', label: 'Producto no disponible' },
  { id: 'otro',                   label: 'Otro' },
];

function promptLossReason() {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const modal = el('div', { class: 'modal' });

    const reasonSelect = el('select', { id: 'loss-reason', class: 'loss-select' },
      el('option', { value: '' }, 'Seleccionar motivo…'),
      ...LOSS_REASONS.map(r => el('option', { value: r.id }, r.label))
    );

    const notesArea = el('textarea', {
      id: 'loss-notes',
      placeholder: 'Notas adicionales (opcional)',
      rows: '3',
      class: 'loss-notes',
    });

    modal.appendChild(el('div', { class: 'modal-hd' },
      el('h3', {}, 'Marcar como perdida'),
      el('button', { class: 'modal-close', onClick: () => close(null) }, '×')
    ));
    modal.appendChild(el('div', { class: 'modal-body' },
      el('label', { class: 'loss-label' }, 'Motivo'),
      reasonSelect,
      el('label', { class: 'loss-label', style: { marginTop: '12px' } }, 'Notas'),
      notesArea
    ));
    modal.appendChild(el('div', { class: 'modal-actions' },
      el('button', { class: 'btn btn-ghost', onClick: () => close(null) }, 'Cancelar'),
      el('button', {
        class: 'btn btn-danger',
        onClick: () => {
          const reason = reasonSelect.value;
          if (!reason) {
            reasonSelect.style.borderColor = 'var(--cc-danger)';
            return;
          }
          close({ reason, notes: notesArea.value.trim() });
        }
      }, 'Marcar perdida'),
    ));

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    function close(value) {
      backdrop.remove();
      resolve(value);
    }
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });
  });
}

async function updateStageWithLoss(oppId, newStage, oldStage, lossInfo) {
  const { error } = await supabase
    .from('opportunities')
    .update({
      stage: newStage,
      loss_reason: lossInfo.reason,
      loss_notes: lossInfo.notes || null,
    })
    .eq('id', oppId);

  if (error) {
    toast('Error actualizando etapa', error.message, 'error');
    const opp = local.opportunities.find(o => o.id === oppId);
    if (opp) opp.stage = oldStage;
    renderKanban();
    return false;
  }

  toast('Movido a Perdida', LOSS_REASONS.find(r => r.id === lossInfo.reason)?.label, 'warn');
  return true;
}

// ============================================================
// HANDLERS
// ============================================================
let searchHandler = null;

function attachHandlers() {
  // Filtros
  $('#filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;

    const parent = chip.parentElement;
    const value = chip.dataset.value;

    if (parent.id === 'filter-seller') {
      local.filters.seller = value;
    } else if (parent.id === 'filter-origin') {
      local.filters.origin = value;
    }

    parent.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');

    renderKanban();
  });

  // Refresh
  $('#btn-refresh').addEventListener('click', () => mount());

  // Nueva oportunidad
  $('#btn-new-opp').addEventListener('click', () => {
    navigate('/pipeline/nueva');
  });

  // Búsqueda integrada con el topbar #search
  const searchInput = $('#search');
  if (searchInput) {
    if (searchHandler) searchInput.removeEventListener('input', searchHandler);
    searchHandler = debounce((e) => {
      local.filters.search = e.target.value.trim();
      renderKanban();
    }, 200);
    searchInput.addEventListener('input', searchHandler);
    searchInput.value = local.filters.search || '';
  }
}

// ============================================================
// MOUNT (se llama desde el router)
// ============================================================
export async function mount(_params = {}) {
  render(); // render inicial con loading

  [local.opportunities, local.sellers] = await Promise.all([
    fetchOpportunities(),
    fetchSellers(),
  ]);

  renderFilters();
  renderKanban();
}

export default mount;

// ============================================================
// CSS DEL MÓDULO
// Inyectar una sola vez al cargar
// ============================================================
const styles = `
  .page-hd { padding: 22px 20px 16px; border-bottom: 1px solid var(--cc-line); }
  @container app (min-width: 900px) { .page-hd { padding: 28px 32px 20px; } }
  .page-hd-top { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; flex-wrap: wrap; margin-bottom: 16px; }
  .page-num { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.22em; color: var(--cc-champagne); font-weight: 600; margin-bottom: 4px; }
  .page-title { font-family: var(--cc-font-display); font-weight: 300; font-size: 30px; letter-spacing: -0.025em; line-height: 1; }
  @container app (min-width: 700px) { .page-title { font-size: 36px; } }
  .page-title i { font-style: italic; font-weight: 500; }
  .page-sub { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.12em; color: var(--cc-muted); margin-top: 6px; }
  .page-sub b { color: var(--cc-ink); font-weight: 600; }
  .page-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .filter-group { display: flex; align-items: center; gap: 6px; }
  .filter-lbl { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--cc-muted); font-weight: 500; }
  .filter-chips { display: flex; gap: 2px; border: 1px solid var(--cc-line); background: var(--cc-surface); }
  .filter-chip { padding: 6px 12px; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--cc-muted); cursor: pointer; font-weight: 500; border-right: 1px solid var(--cc-line); }
  .filter-chip:last-child { border-right: none; }
  .filter-chip.active { background: var(--cc-ink); color: var(--cc-bg); }
  .filter-reset { font-size: 10px; color: var(--cc-muted); cursor: pointer; letter-spacing: 0.1em; text-transform: uppercase; padding: 6px 10px; border: none; background: transparent; font-family: inherit; }
  .filter-reset:hover { color: var(--cc-ink); }
  .kanban-meta { padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; background: var(--cc-bg-alt); border-bottom: 1px solid var(--cc-line); font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.12em; color: var(--cc-muted); text-transform: uppercase; flex-wrap: wrap; gap: 10px; }
  @container app (min-width: 900px) { .kanban-meta { padding: 12px 32px; } }
  .kanban-meta b { color: var(--cc-ink); font-weight: 600; }
  .kanban-meta .sum { display: flex; gap: 18px; }
  .kanban { display: grid; grid-template-columns: repeat(7, 300px); gap: 1px; background: var(--cc-line); overflow-x: auto; overflow-y: hidden; }
  .stage { background: var(--cc-bg-alt); display: flex; flex-direction: column; min-height: calc(100vh - 280px); overflow: hidden; }
  .stage-hd { padding: 12px 14px; border-bottom: 1px solid var(--cc-line); position: sticky; top: 0; background: var(--cc-bg-alt); z-index: 2; }
  .stage-hd-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .stage-name { font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; font-weight: 600; color: var(--cc-ink); }
  .stage-count { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); background: var(--cc-surface); padding: 2px 7px; border: 1px solid var(--cc-line); font-weight: 600; }
  .stage-amount { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); letter-spacing: 0.05em; }
  .stage[data-stage="ganada"] .stage-hd { border-top: 2px solid var(--cc-ok); }
  .stage[data-stage="reserva"] .stage-hd { border-top: 2px solid var(--cc-champagne); }
  .stage-body { flex: 1; padding: 10px; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; gap: 8px; min-height: 100px; }
  .stage-body::-webkit-scrollbar { width: 4px; }
  .stage-body::-webkit-scrollbar-thumb { background: var(--cc-line); }
  .stage-body.dropzone-active { background: #E8F0EA; outline: 2px dashed var(--cc-ok); outline-offset: -2px; }
  .card { background: var(--cc-surface); border: 1px solid var(--cc-line); padding: 12px; cursor: grab; transition: all .15s ease; user-select: none; }
  .card:hover { border-color: var(--cc-ink); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.04); }
  .card:active, .card.dragging { cursor: grabbing; opacity: 0.5; }
  .card.urgent { border-left: 3px solid var(--cc-danger); }
  .card.contact-warn { border-left: 3px solid var(--cc-warn); }
  .card.contact-warn2 { border-left: 3px solid #FF8C42; }
  .card.contact-danger { border-left: 3px solid var(--cc-danger); background: linear-gradient(90deg, var(--cc-danger-soft) 0%, var(--cc-surface) 12%); }
  .card-contact-badge { display: inline-block; float: right; padding: 1px 6px; font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.05em; font-weight: 700; }
  .card-contact-badge.level-warn { background: var(--cc-warn-soft); color: var(--cc-warn); border: 1px solid var(--cc-warn); }
  .card-contact-badge.level-warn2 { background: #fff0e5; color: #FF8C42; border: 1px solid #FF8C42; }
  .card-contact-badge.level-danger { background: var(--cc-danger-soft); color: var(--cc-danger); border: 1px solid var(--cc-danger); }

  /* TERMÓMETRO DE LEADS (color por temperatura) */
  .card.temp-hot     { border-left: 4px solid #2F6B3E; }
  .card.temp-warm    { border-left: 4px solid #C99A2E; }
  .card.temp-cooling { border-left: 4px solid #E07B39; }
  .card.temp-cold    { border-left: 4px solid #E3050C; background: linear-gradient(90deg, var(--cc-danger-soft) 0%, var(--cc-surface) 14%); }
  .card-temp { display: inline-flex; align-items: center; gap: 5px; margin: 6px 0 2px; font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; }
  .card-temp .ct-bar { width: 22px; height: 5px; border-radius: 3px; display: inline-block; }
  .card-temp.temp-hot     { color: #2F6B3E; }  .card-temp.temp-hot .ct-bar     { background: #2F6B3E; }
  .card-temp.temp-warm    { color: #C99A2E; }  .card-temp.temp-warm .ct-bar    { background: #C99A2E; }
  .card-temp.temp-cooling { color: #E07B39; }  .card-temp.temp-cooling .ct-bar { background: #E07B39; }
  .card-temp.temp-cold    { color: #E3050C; }  .card-temp.temp-cold .ct-bar    { background: #E3050C; }

  /* Leyenda del termómetro */
  .temp-legend { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
  .temp-legend .tl { display: inline-flex; align-items: center; gap: 5px; font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--cc-muted); }
  .temp-legend .tl i { width: 14px; height: 5px; border-radius: 3px; display: inline-block; }
  .temp-legend .tl.hot i { background: #2F6B3E; }
  .temp-legend .tl.warm i { background: #C99A2E; }
  .temp-legend .tl.cooling i { background: #E07B39; }
  .temp-legend .tl.cold i { background: #E3050C; }
  .card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 4px; }
  .card-name { font-size: 13px; font-weight: 500; line-height: 1.25; min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-score { font-family: var(--cc-font-mono); font-size: 10px; font-weight: 600; padding: 2px 6px; background: var(--cc-bg-alt); border: 1px solid var(--cc-line); flex-shrink: 0; }
  .card-score.hot { background: var(--cc-ink); color: var(--cc-bg); border-color: var(--cc-ink); }
  .card-score.cold { color: var(--cc-muted); }
  .card-unit { font-family: var(--cc-font-display); font-style: italic; font-size: 11px; color: var(--cc-muted); margin-bottom: 8px; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-bottom { display: flex; justify-content: space-between; align-items: center; padding-top: 8px; border-top: 1px solid var(--cc-line-soft); gap: 6px; }
  .card-next { font-family: var(--cc-font-mono); font-size: 9px; color: var(--cc-muted); letter-spacing: 0.05em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .card-next.urgent { color: var(--cc-danger); font-weight: 600; }
  .card-origin { font-size: 8px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cc-muted); font-weight: 600; flex-shrink: 0; }
  .card-value { font-family: var(--cc-font-mono); font-size: 10px; color: var(--cc-muted); margin-top: 4px; letter-spacing: 0.03em; }
  .card-value b { color: var(--cc-ink); font-weight: 500; }
  .empty-state { padding: 20px 10px; text-align: center; font-family: var(--cc-font-mono); font-size: 9px; color: var(--cc-muted); letter-spacing: 0.15em; text-transform: uppercase; opacity: 0.6; }
  .loss-label { display: block; font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cc-muted); font-weight: 500; margin-bottom: 6px; }
  .loss-select, .loss-notes { width: 100%; padding: 10px 12px; border: 1px solid var(--cc-line); background: var(--cc-bg); font-family: inherit; font-size: 13px; color: var(--cc-ink); }
  .loss-select:focus, .loss-notes:focus { outline: none; border-color: var(--cc-ink); }
  .loss-notes { resize: vertical; min-height: 60px; }
  .stage[data-stage="perdida"] .stage-hd { border-top: 2px solid var(--cc-muted); }
`;

injectStyles('pipeline-styles', styles);
