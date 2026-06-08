// ============================================================
// CARCASH · AI WRAPPER
// Cliente del frontend para invocar las Edge Functions de IA
// (no llamamos directamente a Anthropic desde el browser por
// seguridad de la API key — pasa por /netlify/functions/ai-*)
// ============================================================

import { supabase } from './supabase-client.js';

/**
 * Invoca la edge function de análisis de oportunidad.
 * Devuelve { score, a_favor[], riesgos[], sugerencia, next_action }
 */
export async function analyzeOpportunity(opportunityId) {
  return invokeFunction('ai-analyze', { opportunity_id: opportunityId });
}

/**
 * Genera un borrador de respuesta para un mensaje del cliente.
 *   ctx: { contact, opportunity, last_messages[], goal }
 */
export async function suggestReply(ctx) {
  return invokeFunction('ai-suggest-reply', ctx);
}

/**
 * Resume un hilo / serie de mensajes.
 */
export async function summarizeThread(messages) {
  return invokeFunction('ai-summarize', { messages });
}

/**
 * Helper genérico para llamar functions de Netlify.
 * Anti-pattern de seguridad: NO inyectar API keys del lado del cliente.
 */
async function invokeFunction(name, payload) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

  try {
    const res = await fetch(`/.netlify/functions/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    // En el deploy estático la function cae al redirect SPA (HTML 200);
    // si no es JSON real, tratamos como "no disponible" → mock.
    const isJsonOk = res.ok && (res.headers.get('content-type') || '').includes('application/json');
    if (!isJsonOk) {
      console.warn(`[AI stub] ${name} — function no disponible (no-JSON/${res.status}), devolviendo mock`);
      return mockResponse(name, payload);
    }
    return await res.json();
  } catch (err) {
    // Cualquier fallo (function no deployada, red, JSON inválido) → mock,
    // así la UI nunca se rompe en la demo.
    console.warn(`[AI stub] ${name} — ${err.message}, devolviendo mock`);
    return mockResponse(name, payload);
  }
}

/**
 * Respuestas mock para desarrollo local sin Edge Functions.
 * Mantienen la misma forma que las reales.
 */
function mockResponse(name, payload) {
  switch (name) {
    case 'ai-analyze':
      return {
        score: 72,
        a_favor: [
          'El cliente ya respondió en menos de 2 horas',
          'Consultó por una unidad disponible y publicada',
          'Mencionó que tiene auto en permuta',
        ],
        riesgos: [
          'No mencionó forma de pago',
          'No contestó el último mensaje hace 8 horas',
        ],
        sugerencia:
          'Reenviar foto del interior y proponer una visita al showroom para mañana al mediodía.',
        next_action: {
          title: 'Llamar para coordinar visita',
          due_in_hours: 4,
        },
        _mock: true,
      };
    case 'ai-suggest-reply':
      return {
        reply: 'Hola! Gracias por la consulta. Te confirmo que la unidad está disponible. ¿Te queda cómodo coordinar una visita al showroom en CABA esta semana?',
        tone: 'profesional-cercano',
        _mock: true,
      };
    case 'ai-summarize':
      return {
        summary: 'El cliente consulta por una unidad publicada en ML, pidió fotos adicionales del interior y mencionó que tiene auto en permuta.',
        sentiment: 'positivo',
        _mock: true,
      };
    default:
      return { _mock: true };
  }
}
