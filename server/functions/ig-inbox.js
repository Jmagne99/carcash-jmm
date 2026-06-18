// ============================================================
// GET /.netlify/functions/ig-inbox
// Inbox de DMs de Instagram vía Graph API (Conversations).
// Mapea al shape que consume el front: [{ name, last, when, unread }].
// Requiere META_PAGE_ID (la página de FB vinculada) y el token con
// permiso instagram_manage_messages. Si falla, 5xx → el front cae a demo.
// Docs: https://developers.facebook.com/docs/messenger-platform/instagram/features/conversations
// ============================================================
import { json } from './_lib/supabase.js';

const API = 'https://graph.facebook.com/v21.0';

export async function handler() {
  const token = process.env.META_ACCESS_TOKEN;
  const pageId = process.env.META_PAGE_ID || process.env.META_INSTAGRAM_ACCOUNT_ID;
  if (!token || !pageId) return json(503, { error: 'Instagram no configurado' });

  try {
    const url = `${API}/${pageId}/conversations?platform=instagram`
      + `&fields=updated_time,unread_count,participants,messages.limit(1){message,from,created_time}`
      + `&limit=20&access_token=${token}`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);

    const inbox = (d.data || []).map((c) => {
      const other = (c.participants?.data || []).find((p) => String(p.id) !== String(pageId)) || {};
      const last = c.messages?.data?.[0];
      return {
        id: c.id,
        name: other.username || other.name || 'Usuario IG',
        last: last?.message || '',
        when: last?.created_time || c.updated_time,
        unread: (c.unread_count || 0) > 0,
      };
    });

    return json(200, inbox);
  } catch (err) {
    return json(502, { error: 'Graph API: ' + (err.message || 'error') });
  }
}
