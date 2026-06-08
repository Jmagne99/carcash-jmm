// ============================================================
// CARCASH · MÓDULO VAULT DE CREDENCIALES
// Ruta: /credenciales
// Solo admin. Protegido con PIN (default 0000, cambiable).
// Las API keys reales viven en env vars de Netlify (más seguro).
// Esta vista muestra estado, últimos 4 chars, y permite testear.
// ============================================================

import { supabase } from '../lib/supabase-client.js';
import { state, isAdmin } from '../lib/state.js';
import { fmt, escapeHtml } from '../lib/formatters.js';
import { $, $$, el, toast, injectStyles, confirmDialog } from '../lib/dom.js';

const local = {
  unlocked: false,
  pinInitialized: false,
  integrations: [],
  fetchError: null,
};

const INTEGRATIONS_FALLBACK = [
  { id: 'anthropic', label: 'Anthropic (Claude API)', env_var: 'ANTHROPIC_API_KEY',
    description: 'Análisis de oportunidades, OCR de documentos, sugerencias de respuesta',
    docs_url: 'https://console.anthropic.com/settings/keys' },
  { id: 'whatsapp', label: 'WhatsApp Business (360dialog)', env_var: 'WHATSAPP_API_KEY',
    description: 'Webhook de mensajes y envío automatizado de WhatsApp',
    docs_url: 'https://hub.360dialog.com/dashboard/api-keys' },
  { id: 'mercadolibre', label: 'Mercado Libre', env_var: 'ML_ACCESS_TOKEN',
    description: 'Sincronización de publicaciones y leads de ML',
    docs_url: 'https://developers.mercadolibre.com.ar/devcenter' },
  { id: 'meta', label: 'Meta Ads / Instagram', env_var: 'META_ACCESS_TOKEN',
    description: 'Leads de Meta Ads y mensajes de Instagram',
    docs_url: 'https://developers.facebook.com/apps' },
  { id: 'supabase_service', label: 'Supabase Service Role', env_var: 'SUPABASE_SERVICE_ROLE_KEY',
    description: 'Operaciones admin desde Edge Functions',
    docs_url: 'https://supabase.com/dashboard/project/_/settings/api' },
];

// ============================================================
// MOUNT
// ============================================================
export async function mount() {
  injectStyles('credenciales-styles', styles);

  if (!isAdmin()) {
    $('#view').innerHTML = `
      <div class="placeholder">
        <div class="placeholder-content">
          <div class="placeholder-num">×</div>
          <div class="placeholder-title">Acceso <i>restringido</i></div>
          <div class="placeholder-desc">Solo dueño / gerente.</div>
          <div class="placeholder-status">NO AUTORIZADO</div>
        </div>
      </div>
    `;
    return;
  }

  // Verificar si el PIN ya fue cambiado del default
  try {
    const { data } = await supabase.rpc('vault_pin_initialized');
    local.pinInitialized = !!data;
  } catch (e) {
    local.pinInitialized = false;
  }

  local.unlocked = false;
  renderLocked();
}

export default mount;

// ============================================================
// PANTALLA: BLOQUEADA (PIN)
// ============================================================
function renderLocked() {
  const view = $('#view');
  view.innerHTML = `
    <div class="vault-lock">
      <div class="vault-lock-card">
        <div class="vault-lock-icon">🔒</div>
        <div class="vault-lock-title">Vault de credenciales</div>
        <div class="vault-lock-desc">
          Sección protegida. Ingresá el PIN de administración.
          ${!local.pinInitialized ? '<br><b>El PIN por defecto es 0000.</b> Vas a tener que cambiarlo después de entrar.' : ''}
        </div>
        <form id="pin-form" class="pin-form" autocomplete="off">
          <input type="password" id="pin-input" maxlength="20" inputmode="numeric"
            class="pin-input" placeholder="••••" autofocus>
          <button type="submit" class="btn btn-ok">Desbloquear</button>
        </form>
        <div class="pin-error" id="pin-error"></div>
      </div>
    </div>
  `;
  $('#pin-form').addEventListener('submit', tryUnlock);
  $('#pin-input').focus();
}

async function tryUnlock(e) {
  e.preventDefault();
  const pin = $('#pin-input').value;
  const errEl = $('#pin-error');
  errEl.textContent = '';

  if (!pin) return;

  try {
    const { data, error } = await supabase.rpc('vault_check_pin', { pin });
    if (error) throw error;
    if (!data) {
      errEl.textContent = 'PIN incorrecto';
      $('#pin-input').value = '';
      $('#pin-input').focus();
      return;
    }
    local.unlocked = true;
    await renderUnlocked();

    // Si todavía está usando el default, forzar cambio
    if (!local.pinInitialized) {
      setTimeout(() => promptChangePin(true), 500);
    }
  } catch (err) {
    errEl.textContent = err.message || 'Error al validar PIN';
  }
}

