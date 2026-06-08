// ============================================================
// CARCASH · META ADS (Marketing API)
// Métricas de campañas de Meta (Facebook/Instagram Ads) e info de
// Lead Ads. Server-side vía Edge Function; mock hasta conectar.
// ============================================================

import { supabase } from './supabase-client.js';

export async function fetchMetaAds(period = '30d') {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  try {
    const res = await fetch(`/.netlify/functions/meta-ads-insights?period=${encodeURIComponent(period)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    // En el deploy estático la function cae al redirect SPA (HTML 200);
    // validamos que sea JSON real, si no caemos al mock.
    const isJsonOk = res.ok && (res.headers.get('content-type') || '').includes('application/json');
    if (!isJsonOk) return mockAds(period);
    return await res.json();
  } catch {
    return mockAds(period);
  }
}

function mockAds(period) {
  // Todo en USD para ser coherente con el resto del CRM (precios y ventas en USD).
  const campaigns = [
    { name: '0km — Lead Ads', status: 'activa', objective: 'Generación de clientes', spend: 9800, impressions: 142000, clicks: 3120, leads: 86 },
    { name: 'Usados Premium — Tráfico', status: 'activa', objective: 'Tráfico', spend: 5200, impressions: 98500, clicks: 2410, leads: 31 },
    { name: 'Remarketing visitantes', status: 'activa', objective: 'Conversiones', spend: 3100, impressions: 54000, clicks: 1880, leads: 44 },
    { name: 'Financiación — Reels', status: 'pausada', objective: 'Reproducciones', spend: 1900, impressions: 121000, clicks: 990, leads: 12 },
  ].map(c => ({ ...c, cpl: c.leads ? Math.round(c.spend / c.leads) : 0, ctr: +(c.clicks / c.impressions * 100).toFixed(2) }));

  const spend = campaigns.reduce((a, c) => a + c.spend, 0);       // USD
  const leads = campaigns.reduce((a, c) => a + c.leads, 0);
  const impressions = campaigns.reduce((a, c) => a + c.impressions, 0);
  const clicks = campaigns.reduce((a, c) => a + c.clicks, 0);
  const sales = 9;                              // ventas atribuidas (demo)
  const avgTicket = 32000;                      // USD (demo)
  const revenueUsd = sales * avgTicket;         // USD
  const marginPct = 0.12;                       // retorno sobre margen, más realista
  const marginUsd = Math.round(revenueUsd * marginPct);

  return {
    _mock: true,
    period,
    totals: {
      spend, impressions, clicks, leads,        // todo USD
      cpl: leads ? Math.round(spend / leads) : 0,
      ctr: +(clicks / impressions * 100).toFixed(2),
      sales, revenue_usd: revenueUsd, margin_usd: marginUsd,
      // ROAS sobre margen / inversión (ambos en USD) → número realista
      roas: spend ? +(marginUsd / spend).toFixed(1) : 0,
    },
    campaigns,
  };
}
