// ============================================================
// CARCASH · MÓDULO CONFIGURACIÓN
// Solo para roles dueno / gerente.
// Ruta: /configuracion
// Edita la tabla `settings` (key/value JSON):
//   - business: nombre, CUIT, dirección, contacto
//   - targets: objetivos comerciales
//   - alerts_rules: reglas del motor de alertas
//   - ai: configuración de Claude
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { state, isAdmin, currentUserId } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles } from '../lib/dom.js';

const local = {
  settings: {},  // { business: {...}, targets: {...}, alerts_rules: {...}, ai: {...} }
  activeTab: 'business',
};

// ============================================================
// MOUNT
// ============================================================
export async function mount() {
  injectStyles('configuracion-styles', styles);

  if (!isAdmin()) {
    $('#view').innerHTML = `
      <div class="placeholder">
        <div class="placeholder-content">
          <div class="placeholder-num">×</div>
          <div class="placeholder-title">Acceso <i>restringido</i></div>
          <div class="placeholder-desc">Esta sección es solo para dueño / gerente.</div>
          <div class="placeholder-status">NO AUTORIZADO</div>
        </div>
      </div>
    `;
    return;
  }

  render();
  await loadSettings();
  renderActiveTab();
}

export default mount;

// ============================================================
// FETCH
// ============================================================
async function loadSettings() {
  const { data, error } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', ['business', 'targets', 'alerts_rules', 'ai']);
  if (error) {
    toast('Error cargando configuración', error.message, 'error');
    return;
  }
  local.settings = {};
  (data || []).forEach(row => {
    local.settings[row.key] = row.value || {};
  });
}

async function saveSettings(key, value) {
  const { error } = await supabase
    .from('settings')
    .upsert({
      key,
      value,
      updated_at: new Date().toISOString(),
      updated_by: currentUserId(),
    }, { onConflict: 'key' });
  if (error) {
    toast('Error guardando', error.message, 'error');
    return false;
  }
  local.settings[key] = value;
  return true;
}

