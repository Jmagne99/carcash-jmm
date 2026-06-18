// ============================================================
// GET /.netlify/functions/ig-competitor?username=<competidor>
// Trae datos PÚBLICOS de una cuenta de la competencia usando
// Meta Business Discovery (seguidores, media_count y posts con
// like_count/comments_count). No da alcance/impresiones (son privados).
// Devuelve el shape que consume src/lib/ig-insights.js -> fetchCompetitorInsights.
// Docs: https://developers.facebook.com/docs/instagram-api/guides/business-discovery
// ============================================================
import { json } from './_lib/supabase.js';

const API = 'https://graph.facebook.com/v21.0';

export async function handler(event) {
  const username = (event.queryStringParameters || {}).username;
  if (!username) return json(400, { error: 'username requerido' });
  const token = process.env.META_ACCESS_TOKEN;
  const igId = process.env.META_INSTAGRAM_ACCOUNT_ID;
  if (!token || !igId) return json(503, { error: 'Instagram no configurado' });

  const user = username.replace(/^@/, '');
  try {
    // Business Discovery: datos PÚBLICOS de la competencia (no da alcance/impresiones).
    const fields = `business_discovery.username(${user})`
      + `{username,followers_count,media_count,follows_count,`
      + `media.limit(24){caption,media_type,media_url,thumbnail_url,like_count,comments_count,timestamp,permalink,children{media_url,thumbnail_url,media_type}}}`;
    const r = await fetch(`${API}/${igId}?fields=${encodeURIComponent(fields)}&access_token=${token}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    const d = j.business_discovery;
    if (!d) throw new Error('Cuenta no encontrada o no es Business/Creator');

    const media = (d.media?.data || []).map((m) => {
      const child = m.children?.data?.[0] || {};
      const image = (m.media_type === 'VIDEO' || m.media_type === 'REELS')
        ? (m.thumbnail_url || m.media_url || null)
        : (m.media_type === 'CAROUSEL_ALBUM')
          ? ((child.media_type === 'VIDEO' ? (child.thumbnail_url || child.media_url) : (child.media_url || child.thumbnail_url)) || m.thumbnail_url || null)
          : (m.media_url || m.thumbnail_url || null);
      return {
        caption: m.caption || '',
        media_type: m.media_type,
        image,
        like_count: m.like_count || 0,
        comments_count: m.comments_count || 0,
        timestamp: m.timestamp,
        permalink: m.permalink,
      };
    });

    // Engagement promedio = (likes + comments) / seguidores, sobre los posts visibles.
    const followers = d.followers_count || 0;
    const avgInteractions = media.length
      ? media.reduce((a, m) => a + m.like_count + m.comments_count, 0) / media.length
      : 0;
    const avgEngagement = followers ? +((avgInteractions / followers) * 100).toFixed(2) : 0;

    // Frecuencia de posteo (posts/semana) a partir de las fechas visibles.
    let postingPerWeek = 0;
    const times = media.map((m) => new Date(m.timestamp).getTime())
      .filter((t) => !isNaN(t)).sort((a, b) => b - a);
    if (times.length >= 2) {
      const weeks = Math.max((times[0] - times[times.length - 1]) / (7 * 86400000), 0.1);
      postingPerWeek = +(times.length / weeks).toFixed(1);
    }

    const topMedia = [...media]
      .sort((a, b) => (b.like_count + b.comments_count) - (a.like_count + a.comments_count))
      .slice(0, 3);

    return json(200, {
      profile: { username: user, followers, media_count: d.media_count || 0, follows: d.follows_count || 0 },
      avg_engagement: avgEngagement,
      posting_per_week: postingPerWeek,
      top_media: topMedia,
      media,
      // Nota: tono, tiempo de respuesta y ortografía requieren analizar el contenido;
      // Business Discovery solo da métricas públicas. El front los muestra si vienen.
    });
  } catch (err) {
    return json(502, { error: 'Business Discovery: ' + (err.message || 'error') });
  }
}
