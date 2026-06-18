// ============================================================
// GET /.netlify/functions/integrations-status
// Devuelve qué integraciones tienen sus credenciales cargadas.
// Es 100% funcional: lee process.env y reporta el estado. La UI
// de Integraciones lo usa para pintar los hubs en verde/gris.
// No expone las claves: solo un "hint" enmascarado.
// ============================================================
import { json } from './_lib/supabase.js';

const mask = (v) => (v ? '••••' + String(v).slice(-4) : null);
const has = (v) => Boolean(v && String(v).trim());

export async function handler() {
  const e = process.env;
  const integrations = [
    { id: 'whatsapp',     configured: has(e.N8N_WSP_SEND_URL),  hint: mask(e.N8N_WSP_SEND_URL) },
    { id: 'mercadolibre', configured: has(e.ML_ACCESS_TOKEN),   hint: mask(e.ML_ACCESS_TOKEN) },
    { id: 'instagram',    configured: has(e.META_ACCESS_TOKEN), hint: mask(e.META_ACCESS_TOKEN) },
    { id: 'meta_ads',     configured: has(e.META_ACCESS_TOKEN) && has(e.META_AD_ACCOUNT_ID), hint: mask(e.META_AD_ACCOUNT_ID) },
    // claves individuales para los campos adicionales:
    { id: 'N8N_WSP_SEND_URL',           configured: has(e.N8N_WSP_SEND_URL) },
    { id: 'N8N_SHARED_SECRET',          configured: has(e.N8N_SHARED_SECRET) },
    { id: 'ML_USER_ID',                 configured: has(e.ML_USER_ID) },
    { id: 'META_INSTAGRAM_ACCOUNT_ID',  configured: has(e.META_INSTAGRAM_ACCOUNT_ID) },
    { id: 'META_AD_ACCOUNT_ID',         configured: has(e.META_AD_ACCOUNT_ID) },
  ];
  return json(200, { integrations });
}
