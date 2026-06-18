// ============================================================
// POST /.netlify/functions/publish-to-ml
// body: { unit_id, action?: 'publish'|'pause', ml_user_id? }
// Publica/pausa una unidad como CLASIFICADO de vehículo en
// Mercado Libre y registra la fila en public.publications.
// El token se obtiene (y refresca) de ml_tokens vía getMLAccount.
// Si ML rechaza, guarda la causa exacta en publications.error_message.
// Docs: https://developers.mercadolibre.com.ar/es_ar/publica-vehiculos
// ============================================================
import { admin, json } from './_lib/supabase.js';
import { getMLAccount, ML_API } from './_lib/ml.js';

const VEHICLE_CATEGORY = 'MLA1744'; // Autos, Camionetas y 4x4 (clasificados, Argentina)

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  let p; try { p = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'JSON inválido' }); }
  const { unit_id, action = 'publish', ml_user_id } = p;
  if (!unit_id) return json(400, { error: 'unit_id requerido' });

  const sb = admin();
  const { data: u, error: uErr } = await sb.from('units').select('*').eq('id', unit_id).single();
  if (uErr || !u) return json(404, { error: 'Unidad no encontrada' });

  let acct;
  try { acct = await getMLAccount(ml_user_id); } catch (e) { return json(503, { error: e.message }); }

  // --- Pausar: cambiar el item a 'paused' en ML + estado en la base ---
  if (action === 'pause') {
    const { data: pub } = await sb.from('publications').select('external_id').eq('unit_id', unit_id).eq('channel', 'mercado_libre').maybeSingle();
    if (pub && pub.external_id) {
      await fetch(`${ML_API}/items/${pub.external_id}?access_token=${acct.token}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'paused' }),
      });
    }
    await sb.from('publications').upsert({ unit_id, channel: 'mercado_libre', status: 'pausada', last_synced_at: new Date().toISOString() }, { onConflict: 'unit_id,channel' });
    return json(200, { ok: true, action: 'pause' });
  }

  // --- Publicar ---
  const pics = [u.main_photo_url, ...(Array.isArray(u.photos) ? u.photos : [])]
    .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 10).map(src => ({ source: src }));
  if (!pics.length) return json(400, { error: 'La unidad no tiene fotos para publicar' });

  const attrs = [];
  const A = (id, val) => { if (val != null && String(val).trim() !== '') attrs.push({ id, value_name: String(val) }); };
  A('BRAND', u.brand);
  A('MODEL', u.model);
  A('TRIM', u.version);
  A('VEHICLE_YEAR', u.year);
  A('KILOMETERS', u.mileage != null ? `${u.mileage} km` : null);
  A('FUEL_TYPE', u.fuel_type);
  A('TRANSMISSION', u.transmission);
  A('ENGINE_DISPLACEMENT', u.displacement_cc ? `${u.displacement_cc} cc` : null);
  A('VEHICLE_BODY_TYPE', u.body_type);
  A('COLOR', u.color_exterior);

  const title = `${u.brand || ''} ${u.model || ''} ${u.version || ''} ${u.year || ''}`
    .replace(/\s+/g, ' ').trim().slice(0, 60);

  const item = {
    title: title || 'Vehículo',
    category_id: VEHICLE_CATEGORY,
    price: Number(u.public_price) || 1,
    currency_id: 'USD',
    available_quantity: 1,
    buying_mode: 'classified',
    listing_type_id: 'silver',
    condition: 'used',
    pictures: pics,
    attributes: attrs,
    description: { plain_text: buildDescription(u) },
  };

  let ml;
  try {
    const res = await fetch(`${ML_API}/items?access_token=${acct.token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item),
    });
    ml = await res.json();
  } catch (e) {
    return json(502, { error: 'Red con Mercado Libre: ' + e.message });
  }

  if (ml.error || !ml.id) {
    const cause = Array.isArray(ml.cause) ? ml.cause.map(c => c.message || c.code).join(' · ') : (ml.message || ml.error || 'error');
    await sb.from('publications').upsert({
      unit_id, channel: 'mercado_libre', status: 'error',
      error_message: String(cause).slice(0, 500), error_at: new Date().toISOString(),
      last_payload: item, last_synced_at: new Date().toISOString(),
    }, { onConflict: 'unit_id,channel' });
    return json(502, { error: 'Mercado Libre rechazó la publicación: ' + cause });
  }

  await sb.from('publications').upsert({
    unit_id, channel: 'mercado_libre', status: 'activa',
    external_id: ml.id, url: ml.permalink || null,
    published_at: new Date().toISOString(), last_synced_at: new Date().toISOString(),
    error_message: null, error_at: null, last_payload: null,
  }, { onConflict: 'unit_id,channel' });

  return json(200, { ok: true, action: 'publish', item_id: ml.id, url: ml.permalink });
}

function buildDescription(u) {
  const eq = (u.featured_equipment || []).join(', ');
  return [
    `${u.brand || ''} ${u.model || ''} ${u.version || ''} ${u.year || ''}`.replace(/\s+/g, ' ').trim(),
    u.mileage != null ? `Kilómetros: ${u.mileage.toLocaleString('es-AR')}` : '',
    u.fuel_type ? `Combustible: ${u.fuel_type}` : '',
    u.transmission ? `Transmisión: ${u.transmission}` : '',
    u.displacement_cc ? `Motor: ${u.displacement_cc} cc` : '',
    u.color_exterior ? `Color: ${u.color_exterior}` : '',
    eq ? `Equipamiento: ${eq}` : '',
    u.description || '',
    '', '📩 Consultanos por más información y financiación.',
  ].filter(Boolean).join('\n');
}
