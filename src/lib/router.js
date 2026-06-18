// ============================================================
// CARCASH · ROUTER
// Hash-based router con carga dinámica de módulos.
//
// Cada ruta puede declarar:
//   - module: path al archivo JS del módulo
//   - component: si el módulo ya está cargado, el nombre del export que renderiza
//   - title: para breadcrumbs
//   - admin: true si solo debe verla dueño/gerente
// ============================================================

const ROUTES = new Map();
let currentMatch = null;

/**
 * Registra una ruta.
 *   register('/pipeline', { module: '/src/modules/pipeline.js', title: 'Pipeline' });
 *
 * Patterns admiten parámetros: '/pipeline/:id'
 */
export function register(pattern, def) {
  ROUTES.set(pattern, { pattern, ...def });
}

/** Devuelve { path, query } del location.hash actual */
export function parseHash() {
  const hash = location.hash.slice(1) || '/';
  const [path, query] = hash.split('?');
  const params = {};
  if (query) {
    query.split('&').forEach((p) => {
      const [k, v] = p.split('=');
      if (k) params[k] = decodeURIComponent(v || '');
    });
  }
  return { path: path || '/', queryParams: params };
}

/** Busca ruta que matchee el path. Devuelve { def, params } o null */
export function matchRoute(path) {
  // Match exacto
  if (ROUTES.has(path)) {
    return { def: ROUTES.get(path), params: {} };
  }

  // Match con parámetros
  for (const def of ROUTES.values()) {
    if (!def.pattern.includes(':')) continue;
    const patternParts = def.pattern.split('/');
    const pathParts = path.split('/');
    if (patternParts.length !== pathParts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(':')) {
        params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      } else if (patternParts[i] !== pathParts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { def, params };
  }
  return null;
}

/** Navega a un path */
export function navigate(path) {
  if (location.hash === '#' + path) {
    // misma ruta — forzar render
    runRouter();
    return;
  }
  location.hash = '#' + path;
}

/**
 * Carga módulo dinámicamente con cache.
 * Cada módulo debe exportar una función `mount(params, ctx)`.
 */
const moduleCache = new Map();
async function loadModule(path) {
  if (moduleCache.has(path)) return moduleCache.get(path);
  const mod = await import(path);
  moduleCache.set(path, mod);
  return mod;
}

/**
 * Ejecutor del router. Llamarlo en hashchange y al boot.
 */
export async function runRouter(ctx = {}) {
  const { path, queryParams } = parseHash();
  const match = matchRoute(path);

  if (!match) {
    if (ctx.onNotFound) ctx.onNotFound(path);
    return;
  }

  // Permisos admin: dueño/gerente solamente (configuración crítica, vault)
  if (match.def.admin && ctx.profile && !['dueno', 'gerente'].includes(ctx.profile.role)) {
    if (ctx.onForbidden) ctx.onForbidden(path);
    return;
  }

  // Permisos supervisor: dueño/gerente/supervisor (reportes, equipo, mi performance)
  if (match.def.supervisor && ctx.profile && !['dueno', 'gerente', 'supervisor'].includes(ctx.profile.role)) {
    if (ctx.onForbidden) ctx.onForbidden(path);
    return;
  }

  // Bloqueo para vendedor (rutas operativas: ventas, cobros, etc.)
  if (match.def.noSeller && ctx.profile?.role === 'vendedor') {
    if (ctx.onForbidden) ctx.onForbidden(path);
    return;
  }

  currentMatch = { ...match, path, queryParams };

  // Update sidebar active state
  document.querySelectorAll('.nav a[data-route]').forEach((a) => {
    const r = a.dataset.route;
    const isActive = r === path || (path.startsWith(r + '/') && r !== '/');
    a.classList.toggle('active', isActive);
  });

  // Cerrar sidebar mobile (si está abierta)
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('backdrop')?.classList.remove('open');

  // Hook before render (para breadcrumbs)
  if (ctx.beforeRender) ctx.beforeRender(currentMatch);

  // Cargar y montar el módulo
  if (match.def.module) {
    try {
      const mod = await loadModule(match.def.module);
      const mount = mod.mount || mod.default;
      if (typeof mount === 'function') {
        await mount({ ...match.params, ...queryParams }, ctx);
      } else {
        console.error('[Router] Módulo sin mount():', match.def.module);
      }
    } catch (err) {
      console.error('[Router] Error cargando módulo:', match.def.module, err);
      if (ctx.onError) ctx.onError(err, match.def);
    }
  } else if (typeof match.def.handler === 'function') {
    match.def.handler({ ...match.params, ...queryParams }, ctx);
  }
}

/** Devuelve el match actual */
export function current() {
  return currentMatch;
}

/** Lista de rutas registradas (para debug) */
export function list() {
  return Array.from(ROUTES.values());
}
