// ============================================================
// CARCASH · STATE GLOBAL
// Estado en memoria compartido entre módulos.
// Pequeño y explícito — sin librería de estado.
// ============================================================

export const state = {
  user: null,            // auth.users (de Supabase)
  profile: null,         // public.users_profile (rol, etc.)
  route: null,           // path actual
  params: {},            // parámetros de ruta
  cache: {},             // cache temporal por módulo
};

// Útil para debug en consola
window.state = state;

/**
 * Helpers de rol
 *
 * Jerarquía:
 *   dueno → ve TODO + puede modificar todo + costos/margen + histórico completo
 *   gerente → ve todo el negocio operativo (sin algunos accesos críticos)
 *   supervisor → ve equipo + setea objetivos a vendedores, pero no Vault/Integraciones/Config
 *   admin_back → operaciones (ventas, docs, cobros)
 *   vendedor → solo lo suyo
 */
export function isAdmin() {
  return ['dueno', 'gerente'].includes(state.profile?.role);
}

/** Solo dueño: histórico completo, costos, configuración crítica */
export function isOwner() {
  return state.profile?.role === 'dueno';
}

/** Supervisor + admin: ve equipo y setea objetivos */
export function isSupervisorOrAdmin() {
  return ['dueno', 'gerente', 'supervisor'].includes(state.profile?.role);
}

export function isSupervisor() {
  return state.profile?.role === 'supervisor';
}

export function isSeller() {
  return state.profile?.role === 'vendedor';
}

export function isBackOffice() {
  return state.profile?.role === 'admin_back';
}

export function currentUserId() {
  return state.profile?.id || null;
}