// ============================================================
// PANTALLA: DESBLOQUEADA (DASHBOARD DE INTEGRACIONES)
// ============================================================
async function renderUnlocked() {
  const view = $('#view');
  view.innerHTML = `
    <div class="page-hd">
      <div class="page-hd-top">
        <div class="page-title-block">
          <div class="page-num">MÓDULO 16 · DIRECCIÓN</div>
          <div class="page-title">Vault de <i>credenciales</i></div>
          <div class="page-sub">Estado de las integraciones configuradas en el backend</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-ghost btn-sm" id="btn-change-pin">Cambiar PIN</button>
          <button class="btn btn-ghost btn-sm" id="btn-lock">🔒 Bloquear</button>
          <button class="btn btn-ghost btn-sm" id="btn-refresh">Actualizar</button>
        </div>
      </div>
    </div>

    <div class="vault-body" id="vault-body">
      <div class="empty">Verificando integraciones…</div>
    </div>
  `;

  $('#btn-lock').addEventListener('click', () => {
    local.unlocked = false;
    renderLocked();
  });
  $('#btn-change-pin').addEventListener('click', () => promptChangePin(false));
  $('#btn-refresh').addEventListener('click', loadIntegrations);

  await loadIntegrations();
}

async function loadIntegrations() {
  const body = $('#vault-body');
  body.innerHTML = `<div class="empty">Verificando integraciones…</div>`;

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;

    const res = await fetch('/.netlify/functions/integrations-status', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const json = await res.json();
    local.integrations = json.integrations || [];
    local.fetchError = null;
  } catch (err) {
    console.warn('integrations-status fallo, usando fallback', err);
    // Fallback: mostrar todas como no configuradas + nota
    local.integrations = INTEGRATIONS_FALLBACK.map(i => ({ ...i, configured: false, hint: null, length: 0 }));
    local.fetchError = err.message;
  }

  renderIntegrationsTable();
}

function renderIntegrationsTable() {
  const body = $('#vault-body');
  const total = local.integrations.length;
  const configured = local.integrations.filter(i => i.configured).length;

  body.innerHTML = `
    ${local.fetchError ? `
      <div class="vault-warning">
        <b>⚠ La Edge Function de estado no está deployada todavía.</b><br>
        Mostrando todas las integraciones como "no configuradas" por defecto. Cuando deployes el repo a Netlify con las env vars correspondientes, esta vista va a reflejar el estado real.
      </div>
    ` : `
      <div class="vault-summary">
        <div class="vs-stat">
          <div class="vs-num">${configured}</div>
          <div class="vs-lbl">configuradas</div>
        </div>
        <div class="vs-stat">
          <div class="vs-num">${total - configured}</div>
          <div class="vs-lbl">pendientes</div>
        </div>
        <div class="vs-stat">
          <div class="vs-num">${total}</div>
          <div class="vs-lbl">total</div>
        </div>
      </div>
    `}

    <div class="vault-list">
      ${local.integrations.map(integrationCard).join('')}
    </div>

    <div class="vault-help">
      <div class="vh-title">Cómo configurar una integración</div>
      <ol class="vh-steps">
        <li>Generá la API key en el panel del proveedor (link en cada card).</li>
        <li>En Netlify: <b>Site settings → Environment variables → Add variable</b>.</li>
        <li>Pegá el nombre de la env var exacto (ej. <code>ANTHROPIC_API_KEY</code>) y el valor.</li>
        <li>Hacé un nuevo deploy del sitio (Trigger deploy → Deploy site) para que las Edge Functions tomen las nuevas env vars.</li>
        <li>Volvé acá y tocá "Actualizar" — la integración debería aparecer como configurada.</li>
      </ol>
      <div class="vh-note">
        <b>¿Por qué no guardamos las keys en la base de datos?</b><br>
        Las env vars de Netlify son más seguras: están cifradas en reposo, nunca se exponen al frontend, y las Edge Functions las leen directo del entorno. Guardar keys sensibles en la BD es un riesgo si alguien obtiene acceso de lectura.
      </div>
    </div>
  `;

  body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-test]');
    if (btn) testIntegration(btn.dataset.test);
  });
}

