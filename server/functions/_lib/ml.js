// ============================================================
// Helper de Mercado Libre (server-side).
// Los access_token de ML vencen a las ~6 h y al refrescar rotan
// también el refresh_token, así que NO pueden vivir en env vars:
// se guardan en la tabla public.ml_tokens y se refrescan acá.
// ============================================================
import { admin } from './supabase.js';

export const ML_API = 'https://api.mercadolibre.com';

// Devuelve { token, user_id, nickname } de la cuenta pedida (o la marcada como default).
// Refresca el access_token de forma transparente si está por vencer.
export async function getMLAccount(userId) {
  const sb = admin();
  let query = sb.from('ml_tokens').select('*');
  query = userId ? query.eq('user_id', String(userId)) : query.eq('is_default', true);
  const { data: row } = await query.limit(1).maybeSingle();
  if (!row) throw new Error('No hay cuenta de Mercado Libre conectada');

  // Vigente (con 5 min de margen) → devolver tal cual
  if (new Date(row.expires_at).getTime() - Date.now() > 5 * 60 * 1000) {
    return { token: row.access_token, user_id: row.user_id, nickname: row.nickname };
  }

  // Refrescar
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ML_APP_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
    refresh_token: row.refresh_token,
  });
  const r = await fetch(`${ML_API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params,
  });
  const t = await r.json();
  if (t.error || !t.access_token) {
    throw new Error('No se pudo refrescar el token de ML: ' + (t.message || t.error || 'error'));
  }

  await sb.from('ml_tokens').update({
    access_token: t.access_token,
    refresh_token: t.refresh_token || row.refresh_token,
    expires_at: new Date(Date.now() + (t.expires_in || 21600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('user_id', row.user_id);

  return { token: t.access_token, user_id: row.user_id, nickname: row.nickname };
}

// GET autenticado contra la API de ML.
export async function mlGet(path, token) {
  const r = await fetch(`${ML_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return r.json();
}
