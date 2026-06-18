// ============================================================
// CARCASH · ALERTAS DE CONTACTO 24/48/72hs
// Calcula nivel de alerta por horas sin contactar al cliente.
// Los umbrales se leen de settings.alerts_rules (configurable).
// ============================================================

import { supabase } from './supabase-client.js';

let cachedThresholds = null;

export const DEFAULT_THRESHOLDS = {
  warn: 24,    // amarillo
  warn2: 48,   // naranja
  danger: 72,  // rojo
  cold: 96,    // lead frío (4 días)
};

/** Carga los umbrales desde settings (con fallback a defaults) */
export async function loadThresholds() {
  if (cachedThresholds) return cachedThresholds;
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'alerts_rules')
    .maybeSingle();
  const v = data?.value || {};
  cachedThresholds = {
    warn: v.contact_alert_hours_warn ?? DEFAULT_THRESHOLDS.warn,
    warn2: v.contact_alert_hours_warn2 ?? DEFAULT_THRESHOLDS.warn2,
    danger: v.contact_alert_hours_danger ?? DEFAULT_THRESHOLDS.danger,
    cold: v.contact_alert_hours_cold ?? DEFAULT_THRESHOLDS.cold,
  };
  return cachedThresholds;
}

/** Para forzar recarga después de cambiar config */
export function invalidateThresholds() {
  cachedThresholds = null;
}

/** Devuelve el nivel: 'ok' | 'warn' | 'warn2' | 'danger' */
export function levelForHours(hours, thresholds = DEFAULT_THRESHOLDS) {
  if (hours == null) return 'ok';
  if (hours >= thresholds.danger) return 'danger';
  if (hours >= thresholds.warn2) return 'warn2';
  if (hours >= thresholds.warn) return 'warn';
  return 'ok';
}

export const LEVEL_LABELS = {
  ok: '',
  warn: '24h sin contacto',
  warn2: '48h sin contacto',
  danger: '72h+ sin contacto',
};

export const LEVEL_COLORS = {
  ok: 'transparent',
  warn: 'var(--cc-warn)',         // amarillo/naranja
  warn2: '#FF8C42',               // naranja intenso
  danger: 'var(--cc-danger)',     // rojo
};

/** Trae oportunidades con sus horas sin contactar */
export async function fetchOpportunitiesWithAlerts(filters = {}) {
  let q = supabase
    .from('opportunities_with_contact_alerts')
    .select(`
      id, opp_code, contact_id, assigned_to, stage, origin, expected_amount,
      next_action_title, next_action_due_at, next_action_done, ai_score,
      hours_since_contact, last_contact_at, created_at,
      contact:contacts!contact_id(id, full_name, phone, email),
      unit:units!unit_of_interest_id(brand, model, year),
      assignee:users_profile!assigned_to(full_name)
    `)
    .order('hours_since_contact', { ascending: false });

  if (filters.assigned_to) q = q.eq('assigned_to', filters.assigned_to);
  if (filters.minHours != null) q = q.gte('hours_since_contact', filters.minHours);

  const { data, error } = await q;
  if (error) {
    console.error('contact alerts fetch error', error);
    return [];
  }
  return data || [];
}

/** Agrupa una lista por nivel de alerta */
export function groupByLevel(opps, thresholds) {
  const groups = { warn: [], warn2: [], danger: [], ok: [] };
  for (const o of opps) {
    const level = levelForHours(o.hours_since_contact, thresholds);
    groups[level].push(o);
  }
  return groups;
}
