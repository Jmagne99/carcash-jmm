// ============================================================
// POST /.netlify/functions/ml-webhook
// Recibe notificaciones de Mercado Libre. Cuando llega una
// PREGUNTA nueva (topic 'questions'), trae el detalle y la
// inserta como lead (origin='mercado_libre') con el mismo RPC
// que WhatsApp/Instagram. ML reintenta si no recibe 200 rápido,
// así que SIEMPRE devolvemos 200.
// Docs: https://developers.mercadolibre.com.ar/es_ar/productos-recibe-notificaciones
// ============================================================
import { admin, json } from './_lib/supabase.js';
import { getMLAccount, mlGet } from './_lib/ml.js';

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let notif;
  try { notif = JSON.parse(event.body || '{}'); } catch { return json(200, { received: true }); }
  const { topic, resource, user_id } = notif;
  if (!topic || !resource) return json(200, { received: true });

  // Por ahora solo procesamos preguntas. orders/items se pueden sumar después.
  if (topic !== 'questions') return json(200, { received: true, ignored: topic });

  try {
    const sb = admin();
    const acct = await getMLAccount(user_id);          // cuenta vendedora que recibió la pregunta
    const q = await mlGet(resource, acct.token);       // resource = '/questions/{id}'
    const text = (q.text || '').trim();
    const buyerId = q.from && q.from.id;
    if (!text || !buyerId) return json(200, { received: true, skipped: true });

    // Nickname del comprador (best-effort)
    let name = null;
    try { const u = await mlGet(`/users/${buyerId}`, acct.token); name = u.nickname || null; } catch { /* sin nombre */ }

    await sb.rpc('ingest_inbound_message', {
      p_phone: 'ML' + buyerId,            // identificador del comprador en ML (no es teléfono real)
      p_text: text,
      p_name: name,
      p_channel: 'mercado_libre',
      p_direction: 'entrante',
      p_external_id: 'mlq-' + q.id,       // idempotencia: no duplica si ML reintenta
      p_event_at: q.date_created || new Date().toISOString(),
    });

    return json(200, { received: true, ingested: true });
  } catch (err) {
    // Nunca devolver 5xx (ML reintentaría en loop). Reportamos el detalle igual.
    return json(200, { received: true, error: String(err.message || err).slice(0, 140) });
  }
}
