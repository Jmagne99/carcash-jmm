// ============================================================
// POST /.netlify/functions/publish-to-ig
// Publica una unidad como post en Instagram (Graph API Content Publishing).
// Body: { unit_id, action?: 'publish' | 'pause', caption?: string }
//  - 'publish': crea el media container con la foto + caption y lo publica.
//  - 'pause'  : Instagram no permite "despublicar" por API; solo marca el
//               estado en la base (la fila de publications).
// Requiere instagram_content_publish. La foto debe ser una URL pública
// (el bucket unit-photos lo es) para que Meta pueda descargarla.
// Docs: https://developers.facebook.com/docs/instagram-api/guides/content-publishing
// ============================================================
import { admin, json } from './_lib/supabase.js';

const API = 'https://graph.facebook.com/v21.0';

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  let p; try { p = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'JSON inválido' }); }
  const { unit_id, action = 'publish' } = p;
  if (!unit_id) return json(400, { error: 'unit_id requerido' });

  const token = process.env.META_ACCESS_TOKEN;
  const igId = process.env.META_INSTAGRAM_ACCOUNT_ID;
  if (!token || !igId) return json(503, { error: 'Instagram no configurado' });

  const sb = admin();

  // --- Pausar: solo estado en la base (IG no despublica por API) ---
  if (action === 'pause') {
    await sb.from('publications').upsert({
      unit_id, channel: 'instagram', status: 'pausada',
      last_synced_at: new Date().toISOString(),
    }, { onConflict: 'unit_id,channel' });
    return json(200, { ok: true, action, channel: 'instagram' });
  }

  // --- Publicar ---
  const { data: u, error: uErr } = await sb.from('units')
    .select('brand, model, year, public_price, featured_equipment, main_photo_url, photos')
    .eq('id', unit_id).single();
  if (uErr || !u) return json(404, { error: 'Unidad no encontrada' });

  const imageUrl = u.main_photo_url || (Array.isArray(u.photos) ? u.photos[0] : null);
  if (!imageUrl) return json(400, { error: 'La unidad no tiene foto para publicar' });

  const caption = (p.caption && p.caption.trim()) || buildCaption(u);

  try {
    // 1) Crear el media container
    const createUrl = `${API}/${igId}/media?image_url=${encodeURIComponent(imageUrl)}`
      + `&caption=${encodeURIComponent(caption)}&access_token=${token}`;
    const cRes = await fetch(createUrl, { method: 'POST' });
    const cJson = await cRes.json();
    if (cJson.error) throw new Error(cJson.error.message);
    const creationId = cJson.id;
    if (!creationId) throw new Error('Meta no devolvió creation_id');

    // 2) Publicar el container
    const pubUrl = `${API}/${igId}/media_publish?creation_id=${creationId}&access_token=${token}`;
    const pRes = await fetch(pubUrl, { method: 'POST' });
    const pJson = await pRes.json();
    if (pJson.error) throw new Error(pJson.error.message);
    const mediaId = pJson.id;

    // 3) Registrar en publications
    await sb.from('publications').upsert({
      unit_id, channel: 'instagram', status: 'activa',
      external_id: mediaId,
      published_at: new Date().toISOString(),
      last_synced_at: new Date().toISOString(),
    }, { onConflict: 'unit_id,channel' });

    return json(200, { ok: true, action: 'publish', channel: 'instagram', media_id: mediaId });
  } catch (err) {
    return json(502, { error: 'Graph API: ' + (err.message || 'error') });
  }
}

function buildCaption(u) {
  const eq = (u.featured_equipment || []).slice(0, 3).join(' · ');
  const price = u.public_price ? `\n💵 USD ${Number(u.public_price).toLocaleString('es-AR')}` : '';
  return `🚗 ${u.brand} ${u.model} ${u.year || ''}`.trim()
    + price
    + (eq ? `\n✔ ${eq}` : '')
    + `\n\n📩 Escribinos por DM`
    + `\n#autos #usados #${(u.brand || '').replace(/\s/g, '')}`;
}
