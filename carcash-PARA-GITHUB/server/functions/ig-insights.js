// ============================================================
// GET /.netlify/functions/ig-insights?period=28d
// Trae métricas de la cuenta de Instagram Business vía Meta
// Graph API y las mapea al shape que consume src/lib/ig-insights.js:
//   { profile, totals, series, top_media }
// Si falla la llamada o falta el token, devuelve 5xx y el frontend
// cae solo a los datos demo (no se rompe nada).
// Docs: https://developers.facebook.com/docs/instagram-api/guides/insights
// ============================================================
import { json } from './_lib/supabase.js';

const API = 'https://graph.facebook.com/v21.0';

export async function handler(event) {
  const period = (event.queryStringParameters || {}).period === '7d' ? '7d' : '28d';
  const token = process.env.META_ACCESS_TOKEN;
  const igId = process.env.META_INSTAGRAM_ACCOUNT_ID;
  if (!token || !igId) {
    return json(503, { error: 'Instagram no configurado (META_ACCESS_TOKEN / META_INSTAGRAM_ACCOUNT_ID)' });
  }

  const days = period === '7d' ? 7 : 28;
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const until = Math.floor(Date.now() / 1000);
  const base = `${API}/${igId}`;

  try {
    const [profileRes, reachRes, dayRes, followersRes, mediaRes] = await Promise.all([
      fetch(`${base}?fields=username,name,followers_count,follows_count,media_count,profile_picture_url&access_token=${token}`),
      // Serie diaria de alcance (para el gráfico y el total del período)
      fetch(`${base}/insights?metric=reach&period=day&metric_type=total_value&since=${since}&until=${until}&access_token=${token}`),
      // Totales del período: impresiones, visitas al perfil, clics a la web
      fetch(`${base}/insights?metric=impressions,profile_views,website_clicks&period=day&since=${since}&until=${until}&access_token=${token}`),
      // Serie de seguidores (nuevos por día)
      fetch(`${base}/insights?metric=follower_count&period=day&since=${since}&until=${until}&access_token=${token}`),
      // Posts recientes con su engagement
      fetch(`${base}/media?fields=caption,media_type,permalink,timestamp,like_count,comments_count,insights.metric(reach,saved)&limit=12&access_token=${token}`),
    ]);

    const profileJson = await profileRes.json();
    if (profileJson.error) throw new Error(profileJson.error.message);

    const reachJson = await safeJson(reachRes);
    const dayJson = await safeJson(dayRes);
    const followersJson = await safeJson(followersRes);
    const mediaJson = await safeJson(mediaRes);

    // --- Serie de alcance por día ---
    const reachValues = pickMetricValues(reachJson, 'reach'); // [{end_time, value}]
    const followerValues = pickMetricValues(followersJson, 'follower_count');
    const followersNow = profileJson.followers_count || 0;

    // Reconstruimos seguidores hacia atrás a partir de los "nuevos por día"
    const newFollowersTotal = followerValues.reduce((a, v) => a + (v.value || 0), 0);
    let running = followersNow - newFollowersTotal;
    const series = reachValues.map((rv, i) => {
      running += followerValues[i]?.value || 0;
      return {
        date: (rv.end_time || '').slice(0, 10),
        reach: rv.value || 0,
        followers: running,
      };
    });

    const reachTotal = reachValues.reduce((a, v) => a + (v.value || 0), 0);

    // --- Top media (ordenados por engagement) ---
    const media = (mediaJson.data || []).map((m) => {
      const ins = {};
      for (const x of m.insights?.data || []) ins[x.name] = x.values?.[0]?.value || 0;
      return {
        id: m.id,
        caption: m.caption || '',
        media_type: m.media_type,
        permalink: m.permalink,
        date: (m.timestamp || '').slice(0, 10),
        like_count: m.like_count || 0,
        comments_count: m.comments_count || 0,
        saved: ins.saved || 0,
        reach: ins.reach || 0,
      };
    });
    const engOf = (m) => (m.like_count + m.comments_count + m.saved) / (m.reach || 1);
    const top_media = [...media].sort((a, b) => engOf(b) - engOf(a)).slice(0, 8);

    // --- Engagement promedio sobre los posts recientes ---
    const engRates = media.filter((m) => m.reach > 0).map(engOf);
    const engagementRate = engRates.length
      ? +(engRates.reduce((a, v) => a + v, 0) / engRates.length * 100).toFixed(1)
      : 0;

    return json(200, {
      profile: {
        username: profileJson.username,
        name: profileJson.name,
        followers: followersNow,
        follows: profileJson.follows_count || 0,
        media_count: profileJson.media_count || 0,
        profile_picture_url: profileJson.profile_picture_url || null,
      },
      totals: {
        period,
        reach: reachTotal,
        impressions: sumMetric(dayJson, 'impressions'),
        profile_views: sumMetric(dayJson, 'profile_views'),
        website_clicks: sumMetric(dayJson, 'website_clicks'),
        new_followers: newFollowersTotal,
        engagement_rate: engagementRate,
        // DMs y leads del período: se calculan en el CRM (timeline_events), no en Meta.
      },
      series,
      top_media,
      feed: media,
    });
  } catch (err) {
    // El frontend cae a demo ante un 5xx; devolvemos el detalle para el log.
    return json(502, { error: 'Graph API: ' + (err.message || 'error') });
  }
}

async function safeJson(res) { try { return await res.json(); } catch { return {}; } }

// Insights API: data[] con name + values[] (serie diaria) o total_value
function pickMetricValues(insightsJson, name) {
  const item = (insightsJson.data || []).find((d) => d.name === name);
  if (!item) return [];
  if (Array.isArray(item.values)) return item.values;
  if (item.total_value?.value != null) return [{ end_time: '', value: item.total_value.value }];
  return [];
}
function sumMetric(insightsJson, name) {
  return pickMetricValues(insightsJson, name).reduce((a, v) => a + (v.value || 0), 0);
}
