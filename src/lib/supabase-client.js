// ============================================================
// CARCASH · CLIENTE SUPABASE
// Single source of truth para conexión a Supabase
// ============================================================
// Uso:
//   import { supabase } from './lib/supabase-client.js';
//
// Para configurar credenciales editar config.js (no commiteado)
// o exponer SUPABASE_URL / SUPABASE_ANON_KEY en window antes de cargar.
// ============================================================

// Carga resiliente de la librería de Supabase: prueba varios CDN en cadena.
// Si uno falla (ej. esm.sh caído o bloqueado en la red), usa el siguiente,
// así la app arranca siempre.
const CDN_SOURCES = [
  'https://esm.sh/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',
  'https://cdn.skypack.dev/@supabase/supabase-js@2',
];
async function loadCreateClient() {
  let lastErr;
  for (const url of CDN_SOURCES) {
    try {
      const mod = await import(url);
      if (mod?.createClient) return mod.createClient;
    } catch (e) {
      lastErr = e;
      console.warn('[CarCash] CDN no disponible, probando el siguiente:', url);
    }
  }
  throw lastErr || new Error('No se pudo cargar la librería de Supabase desde ningún CDN');
}
export const createClient = await loadCreateClient();

// ============================================================
// CONFIGURACIÓN
// ============================================================
// 1) Si window.__CARCASH_CONFIG__ existe (inyectado en index.html),
//    se usa eso.
// 2) Sino, defaults locales.
// ============================================================

const cfg = window.__CARCASH_CONFIG__ || {};

export const SUPABASE_URL =
  cfg.SUPABASE_URL || 'https://vnwxdannrgwizvjlvlfr.supabase.co';

export const SUPABASE_ANON_KEY =
  cfg.SUPABASE_ANON_KEY || 'sb_publishable_zPIFU_qHbHTsUnG0g3Br5A_YBqtqB-Z';

// ============================================================
// VALIDACIÓN
// ============================================================
if (
  !SUPABASE_URL ||
  SUPABASE_URL.includes('TU-PROJECT-REF') ||
  !SUPABASE_ANON_KEY ||
  SUPABASE_ANON_KEY.includes('TU-ANON-KEY')
) {
  console.error(
    '[CarCash] Credenciales de Supabase no configuradas. ' +
    'Editá public/src/lib/supabase-client.js o definí window.__CARCASH_CONFIG__'
  );
}

// ============================================================
// CLIENTE
// ============================================================
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

// Disponible en consola para debugging
window.sb = supabase;
