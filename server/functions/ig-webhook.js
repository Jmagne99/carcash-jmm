// ============================================================
// GET/POST /.netlify/functions/ig-webhook
// GET  → verificación del webhook de Meta (hub.challenge).
// POST → DMs entrantes de Instagram → crea/actualiza la oportunidad
//        (origin='instagram') usando el RPC ingest_inbound_message,
//        que matchea/crea el contacto, asegura el lead y registra el
//        mensaje en timeline_events (channel=instagram). Igual que
//        WhatsApp, el supervisor recibe la alerta para asignarlo.
// Docs: https://developers.facebook.com/docs/messenger-platform/instagram
// ============================================================
import { admin, json } from './_lib/supabase.js';

const API = 'https://graph.facebook.com/v21.0';

export async function handler(event) {
  // 1) Verificación del webhook (Meta manda hub.mode/hub.verify_token/hub.challenge)
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === process.env.META_VERIFY_TOKEN) {
      return { statusCode: 200, body: q['hub.challenge'] || '' };
    }
    return { statusCode: 403, body: 'forbidden' };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'JSON inválido' }); }
  if (body.object !== 'instagram') return json(200, { ignored: true });

  const sb = admin();
  const token = process.env.META_ACCESS_TOKEN;
  const igId = process.env.META_INSTAGRAM_ACCOUNT_ID;

  let ingested = 0;
  const nameCache = {};

  for (const entry of body.entry || []) {
    for (const m of entry.messaging || []) {
      const msg = m.message;
      // Ignorar: echos (mensajes que mandamos nosotros), reacciones, postbacks sin texto
      if (!msg || msg.is_echo) continue;
      const text = (msg.text || '').trim();
      if (!text) continue;

      const psid = m.sender?.id;
      if (!psid || psid === igId) continue; // no procesar lo nuestro

      // Nombre del perfil (best-effort; si falla, seguimos sin nombre)
      let name = nameCache[psid];
      if (name === undefined) {
        name = null;
        if (token) {
          try {
            const r = await fetch(`${API}/${psid}?fields=name,username&access_token=${token}`);
            if (r.ok) { const d = await r.json(); name = d.name || d.username || null; }
          } catch { /* sin nombre */ }
        }
        nameCache[psid] = name;
      }

      // Una sola llamada: contacto + lead + mensaje + notificación al supervisor.
      const { error } = await sb.rpc('ingest_inbound_message', {
        p_phone: psid,                  // en IG, el identificador es el PSID
        p_text: text,
        p_name: name,
        p_channel: 'instagram',
        p_direction: 'entrante',
        p_external_id: msg.mid || null, // idempotencia: no duplica si Meta reintenta
        p_event_at: m.timestamp ? new Date(Number(m.timestamp)).toISOString() : new Date().toISOString(),
      });
      if (!error) ingested++;
    }
  }

  // Siempre 200 para que Meta no reintente en loop ante un mensaje raro.
  return json(200, { ok: true, ingested });
}
