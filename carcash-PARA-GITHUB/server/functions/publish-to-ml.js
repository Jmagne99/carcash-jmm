// ============================================================
// POST /.netlify/functions/publish-to-ml
// body: { unit_id, action: 'publish'|'pause' }
// Publica/pausa una unidad en Mercado Libre y registra la fila
// en public.publications. Skeleton: completar la llamada a la API.
// Docs: https://developers.mercadolibre.com.ar/es_ar/publica-productos
// ============================================================
import { admin, json } from './_lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const { unit_id, action = 'publish' } = JSON.parse(event.body || '{}');
  if (!unit_id) return json(400, { error: 'unit_id requerido' });

  const token = process.env.ML_ACCESS_TOKEN;
  if (!token) return json(503, { error: 'ML no configurado (ML_ACCESS_TOKEN)' });

  const sb = admin();
  const { data: unit, error } = await sb.from('units').select('*').eq('id', unit_id).single();
  if (error) return json(404, { error: 'Unidad no encontrada' });

  // === TODO: armar el item y POST a https://api.mercadolibre.com/items ===
  // const item = { title: `${unit.brand} ${unit.model} ${unit.year}`, category_id: 'MLA1744', price: unit.public_price, currency_id: 'USD', ... };
  // const res = await fetch('https://api.mercadolibre.com/items', { method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body: JSON.stringify(item) });
  // const ml = await res.json();

  // Upsert de la publicación (ejemplo)
  await sb.from('publications').upsert({
    unit_id,
    channel: 'mercado_libre',
    status: action === 'pause' ? 'pausada' : 'activa',
    // external_id: ml.id, url: ml.permalink,
    last_synced_at: new Date().toISOString(),
  }, { onConflict: 'unit_id,channel' });

  return json(200, { ok: true, action, channel: 'mercado_libre', todo: 'completar POST a la API de ML' });
}
