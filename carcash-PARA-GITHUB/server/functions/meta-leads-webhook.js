// ============================================================
// POST /.netlify/functions/meta-leads-webhook
// Lead Ads de Meta (Facebook/Instagram) → oportunidad nueva.
// origin='meta_ads'. Skeleton.
// ============================================================
import { admin, json } from './_lib/supabase.js';

export async function handler(event) {
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (q['hub.verify_token'] === process.env.META_VERIFY_TOKEN) {
      return { statusCode: 200, body: q['hub.challenge'] || '' };
    }
    return { statusCode: 403, body: 'forbidden' };
  }
  // === TODO: leer leadgen_id, GET a Graph API por los field_data,
  //          crear contacto + opportunity origin='meta_ads', source_campaign=ad_id.
  return json(200, { received: true });
}
