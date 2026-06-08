// ============================================================
// CARCASH · WHATSAPP (Meta + n8n)
// El envío saliente de WhatsApp lo despacha n8n (que ya está
// automatizado contra la API de Meta). El CRM solo le avisa a
// n8n vía la Edge Function `wsp-send`, que reenvía al webhook de
// n8n. Si todavía no está conectado, devolvemos un mock para que
// la Bandeja siga registrando el mensaje localmente sin romperse.
// ============================================================

import { supabase } from './supabase-client.js';

/**
 * Pide a n8n que envíe un WhatsApp al cliente.
 * @param {{ to:string, text:string, opportunityId?:string, contactId?:string }} payload
 * @returns {Promise<{ ok:boolean, mock?:boolean, error?:string }>}
 */
export async function sendWhatsApp({ to, text, audioUrl = null, opportunityId = null, contactId = null }) {
  if (!to) return { ok: false, error: 'Falta el número de teléfono del contacto' };
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  try {
    const res = await fetch('/.netlify/functions/wsp-send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ to, text, audio_url: audioUrl, type: audioUrl ? 'audio' : 'text', opportunity_id: opportunityId, contact_id: contactId }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 503 = n8n no configurado → tratamos como mock (no es un error del usuario)
      if (res.status === 503) return { ok: false, mock: true, error: json.error || 'WhatsApp no conectado' };
      throw new Error(json.error || `wsp-send ${res.status}`);
    }
    return { ok: true, ...json };
  } catch (err) {
    if (err.message?.includes('Failed to fetch') || err.message?.includes('404')) {
      return { ok: false, mock: true, error: 'La Edge Function wsp-send no está deployada todavía.' };
    }
    return { ok: false, error: err.message };
  }
}
