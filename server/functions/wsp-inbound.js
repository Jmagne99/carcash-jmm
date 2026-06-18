// ============================================================
// POST /.netlify/functions/wsp-inbound
// n8n (que recibe el WhatsApp de Meta) postea acá cada mensaje.
// Esta función matchea/crea el contacto, asegura una oportunidad
// abierta y registra el mensaje en timeline_events (channel=whatsapp).
// Resultado: la conversación aparece sola en la Bandeja del CRM.
//
// Seguridad: validar el header X-CarCash-Secret contra N8N_SHARED_SECRET.
//
// Payload esperado (configurable en n8n):
//   {
//     "phone": "+5491122334455",
//     "name": "Juan Pérez",          // opcional
//     "text": "Hola, sigue disponible la Hilux?",
//     "direction": "entrante",        // entrante | saliente
//     "wa_message_id": "wamid....",   // opcional (idempotencia)
//     "timestamp": "2026-06-01T12:00:00Z"  // opcional
//   }
// ============================================================
import { admin, json } from './_lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const secret = process.env.N8N_SHARED_SECRET;
  if (secret && event.headers['x-carcash-secret'] !== secret) {
    return json(401, { error: 'unauthorized' });
  }

  let p; try { p = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'JSON inválido' }); }
  const phone = (p.phone || '').replace(/[^\d+]/g, '');
  if (!phone || !p.text) return json(400, { error: 'phone y text son requeridos' });

  const sb = admin();

  // 1) Contacto por teléfono (match laxo por últimos 10 dígitos)
  const tail = phone.slice(-10);
  let contact;
  const { data: found } = await sb.from('contacts').select('id, full_name')
    .ilike('phone', `%${tail}`).is('deleted_at', null).limit(1).maybeSingle();
  if (found) {
    contact = found;
  } else {
    const { data: created, error } = await sb.from('contacts')
      .insert({ full_name: p.name || `WhatsApp ${tail}`, phone, whatsapp_id: phone })
      .select('id, full_name').single();
    if (error) return json(500, { error: 'No se pudo crear el contacto: ' + error.message });
    contact = created;
  }

  // 2) Oportunidad abierta (o crear una nueva con origin=whatsapp)
  let { data: opp } = await sb.from('opportunities')
    .select('id').eq('contact_id', contact.id)
    .not('stage', 'in', '(ganada,perdida)').is('deleted_at', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!opp) {
    const { data: newOpp, error } = await sb.from('opportunities')
      .insert({ contact_id: contact.id, origin: 'whatsapp', stage: 'nuevo' })
      .select('id').single();
    if (error) return json(500, { error: 'No se pudo crear la oportunidad: ' + error.message });
    opp = newOpp;
  }

  // 3) Idempotencia opcional por wa_message_id (guardado en metadata)
  if (p.wa_message_id) {
    const { data: dup } = await sb.from('timeline_events')
      .select('id').eq('opportunity_id', opp.id)
      .contains('metadata', { wa_message_id: p.wa_message_id }).limit(1).maybeSingle();
    if (dup) return json(200, { ok: true, deduped: true });
  }

  // 4) Registrar el mensaje
  const { error: evErr } = await sb.from('timeline_events').insert({
    opportunity_id: opp.id,
    event_type: 'mensaje',
    channel: 'whatsapp',
    direction: p.direction === 'saliente' ? 'saliente' : 'entrante',
    title: 'WhatsApp',
    body: p.text,
    is_system: false,
    metadata: p.wa_message_id ? { wa_message_id: p.wa_message_id, via: 'n8n' } : { via: 'n8n' },
    event_at: p.timestamp || new Date().toISOString(),
  });
  if (evErr) return json(500, { error: evErr.message });

  return json(200, { ok: true, contact_id: contact.id, opportunity_id: opp.id });
}