// ============================================================
// RENDER
// ============================================================
function render() {
  const view = $('#view');
  view.innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">MÓDULO 14 · DIRECCIÓN</div>
          <div class="page-title">Configuración del <i>sistema</i></div>
          <div class="page-sub">Datos del negocio · objetivos · reglas de alertas · IA</div>
        </div>
      </div>
      <div class="cfg-tabs" id="cfg-tabs">
        ${tab('business', 'Datos del negocio')}
        ${tab('targets', 'Objetivos')}
        ${tab('alerts_rules', 'Alertas')}
        ${tab('ai', 'Inteligencia artificial')}
      </div>
    </div>
    <div class="cfg-body" id="cfg-body">
      <div class="empty">Cargando…</div>
    </div>
  `;
  $('#cfg-tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.cfg-tab');
    if (!t) return;
    local.activeTab = t.dataset.tab;
    $$('.cfg-tab').forEach(x => x.classList.toggle('active', x === t));
    renderActiveTab();
  });
}

function tab(id, label) {
  return `<div class="cfg-tab ${id === local.activeTab ? 'active' : ''}" data-tab="${id}">${escapeHtml(label)}</div>`;
}

function renderActiveTab() {
  const body = $('#cfg-body');
  const renderers = {
    business: renderBusinessForm,
    targets: renderTargetsForm,
    alerts_rules: renderAlertsForm,
    ai: renderAIForm,
  };
  body.innerHTML = '';
  body.appendChild(renderers[local.activeTab]());
}

// ============================================================
// FORM: DATOS DEL NEGOCIO
// ============================================================
function renderBusinessForm() {
  const data = local.settings.business || {};
  const form = el('div', { class: 'cfg-form' });

  form.appendChild(el('div', { class: 'cfg-section' },
    el('div', { class: 'cfg-section-hd' }, 'Identificación'),
    el('div', { class: 'cfg-section-body' },
      field('Nombre comercial', input('cfg-name', data.name || '')),
      el('div', { class: 'field-row' },
        field('Razón social', input('cfg-legal-name', data.legal_name || '')),
        field('CUIT', input('cfg-cuit', data.cuit || '')),
      ),
      field('Dirección', input('cfg-address', data.address || '')),
      el('div', { class: 'field-row' },
        field('Teléfono', input('cfg-phone', data.phone || '')),
        field('Email de contacto', input('cfg-email', data.email || '', 'email')),
      ),
      el('div', { class: 'cfg-hint' }, 'Estos datos aparecen en la landing pública de cada unidad y en los mensajes de WhatsApp/Email.'),
    ),
  ));

  form.appendChild(saveBar('business', () => ({
    name: $('#cfg-name').value.trim(),
    legal_name: $('#cfg-legal-name').value.trim(),
    cuit: $('#cfg-cuit').value.trim(),
    address: $('#cfg-address').value.trim(),
    phone: $('#cfg-phone').value.trim(),
    email: $('#cfg-email').value.trim(),
  })));

  return form;
}

// ============================================================
// FORM: OBJETIVOS
// ============================================================
function renderTargetsForm() {
  const data = local.settings.targets || {};
  const form = el('div', { class: 'cfg-form' });

  form.appendChild(el('div', { class: 'cfg-section' },
    el('div', { class: 'cfg-section-hd' }, 'Objetivos mensuales globales'),
    el('div', { class: 'cfg-section-body' },
      el('div', { class: 'field-row' },
        field('Ventas / mes (cantidad)', input('cfg-monthly-sales', data.monthly_sales || 40, 'number')),
        field('Ingresos / mes (USD)', input('cfg-monthly-revenue', data.monthly_revenue_usd || 6000000, 'number')),
      ),
      el('div', { class: 'field-row' },
        field('Margen objetivo (%)', input('cfg-target-margin', data.target_margin_pct || 12, 'number', { step: '0.5' })),
        field('Ticket promedio (USD)', input('cfg-avg-ticket', data.avg_ticket_usd || 150000, 'number')),
      ),
      el('div', { class: 'cfg-hint' }, 'Los objetivos individuales por vendedor se editan desde el módulo Equipo.'),
    ),
  ));

  form.appendChild(saveBar('targets', () => ({
    monthly_sales: parseInt($('#cfg-monthly-sales').value, 10) || 0,
    monthly_revenue_usd: parseInt($('#cfg-monthly-revenue').value, 10) || 0,
    target_margin_pct: parseFloat($('#cfg-target-margin').value) || 0,
    avg_ticket_usd: parseInt($('#cfg-avg-ticket').value, 10) || 0,
  })));

  return form;
}

// ============================================================
// FORM: REGLAS DE ALERTAS
// ============================================================
function renderAlertsForm() {
  const data = local.settings.alerts_rules || {};
  const form = el('div', { class: 'cfg-form' });

  form.appendChild(el('div', { class: 'cfg-section' },
    el('div', { class: 'cfg-section-hd' }, 'Motor de alertas'),
    el('div', { class: 'cfg-section-body' },
      el('div', { class: 'cfg-rule' },
        el('div', { class: 'cfg-rule-info' },
          el('div', { class: 'cfg-rule-title' }, 'Lead nuevo sin contactar'),
          el('div', { class: 'cfg-rule-desc' }, 'Se dispara una alerta si pasaron X minutos desde que entró el lead y nadie le respondió.'),
        ),
        el('div', { class: 'cfg-rule-input' },
          input('cfg-lead-no-contact', data.lead_no_contact_minutes || 30, 'number'),
          el('span', { class: 'cfg-unit' }, 'minutos'),
        ),
      ),
      el('div', { class: 'cfg-rule' },
        el('div', { class: 'cfg-rule-info' },
          el('div', { class: 'cfg-rule-title' }, 'Oportunidad estancada'),
          el('div', { class: 'cfg-rule-desc' }, 'Marca como "stale" oportunidades sin actividad en este período.'),
        ),
        el('div', { class: 'cfg-rule-input' },
          input('cfg-opp-stale', data.opportunity_stale_days || 5, 'number'),
          el('span', { class: 'cfg-unit' }, 'días'),
        ),
      ),
      el('div', { class: 'cfg-rule' },
        el('div', { class: 'cfg-rule-info' },
          el('div', { class: 'cfg-rule-title' }, 'Presupuesto sin respuesta'),
          el('div', { class: 'cfg-rule-desc' }, 'Cuando se envió un presupuesto y el cliente no respondió en X horas.'),
        ),
        el('div', { class: 'cfg-rule-input' },
          input('cfg-prop-no-response', data.proposal_no_response_hours || 48, 'number'),
          el('span', { class: 'cfg-unit' }, 'horas'),
        ),
      ),
      el('div', { class: 'cfg-rule' },
        el('div', { class: 'cfg-rule-info' },
          el('div', { class: 'cfg-rule-title' }, 'Stock antiguo'),
          el('div', { class: 'cfg-rule-desc' }, 'Unidades disponibles que llevan más de X días sin venderse.'),
        ),
        el('div', { class: 'cfg-rule-input' },
          input('cfg-stock-stale', data.stock_stale_days || 30, 'number'),
          el('span', { class: 'cfg-unit' }, 'días'),
        ),
      ),
      el('div', { class: 'cfg-section-subhd', style: { marginTop: '20px', paddingTop: '16px', borderTop: '1px solid var(--cc-line)', fontWeight: 600, fontSize: '12px', letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--cc-champagne)' } }, 'Alertas de seguimiento al cliente'),
      el('div', { class: 'cfg-rule' },
        el('div', { class: 'cfg-rule-info' },
          el('div', { class: 'cfg-rule-title' }, '🟡 Sin contacto reciente'),
          el('div', { class: 'cfg-rule-desc' }, 'Primer flag amarillo cuando pasa este tiempo sin contactar al cliente.'),
        ),
        el('div', { class: 'cfg-rule-input' },
          input('cfg-contact-warn', data.contact_alert_hours_warn || 24, 'number'),
          el('span', { class: 'cfg-unit' }, 'horas'),
        ),
      ),
      el('div', { class: 'cfg-rule' },
        el('div', { class: 'cfg-rule-info' },
          el('div', { class: 'cfg-rule-title' }, '🟠 Sin contacto · alerta media'),
          el('div', { class: 'cfg-rule-desc' }, 'Segundo nivel de alerta — flag naranja, requiere atención prioritaria.'),
        ),
        el('div', { class: 'cfg-rule-input' },
          input('cfg-contact-warn2', data.contact_alert_hours_warn2 || 48, 'number'),
          el('span', { class: 'cfg-unit' }, 'horas'),
        ),
      ),
      el('div', { class: 'cfg-rule' },
        el('div', { class: 'cfg-rule-info' },
          el('div', { class: 'cfg-rule-title' }, '🔴 Sin contacto · CRÍTICO'),
          el('div', { class: 'cfg-rule-desc' }, 'Genera notificación al vendedor + bandera roja. La oportunidad se está enfriando.'),
        ),
        el('div', { class: 'cfg-rule-input' },
          input('cfg-contact-danger', data.contact_alert_hours_danger || 72, 'horas'),
          el('span', { class: 'cfg-unit' }, 'horas'),
        ),
      ),
      el('div', { class: 'cfg-hint' }, 'El motor de alertas corre cada 5 minutos como Edge Function programada (`netlify/functions/alerts-engine.js`). Las alertas de seguimiento aparecen en el Tablero del día y como badges en el Pipeline kanban.'),
    ),
  ));

  form.appendChild(saveBar('alerts_rules', () => ({
    lead_no_contact_minutes: parseInt($('#cfg-lead-no-contact').value, 10) || 30,
    opportunity_stale_days: parseInt($('#cfg-opp-stale').value, 10) || 5,
    proposal_no_response_hours: parseInt($('#cfg-prop-no-response').value, 10) || 48,
    stock_stale_days: parseInt($('#cfg-stock-stale').value, 10) || 30,
    contact_alert_hours_warn: parseInt($('#cfg-contact-warn').value, 10) || 24,
    contact_alert_hours_warn2: parseInt($('#cfg-contact-warn2').value, 10) || 48,
    contact_alert_hours_danger: parseInt($('#cfg-contact-danger').value, 10) || 72,
  })));

  return form;
}

// ============================================================
// FORM: IA
// ============================================================
function renderAIForm() {
  const data = local.settings.ai || {};
  const form = el('div', { class: 'cfg-form' });

  form.appendChild(el('div', { class: 'cfg-section' },
    el('div', { class: 'cfg-section-hd' }, 'Modelo'),
    el('div', { class: 'cfg-section-body' },
      field('Modelo de Claude', el('select', { id: 'cfg-ai-model', class: 'loss-select' },
        ...['claude-opus-4-7', 'claude-sonnet-4-7', 'claude-haiku-4-5'].map(m =>
          el('option', { value: m, selected: m === (data.model || 'claude-opus-4-7') }, m)
        )
      )),
      el('div', { class: 'cfg-hint' }, 'Cambiar el modelo afecta calidad y costo. Opus es el más capaz, Haiku el más rápido y barato.'),
    ),
  ));

  form.appendChild(el('div', { class: 'cfg-section' },
    el('div', { class: 'cfg-section-hd' }, 'Funcionalidades'),
    el('div', { class: 'cfg-section-body' },
      cbRow('cfg-ai-scoring', 'Score automático de oportunidades', data.scoring_enabled !== false,
        'Claude analiza cada oportunidad nueva y le asigna un score 0-100 + lista de "a favor" / "riesgos".'),
      cbRow('cfg-ai-summary', 'Resumen automático de mensajes y llamadas', data.auto_summary_enabled !== false,
        'Claude resume hilos largos y transcribe llamadas para mostrarlos compactos en la timeline.'),
      cbRow('cfg-ai-suggest', 'Sugerencias de respuesta', data.suggest_responses_enabled !== false,
        'Botón "Sugerir respuesta" en el composer (Bandeja y Ficha 360) para que Claude redacte.'),
    ),
  ));

  form.appendChild(el('div', { class: 'cfg-warning' },
    el('b', {}, '⚠ Para que la IA funcione,'),
    ' necesitás configurar la variable de entorno ',
    el('code', {}, 'ANTHROPIC_API_KEY'),
    ' en Netlify (Site settings → Environment variables) y deployar las Edge Functions.',
  ));

  form.appendChild(saveBar('ai', () => ({
    model: $('#cfg-ai-model').value,
    scoring_enabled: $('#cfg-ai-scoring').checked,
    auto_summary_enabled: $('#cfg-ai-summary').checked,
    suggest_responses_enabled: $('#cfg-ai-suggest').checked,
  })));

  return form;
}

// ============================================================
// HELPERS
// ============================================================
function field(label, input) {
  return el('div', { class: 'field' },
    el('label', { class: 'loss-label' }, label),
    input,
  );
}

function input(id, value, type = 'text', extra = {}) {
  return el('input', {
    type, id,
    class: 'loss-select',
    value: value !== undefined && value !== null ? String(value) : '',
    ...extra,
  });
}

function cbRow(id, label, checked, desc) {
  return el('div', { class: 'cb-row' },
    el('label', { class: 'cb-label' },
      el('input', { type: 'checkbox', id, checked }),
      el('div', { class: 'cb-text' },
        el('span', { class: 'cb-title' }, label),
        el('span', { class: 'cb-desc' }, desc)
      )
    )
  );
}

function saveBar(key, gather) {
  return el('div', { class: 'cfg-save-bar' },
    el('button', {
      class: 'btn',
      onClick: async () => {
        const value = gather();
        const ok = await saveSettings(key, value);
        if (ok) toast('Configuración guardada', null, 'ok');
      }
    }, 'Guardar cambios'),
  );
}

// ============================================================
// STYLES
// ============================================================
const styles = `
  .cfg-tabs { display: flex; gap: 0; flex-wrap: wrap; margin-top: 16px; border-bottom: 1px solid var(--cc-line); margin-bottom: -1px; }
  .cfg-tab { padding: 10px 16px; font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--cc-muted); cursor: pointer; border-bottom: 2px solid transparent; font-weight: 500; }
  .cfg-tab:hover { color: var(--cc-ink); }
  .cfg-tab.active { color: var(--cc-ink); border-bottom-color: var(--cc-champagne); font-weight: 600; }

  .cfg-body { padding: 24px 20px 40px; max-width: 800px; }
  @container app (min-width: 900px) { .cfg-body { padding: 28px 32px 48px; } }
  .cfg-form { display: flex; flex-direction: column; gap: 16px; }
  .cfg-section { background: var(--cc-surface); border: 1px solid var(--cc-line); }
  .cfg-section-hd { padding: 12px 16px; border-bottom: 1px solid var(--cc-line-soft); font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; font-weight: 600; }
  .cfg-section-body { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
  .cfg-hint { font-size: 11px; color: var(--cc-muted); margin-top: 6px; line-height: 1.5; padding: 8px 12px; background: var(--cc-bg-alt); border-left: 2px solid var(--cc-champagne); }
  .cfg-warning { font-size: 11px; padding: 12px 14px; background: var(--cc-warn-soft); border: 1px solid var(--cc-warn); color: var(--cc-warn); line-height: 1.5; }
  .cfg-warning code { background: var(--cc-bg); padding: 2px 6px; font-family: var(--cc-font-mono); font-size: 11px; color: var(--cc-ink); border-radius: 2px; }

  .cfg-rule { display: flex; gap: 14px; align-items: flex-start; padding: 12px 0; border-bottom: 1px solid var(--cc-line-soft); }
  .cfg-rule:first-child { padding-top: 0; }
  .cfg-rule:last-child { border-bottom: none; padding-bottom: 0; }
  .cfg-rule-info { flex: 1; min-width: 0; }
  .cfg-rule-title { font-size: 13px; font-weight: 500; margin-bottom: 4px; }
  .cfg-rule-desc { font-size: 11px; color: var(--cc-muted); line-height: 1.5; }
  .cfg-rule-input { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
  .cfg-rule-input input { width: 80px; }
  .cfg-unit { font-family: var(--cc-font-mono); font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--cc-muted); }

  .cb-row { padding: 6px 0; border-bottom: 1px solid var(--cc-line-soft); }
  .cb-row:last-child { border-bottom: none; padding-bottom: 0; }
  .cb-row:first-child { padding-top: 0; }
  .cb-label { display: flex; gap: 12px; align-items: flex-start; cursor: pointer; }
  .cb-label input { margin-top: 4px; flex-shrink: 0; }
  .cb-text { display: flex; flex-direction: column; gap: 2px; }
  .cb-title { font-size: 13px; font-weight: 500; }
  .cb-desc { font-size: 11px; color: var(--cc-muted); line-height: 1.5; }

  .cfg-save-bar {
    background: var(--cc-surface);
    border: 1px solid var(--cc-line);
    padding: 14px 16px;
    display: flex;
    justify-content: flex-end;
    position: sticky;
    bottom: 0;
    z-index: 10;
    box-shadow: 0 -4px 12px rgba(0,0,0,0.04);
  }

  .field-row { display: flex; gap: 10px; flex-wrap: wrap; }
  .field-row .field { flex: 1; min-width: 200px; }
  .field { display: flex; flex-direction: column; }
  .loss-select, .loss-notes { width: 100%; padding: 10px 12px; border: 1px solid var(--cc-line); background: var(--cc-bg); font-family: inherit; font-size: 13px; color: var(--cc-ink); }
  .loss-label { display: block; font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cc-muted); font-weight: 500; margin-bottom: 6px; }
`;
