// ============================================================
// POST /.netlify/functions/wsp-send
// body: { to, text, opportunity_id?, contact_id? }
// Reenvía el mensaje saliente al webhook de n8n, que se encarga
// de enviarlo por la API de WhatsApp de Meta. El CRM no habla con
// Meta directamente: n8n ya tiene esa automatización montada.
// ============================================================
import { json } from './_lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const url = process.env.N8N_WSP_SEND_URL;
  if (!url) return json(503, { error: 'WhatsApp no conectado (falta N8N_WSP_SEND_URL)' });

  let payload; try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'JSON inválido' }); }
  if (!payload.to || (!payload.text && !payload.audio_url)) return json(400, { error: 'to y (text o audio_url) son requeridos' });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Header opcional para que n8n valide el origen
        ...(process.env.N8N_SHARED_SECRET ? { 'X-CarCash-Secret': process.env.N8N_SHARED_SECRET } : {}),
      },
      body: JSON.stringify({
        to: payload.to,
        type: payload.type || 'text',
        text: payload.text || null,
        audio_url: payload.audio_url || null,
        opportunity_id: payload.opportunity_id || null,
        contact_id: payload.contact_id || null,
        source: 'carcash-crm',
      }),
    });
    if (!res.ok) return json(502, { error: `n8n respondió ${res.status}` });
    return json(200, { ok: true, dispatched: true });
  } catch (err) {
    return json(502, { error: 'No se pudo contactar a n8n: ' + err.message });
  }
}
