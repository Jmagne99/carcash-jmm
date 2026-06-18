// ============================================================
// POST /.netlify/functions/ig-comment-action
// Acciones sobre un comentario de Instagram (moderación real):
//   Body: { comment_id, action: 'reply' | 'hide' | 'unhide', message? }
//   - 'reply'  : responde públicamente al comentario.
//   - 'hide'   : oculta el comentario en el post.
//   - 'unhide' : lo vuelve a mostrar.
// Requiere instagram_manage_comments y que el comentario sea de un
// post de la cuenta propia. Docs:
// https://developers.facebook.com/docs/instagram-api/guides/comment-moderation
// ============================================================
import { json } from './_lib/supabase.js';

const API = 'https://graph.facebook.com/v21.0';

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  let p; try { p = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'JSON inválido' }); }
  const { comment_id, action } = p;
  if (!comment_id || !action) return json(400, { error: 'comment_id y action requeridos' });

  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return json(503, { error: 'Instagram no configurado' });

  try {
    if (action === 'reply') {
      const message = (p.message || '').trim();
      if (!message) return json(400, { error: 'message requerido para responder' });
      const url = `${API}/${encodeURIComponent(comment_id)}/replies`
        + `?message=${encodeURIComponent(message)}&access_token=${token}`;
      const r = await fetch(url, { method: 'POST' });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      return json(200, { ok: true, action, reply_id: d.id });
    }

    if (action === 'hide' || action === 'unhide') {
      const hide = action === 'hide';
      const url = `${API}/${encodeURIComponent(comment_id)}`
        + `?hide=${hide}&access_token=${token}`;
      const r = await fetch(url, { method: 'POST' });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      return json(200, { ok: true, action, hidden: hide });
    }

    return json(400, { error: 'action inválida (reply | hide | unhide)' });
  } catch (err) {
    return json(502, { error: 'Graph API: ' + (err.message || 'error') });
  }
}
