// ============================================================
// GET /.netlify/functions/ml-oauth?code=...
// Callback de OAuth de Mercado Libre. Intercambia el `code` por
// access_token + refresh_token + user_id y los guarda en ml_tokens.
// La Redirect URI de la app de ML debe apuntar acá.
// Docs: https://developers.mercadolibre.com.ar/es_ar/autenticacion-y-autorizacion
// ============================================================
import { admin } from './_lib/supabase.js';
import { ML_API } from './_lib/ml.js';

function page(statusCode, inner) {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="margin:0;background:#0f172a;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center">
<div style="max-width:460px;padding:32px">${inner}</div></body>`,
  };
}

export async function handler(event) {
  const q = event.queryStringParameters || {};
  if (q.error) return page(400, `<h1>⚠️ Autorización cancelada</h1><p>Mercado Libre devolvió: ${q.error_description || q.error}</p>`);
  const code = q.code;
  if (!code) return page(400, '<h1>Falta el parámetro <code>code</code></h1><p>Reiniciá la autorización desde el CRM.</p>');

  const host = event.headers.host || event.headers.Host;
  const redirect = `https://${host}/.netlify/functions/ml-oauth`;

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: process.env.ML_APP_ID || '',
    client_secret: process.env.ML_CLIENT_SECRET || '',
    code,
    redirect_uri: redirect,
  });

  let t;
  try {
    const r = await fetch(`${ML_API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params,
    });
    t = await r.json();
  } catch (e) {
    return page(502, `<h1>Error de red con Mercado Libre</h1><p>${e.message}</p>`);
  }
  if (t.error || !t.access_token) {
    return page(502, `<h1>No se pudo obtener el token</h1><p>${t.message || t.error || 'Error desconocido'}</p><p style="opacity:.6;font-size:12px">Revisá que el Client Secret y la Redirect URI estén bien cargados.</p>`);
  }

  // Nickname de la cuenta (best-effort)
  let nickname = null;
  try {
    const me = await (await fetch(`${ML_API}/users/me?access_token=${t.access_token}`)).json();
    nickname = me.nickname || null;
  } catch { /* sin nickname */ }

  const sb = admin();
  let isDefault = false;
  try {
    const { count } = await sb.from('ml_tokens').select('user_id', { count: 'exact', head: true });
    isDefault = (count || 0) === 0;
  } catch { /* primera cuenta */ isDefault = true; }

  const { error } = await sb.from('ml_tokens').upsert({
    user_id: String(t.user_id),
    nickname,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: new Date(Date.now() + (t.expires_in || 21600) * 1000).toISOString(),
    is_default: isDefault,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });

  if (error) return page(500, `<h1>Token OK, pero no se pudo guardar</h1><p>${error.message}</p>`);

  return page(200, `<h1>✅ Mercado Libre conectado</h1>
    <p style="font-size:18px">Cuenta <b>${nickname ? '@' + nickname : t.user_id}</b> vinculada al CRM CarCash${isDefault ? ' (cuenta principal)' : ''}.</p>
    <p style="opacity:.6">Ya podés cerrar esta pestaña y volver al CRM.</p>`);
}
