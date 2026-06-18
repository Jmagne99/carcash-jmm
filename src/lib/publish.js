// ============================================================
// CARCASH · PUBLISH HELPER
// Llama a las Edge Functions para publicar/pausar unidades
// en plataformas externas (ML, IG).
// Si las functions no están deployadas, devuelve un mock claro.
// ============================================================

import { supabase } from './supabase-client.js';

export const CHANNELS = {
  mercado_libre: { label: 'Mercado Libre', endpoint: '/.netlify/functions/publish-to-ml', color: 'var(--cc-ml)' },
  instagram:     { label: 'Instagram',     endpoint: '/.netlify/functions/publish-to-ig', color: 'var(--cc-ig)' },
};

export async function publishUnit(unitId, channel, action = 'publish', options = {}) {
  const cfg = CHANNELS[channel];
  if (!cfg) throw new Error('Canal desconocido: ' + channel);

  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

  try {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ unit_id: unitId, action, ...options }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `${res.status}`);
    return { ok: true, ...json };
  } catch (err) {
    if (err.message?.includes('Failed to fetch') || err.message?.includes('404')) {
      return {
        ok: false,
        mock: true,
        error: 'La Edge Function no está deployada. Conectá el repo a Netlify y configurá las API keys.',
      };
    }
    return { ok: false, error: err.message };
  }
}

/**
 * Devuelve la lista de publicaciones de una unidad agrupadas por canal.
 */
export async function getUnitPublications(unitId) {
  const { data, error } = await supabase
    .from('publications')
    .select('*')
    .eq('unit_id', unitId)
    .order('updated_at', { ascending: false });
  if (error) {
    console.error('publications fetch error', error);
    return [];
  }
  return data || [];
}

/**
 * Triggea autopublish basado en `unit.auto_publish_channels`.
 * Llamado al guardar una unidad.
 */
export async function triggerAutoPublish(unitId, channels) {
  if (!channels || !channels.length) return [];
  const results = [];
  for (const ch of channels) {
    const r = await publishUnit(unitId, ch, 'publish');
    results.push({ channel: ch, ...r });
  }
  return results;
}