function integrationCard(i) {
  return `
    <div class="vint">
      <div class="vint-status status-${i.configured ? 'ok' : 'pending'}">
        ${i.configured ? '✓' : '○'}
      </div>
      <div class="vint-info">
        <div class="vint-label">${escapeHtml(i.label)}</div>
        <div class="vint-desc">${escapeHtml(i.description)}</div>
        <div class="vint-meta">
          <span class="vint-env">${escapeHtml(i.env_var)}</span>
          ${i.configured ? `<span class="vint-hint">${escapeHtml(i.hint || '••••')}</span>` : ''}
          ${i.docs_url ? `<a href="${escapeHtml(i.docs_url)}" target="_blank" rel="noopener" class="vint-docs">Obtener key →</a>` : ''}
        </div>
      </div>
      <div class="vint-actions">
        ${i.configured
          ? `<button class="btn btn-ghost btn-sm" data-test="${i.id}">Probar</button>`
          : `<span class="vint-tag">No configurada</span>`}
      </div>
    </div>
  `;
}

async function testIntegration(id) {
  toast('Probando…', id, 'info');
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    const res = await fetch(`/.netlify/functions/test-integration?name=${id}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      toast('Test no disponible', 'La Edge Function de test todavía no está deployada', 'warn');
      return;
    }
    const json = await res.json();
    if (json.ok) toast('✓ Conectado', json.message || 'OK', 'ok');
    else toast('✗ Error', json.error || 'No se pudo conectar', 'error');
  } catch (err) {
    toast('Test no disponible', err.message, 'warn');
  }
}

// ============================================================
// CAMBIAR PIN
// ============================================================
function promptChangePin(forceFromDefault = false) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', style: { maxWidth: '420px' } });

  const newPinInput = el('input', { type: 'password', class: 'loss-select', placeholder: 'Mínimo 4 caracteres', maxlength: '20' });
  const confirmPinInput = el('input', { type: 'password', class: 'loss-select', placeholder: 'Repetí el PIN nuevo', maxlength: '20' });
  const errEl = el('div', { class: 'pin-error', style: { marginTop: '8px' } });

  modal.appendChild(el('div', { class: 'modal-hd' },
    el('h3', {}, forceFromDefault ? '🔐 Cambiá el PIN por defecto' : 'Cambiar PIN del vault'),
    forceFromDefault ? null : el('button', { class: 'modal-close', onClick: () => close() }, '×')
  ));
  modal.appendChild(el('div', { class: 'modal-body' },
    forceFromDefault ? el('div', { class: 'vault-warning', style: { marginBottom: '14px' } },
      'Estás usando el PIN por defecto (0000). Ponéle uno nuevo para asegurar el vault.'
    ) : null,
    el('label', { class: 'loss-label' }, 'PIN nuevo'),
    newPinInput,
    el('label', { class: 'loss-label', style: { marginTop: '12px' } }, 'Confirmar'),
    confirmPinInput,
    errEl,
  ));
  modal.appendChild(el('div', { class: 'modal-actions' },
    forceFromDefault ? null : el('button', { class: 'btn btn-ghost', onClick: () => close() }, 'Cancelar'),
    el('button', { class: 'btn btn-ok', onClick: async () => {
      const a = newPinInput.value;
      const b = confirmPinInput.value;
      if (!a || a.length < 4) { errEl.textContent = 'El PIN debe tener al menos 4 caracteres'; return; }
      if (a !== b) { errEl.textContent = 'Los PINs no coinciden'; return; }

      try {
        const { error } = await supabase.rpc('vault_set_pin', { new_pin: a });
        if (error) throw error;
        toast('PIN actualizado', 'Va a pedirte el nuevo la próxima vez', 'ok');
        local.pinInitialized = true;
        close();
      } catch (err) {
        errEl.textContent = err.message;
      }
    } }, 'Guardar PIN'),
  ));

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  function close() { backdrop.remove(); }
  if (!forceFromDefault) {
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  }
  setTimeout(() => newPinInput.focus(), 100);
}

// ============================================================
// STYLES
// ============================================================
const styles = `
  /* PANTALLA BLOQUEADA */
  .vault-lock {
    min-height: 60vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
  }
  .vault-lock-card {
    background: var(--cc-surface);
    border: 1px solid var(--cc-line);
    padding: 40px 32px;
    max-width: 380px;
    width: 100%;
    text-align: center;
  }
  .vault-lock-icon { font-size: 36px; margin-bottom: 16px; }
  .vault-lock-title {
    font-family: var(--cc-font-display);
    font-weight: 300;
    font-size: 26px;
    letter-spacing: -0.02em;
    margin-bottom: 10px;
  }
  .vault-lock-desc {
    font-size: 12px;
    color: var(--cc-muted);
    line-height: 1.6;
    margin-bottom: 22px;
  }
  .pin-form { display: flex; flex-direction: column; gap: 10px; }
  .pin-input {
    text-align: center;
    font-family: var(--cc-font-mono);
    font-size: 20px;
    letter-spacing: 0.4em;
    padding: 14px;
    border: 1px solid var(--cc-line);
    background: var(--cc-bg);
    color: var(--cc-ink);
  }
  .pin-input:focus { outline: none; border-color: var(--cc-ink); }
  .pin-error { color: var(--cc-danger); font-size: 11px; margin-top: 8px; min-height: 14px; }

  /* PANTALLA DESBLOQUEADA */
  .vault-body { padding: 20px; max-width: 900px; }
  @container app (min-width: 900px) { .vault-body { padding: 28px 32px; } }

  .vault-summary {
    display: flex;
    gap: 1px;
    background: var(--cc-line);
    border: 1px solid var(--cc-line);
    margin-bottom: 22px;
  }
  .vs-stat { flex: 1; background: var(--cc-surface); padding: 14px; text-align: center; }
  .vs-num { font-family: var(--cc-font-display); font-weight: 400; font-size: 26px; line-height: 1; }
  .vs-lbl { font-family: var(--cc-font-mono); font-size: 9px; letter-spacing: 0.18em; color: var(--cc-muted); text-transform: uppercase; margin-top: 4px; }

  .vault-warning {
    background: var(--cc-warn-soft);
    border: 1px solid var(--cc-warn);
    color: var(--cc-warn);
    padding: 12px 14px;
    font-size: 12px;
    line-height: 1.5;
    margin-bottom: 22px;
  }
  .vault-warning b { color: var(--cc-warn); }

  .vault-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 28px; }

  .vint {
    background: var(--cc-surface);
    border: 1px solid var(--cc-line);
    padding: 14px 16px;
    display: flex;
    gap: 14px;
    align-items: center;
  }
  .vint-status {
    width: 32px; height: 32px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 50%;
    font-weight: 700;
    flex-shrink: 0;
  }
  .vint-status.status-ok {
    background: var(--cc-ok-soft);
    color: var(--cc-ok);
    border: 2px solid var(--cc-ok);
  }
  .vint-status.status-pending {
    background: var(--cc-bg-alt);
    color: var(--cc-muted);
    border: 2px solid var(--cc-line);
  }
  .vint-info { flex: 1; min-width: 0; }
  .vint-label { font-weight: 500; font-size: 14px; margin-bottom: 2px; }
  .vint-desc { font-size: 11px; color: var(--cc-muted); margin-bottom: 6px; line-height: 1.4; }
  .vint-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-family: var(--cc-font-mono); font-size: 10px; }
  .vint-env { padding: 2px 6px; background: var(--cc-bg-alt); border: 1px solid var(--cc-line); color: var(--cc-ink); letter-spacing: 0.05em; }
  .vint-hint { padding: 2px 6px; background: var(--cc-ok-soft); color: var(--cc-ok); border: 1px solid var(--cc-ok); font-weight: 600; }
  .vint-docs { color: var(--cc-info); text-decoration: underline; cursor: pointer; }
  .vint-actions { flex-shrink: 0; }
  .vint-tag { font-family: var(--cc-font-mono); font-size: 10px; padding: 4px 10px; background: var(--cc-bg-alt); color: var(--cc-muted); letter-spacing: 0.1em; text-transform: uppercase; }

  /* HELP SECTION */
  .vault-help {
    background: var(--cc-bg-alt);
    border-left: 3px solid var(--cc-champagne);
    padding: 16px 20px;
    font-size: 12px;
    line-height: 1.6;
  }
  .vh-title { font-family: var(--cc-font-display); font-weight: 500; font-size: 14px; margin-bottom: 8px; }
  .vh-steps { padding-left: 18px; margin-bottom: 12px; }
  .vh-steps li { padding: 3px 0; color: var(--cc-ink-soft); }
  .vh-steps code { font-family: var(--cc-font-mono); background: var(--cc-surface); padding: 1px 6px; border-radius: 2px; font-size: 11px; }
  .vh-note { padding-top: 10px; border-top: 1px solid var(--cc-line); color: var(--cc-muted); }
  .vh-note b { color: var(--cc-ink); }

  .loss-select { width: 100%; padding: 10px 12px; border: 1px solid var(--cc-line); background: var(--cc-bg); font-family: inherit; font-size: 13px; color: var(--cc-ink); }
  .loss-label { display: block; font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--cc-muted); font-weight: 500; margin-bottom: 6px; }
`;
