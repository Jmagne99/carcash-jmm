// ============================================================
// GET /.netlify/functions/ig-comments
// Comentarios de las publicaciones recientes (para moderar) vía
// Graph API. Mapea al shape del front: [{ id, post, user, text, when, hidden }].
// Requiere instagram_manage_comments. Si falla, 5xx → el front cae a demo.
// Docs: https://developers.facebook.com/docs/instagram-api/guides/comment-moderation
// ============================================================
import { json } from './_lib/supabase.js';

const API = 'https://graph.facebook.com/v21.0';

export async function handler() {
  const token = process.env.META_ACCESS_TOKEN;
  const igId = process.env.META_INSTAGRAM_ACCOUNT_ID;
  if (!token || !igId) return json(503, { error: 'Instagram no configurado' });

  try {
    // 1) Últimas publicaciones con sus comentarios
    const url = `${API}/${igId}/media?limit=8`
      + `&fields=caption,comments.limit(15){text,username,timestamp,hidden}`
      + `&access_token=${token}`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);

    // 2) Aplanar: un item por comentario, con el texto del post como referencia
    const out = [];
    for (const m of d.data || []) {
      const postLabel = (m.caption || '').slice(0, 60) || 'Publicación';
      for (const c of m.comments?.data || []) {
        out.push({
          id: c.id,
          post: postLabel,
          user: c.username || 'usuario',
          text: c.text || '',
          when: c.timestamp,
          hidden: !!c.hidden,
        });
      }
    }
    // Más nuevos primero
    out.sort((a, b) => new Date(b.when) - new Date(a.when));

    return json(200, out);
  } catch (err) {
    return json(502, { error: 'Graph API: ' + (err.message || 'error') });
  }
}
