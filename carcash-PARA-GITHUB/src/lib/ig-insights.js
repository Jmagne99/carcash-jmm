// ============================================================
// CARCASH · INSTAGRAM INSIGHTS
// Cliente del frontend para traer estadísticas de la cuenta de
// Instagram Business vía la Edge Function `ig-insights`
// (Meta Graph API del lado del servidor — la API key NUNCA va
// en el browser). Si la function no está deployada, devolvemos
// datos mock realistas para que el panel se pueda ver y diseñar.
// ============================================================

import { supabase } from './supabase-client.js';

/**
 * Trae las métricas de la cuenta de Instagram.
 * @param {string} period  '7d' | '28d'
 * @returns {Promise<{ profile, totals, series, top_media, _mock? }>}
 */
export async function fetchInstagramInsights(period = '28d') {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  try {
    const res = await fetch(`/.netlify/functions/ig-insights?period=${encodeURIComponent(period)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!isJsonOk(res)) return mockInsights(period);
    return await res.json();
  } catch {
    return mockInsights(period);
  }
}

/**
 * True solo si la respuesta es 200 y realmente es JSON.
 * En el deploy estático las functions caen al redirect SPA (HTML 200),
 * así que validamos el content-type para caer al mock de forma confiable.
 */
function isJsonOk(res) {
  return res.ok && (res.headers.get('content-type') || '').includes('application/json');
}

/**
 * Métricas públicas de una cuenta de la COMPETENCIA (vía Meta Business
 * Discovery — datos públicos: seguidores, posts y su engagement).
 * Mock hasta conectar la API.
 */
export async function fetchCompetitorInsights(username) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  try {
    const res = await fetch(`/.netlify/functions/ig-competitor?username=${encodeURIComponent(username)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!isJsonOk(res)) return mockCompetitor(username);
    return await res.json();
  } catch {
    return mockCompetitor(username);
  }
}

/** Análisis heurístico de por qué un post funcionó (a partir de sus números). */
export function analyzePost(m) {
  const reach = m.reach || 1;
  const likes = m.like_count || 0, comments = m.comments_count || 0, saved = m.saved || 0;
  const eng = (likes + comments + saved) / reach;
  const reasons = [];
  if (['VIDEO', 'REELS', 'CLIP'].includes(m.media_type)) reasons.push('el video/reel amplifica el alcance');
  if (saved / reach > 0.01) reasons.push('mucho guardado: contenido útil/de referencia');
  if (likes > 0 && comments / likes > 0.06) reasons.push('genera conversación (muchos comentarios)');
  if (m.media_type === 'CAROUSEL_ALBUM') reasons.push('el carrusel invita a deslizar y retiene');
  if (eng > 0.08) reasons.push('engagement por encima del promedio');
  if (!reasons.length) reasons.push('alcance sólido con buena recepción');
  return { engagement: +(eng * 100).toFixed(1), reasons: reasons.slice(0, 2) };
}

/** Competidores que la app sugiere analizar (mock; real vía hashtag/ubicación). */
export function suggestCompetitors() {
  return [
    { username: 'autospremium.ba', reason: 'Misma zona · más seguidores' },
    { username: 'usados.rosario', reason: 'Mismo segmento de usados' },
    { username: 'agencia0km.cba', reason: 'Fuerte en Reels y 0km' },
  ];
}

function hashNum(s, min, max) {
  let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return min + (h % (max - min + 1));
}

function mockCompetitor(username) {
  const u = (username || 'competencia').replace(/^@/, '');
  const followers = hashNum(u, 6000, 24000);
  const perWeek = hashNum(u + 'p', 3, 9);
  const eng = +(hashNum(u + 'e', 18, 62) / 10).toFixed(1);   // 1.8–6.2 %
  const respMin = hashNum(u + 'r', 25, 320);                  // minutos prom. de respuesta
  const typos = hashNum(u + 't', 0, 4);
  const tones = [
    'Informal y cercano, con emojis y llamados a la acción ("escribinos por DM")',
    'Directo y comercial, foco en precio y financiación',
    'Aspiracional, frases cortas y mucho hashtag',
  ];
  const tone = tones[hashNum(u + 'to', 0, tones.length - 1)];
  return {
    _mock: true,
    profile: { username: u, followers, media_count: hashNum(u + 'm', 200, 900), follows: hashNum(u + 'f', 250, 600) },
    avg_engagement: eng,
    posting_per_week: perWeek,
    posting_pattern: ['Mar · Jue · Sáb', 'Lun a Vie', 'Fines de semana'][hashNum(u + 'pp', 0, 2)] + ' · picos 19–21 h',
    avg_response_minutes: respMin,
    tone,
    typos_count: typos,
    typos_examples: typos ? ['"financiacion" (sin tilde)', '"aprovecha" / "aprovechá"', '"super oferta"'].slice(0, typos) : [],
    strengths: [perWeek >= 6 ? 'Publica seguido (constancia)' : 'Buen engagement por post', respMin <= 90 ? 'Responde rápido los comentarios' : 'Contenido de producto claro'],
    weaknesses: [respMin > 120 ? `Tarda en responder (~${Math.round(respMin / 60)} h)` : 'Poca variedad de formato', typos ? `${typos} errores de ortografía detectados` : 'Pocos Reels'],
    top_media: [
      { caption: '0km financiado 100% — cuotas fijas', media_type: 'IMAGE', like_count: hashNum(u + '1', 200, 700), comments_count: hashNum(u + 'c1', 8, 45), reach: hashNum(u + 'rr1', 4000, 9000) },
      { caption: 'Entrega inmediata, llevate tu usado hoy', media_type: 'VIDEO', like_count: hashNum(u + '2', 300, 900), comments_count: hashNum(u + 'c2', 12, 60), reach: hashNum(u + 'rr2', 5000, 12000) },
      { caption: 'Tasa 0% por tiempo limitado', media_type: 'CAROUSEL_ALBUM', like_count: hashNum(u + '3', 180, 600), comments_count: hashNum(u + 'c3', 6, 30), reach: hashNum(u + 'rr3', 3500, 8000) },
    ],
  };
}

function mockInsights(period) {
  const days = period === '7d' ? 7 : 28;
  // Serie de seguidores con leve crecimiento + ruido determinístico
  const base = 8420;
  const series = [];
  let followers = base - days * 14;
  for (let i = days; i >= 0; i--) {
    followers += 12 + Math.round(Math.sin(i / 2) * 6) + (i % 3 === 0 ? 8 : 0);
    const d = new Date(); d.setDate(d.getDate() - i);
    series.push({
      date: d.toISOString().slice(0, 10),
      followers,
      reach: 900 + Math.round(Math.abs(Math.sin(i)) * 700) + (i % 4 === 0 ? 350 : 0),
    });
  }
  const reachTotal = series.reduce((a, s) => a + s.reach, 0);
  const followersNow = series[series.length - 1].followers;
  const followersStart = series[0].followers;

  return {
    _mock: true,
    profile: {
      username: 'carcash.premium',
      name: 'CarCash · Premium Motors',
      followers: followersNow,
      follows: 312,
      media_count: 486,
      profile_picture_url: null,
    },
    totals: {
      period,
      reach: reachTotal,
      impressions: Math.round(reachTotal * 1.8),
      profile_views: Math.round(reachTotal * 0.07),
      website_clicks: Math.round(reachTotal * 0.012),
      new_followers: followersNow - followersStart,
      engagement_rate: 4.6,                 // %
      dm_received: 38,
      leads_from_ig: 21,
    },
    series,
    top_media: mockFeed().slice(0, 4),
    feed: mockFeed(),
  };
}

/** Inbox de Instagram (DMs) de demostración. */
export async function fetchInstagramInbox() {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  try {
    const res = await fetch('/.netlify/functions/ig-inbox', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!isJsonOk(res)) return mockInbox();
    return await res.json();
  } catch {
    return mockInbox();
  }
}

/** Comentarios de las publicaciones (moderación). Mock hasta conectar. */
export async function fetchInstagramComments() {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  try {
    const res = await fetch('/.netlify/functions/ig-comments', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!isJsonOk(res)) return mockComments();
    return await res.json();
  } catch {
    return mockComments();
  }
}

function mockComments() {
  const mk = (post, user, text, h) => { const d = new Date(); d.setHours(d.getHours() - h); return { id: 'c' + Math.random().toString(36).slice(2), post, user, text, when: d.toISOString(), hidden: false }; };
  return [
    mk('Toyota Hilux SRX 2022 — entregada', 'juanma_ok', '¿Cuánto la Hilux? 🙌', 1),
    mk('Recorrido 360° — Audi Q5', 'caro.díaz', 'Hermoso! Toman permuta?', 2),
    mk('Antes / después: detailing Golf GTI', 'detailing_fan', 'Quedó impecable 🔥🔥', 5),
    mk('Tips: cómo elegir tu próximo usado', 'pedro_motors', 'Excelente info, gracias', 9),
    mk('Ford Ranger Limited 0km', 'spam_bot_123', 'Gana plata fácil 👉 link.fake', 12),
  ];
}

function mockFeed() {
  const base = [
    { caption: 'Toyota Hilux SRX 2022 — entregada 🔥 Gracias por la confianza', media_type: 'IMAGE', like_count: 432, comments_count: 28, reach: 5120, saved: 64 },
    { caption: 'Recorrido 360° — Audi Q5 impecable, financiación a tu medida', media_type: 'VIDEO', like_count: 521, comments_count: 33, reach: 6890, saved: 77 },
    { caption: 'VW Amarok V6 · permuta tomada, lista para vos', media_type: 'CAROUSEL_ALBUM', like_count: 388, comments_count: 19, reach: 4410, saved: 51 },
    { caption: 'Llegó la unidad que estabas esperando 🚙', media_type: 'IMAGE', like_count: 276, comments_count: 12, reach: 3120, saved: 30 },
    { caption: 'Tips: cómo elegir tu próximo usado sin equivocarte', media_type: 'CAROUSEL_ALBUM', like_count: 612, comments_count: 47, reach: 8200, saved: 188 },
    { caption: 'Antes / después: detailing de un Golf GTI', media_type: 'REELS', like_count: 904, comments_count: 61, reach: 14300, saved: 142 },
    { caption: 'Showroom recién renovado, te esperamos ☕', media_type: 'IMAGE', like_count: 198, comments_count: 9, reach: 2600, saved: 14 },
    { caption: 'Ford Ranger Limited 0km — entrega inmediata', media_type: 'IMAGE', like_count: 341, comments_count: 22, reach: 4020, saved: 38 },
    { caption: 'Cliente feliz con su Corolla Cross 🎉', media_type: 'IMAGE', like_count: 287, comments_count: 16, reach: 3380, saved: 21 },
    { caption: 'En vivo: respondemos tus dudas sobre prendas', media_type: 'VIDEO', like_count: 173, comments_count: 38, reach: 2950, saved: 12 },
  ];
  return base.map((m, i) => {
    const d = new Date(); d.setDate(d.getDate() - i * 3);
    return { id: 'm' + (i + 1), date: d.toISOString().slice(0, 10), ...m };
  });
}

function mockInbox() {
  const mk = (name, last, h, unread) => { const d = new Date(); d.setHours(d.getHours() - h); return { name, last, when: d.toISOString(), unread }; };
  return [
    mk('Martín Gómez', 'Hola! Sigue disponible la Hilux?', 1, true),
    mk('Caro Díaz', 'Me pasás precio del Q5?', 3, true),
    mk('Lucas Pereyra', 'Aceptan permuta por una Amarok?', 6, false),
    mk('Sofía Ruiz', 'Gracias! Paso mañana por el showroom', 26, false),
    mk('Diego Funes', '¿Tienen financiación en cuotas fijas?', 50, false),
  ];
}
