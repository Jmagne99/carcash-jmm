// ============================================================
// POST /.netlify/functions/ml-webhook
// Recibe notificaciones de Mercado Libre (questions, orders…).
// Cuando llega una pregunta nueva, crea una oportunidad en el
// pipeline con origin='mercado_libre'. Skeleton.
// ============================================================
import { admin, json } from './_lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const notif = JSON.parse(event.body || '{}');
  // notif = { topic, resource, user_id, application_id, sent, attempts }
  const sb = admin();

  // === TODO: GET notif.resource con ML_ACCESS_TOKEN para traer el detalle ===
  // Si topic === 'questions': crear/actualizar contacto + opportunity.
  // Ejemplo de inserción (completar con datos reales):
  // await sb.from('opportunities').insert({ contact_id, origin: 'mercado_libre', stage: 'nuevo', source_publication_id: itemId });

  // ML exige responder 200 rápido para no reintentar.
  return json(200, { received: true });
}
