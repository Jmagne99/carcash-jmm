// ============================================================
// CARCASH · BOOTSTRAP
// Orquesta auth + router + carga de módulos.
// Cada módulo se registra en routes[] con su path al archivo JS.
// ============================================================

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './lib/supabase-client.js';
import { state, isAdmin, isSupervisorOrAdmin, isOwner, isSupervisor } from './lib/state.js';
import { fmt, escapeHtml } from './lib/formatters.js';
import { $, $$, el, toast, injectStyles } from './lib/dom.js';
import { register, navigate, runRouter, parseHash } from './lib/router.js';
import { startNotifications, stopNotifications } from './lib/notifications.js';

// ============================================================
// EXPORTAR API GLOBAL (para módulos legacy que usan window.CarCash)
// y para debugging desde la consola.
// ============================================================
window.CarCash = {
  supabase,
  state,
  fmt,
  escapeHtml,
  el,
  $, $$,
  toast,
  navigate,
  isAdmin,
};

// ============================================================
// REGISTRO DE RUTAS
// Cada ruta apunta al archivo del módulo (lazy-loaded).
// ============================================================
register('/', { handler: () => navigate('/tablero'), title: 'Tablero' });

register('/tablero', {
  module: '/src/modules/tablero.js',
  title: 'Tablero',
  num: '01',
});

register('/canal/:channel', {
  module: '/src/modules/canal.js',
  title: 'Canal',
  num: 'C',
});

register('/pipeline', {
  module: '/src/modules/pipeline.js',
  title: 'Pipeline',
  num: '02',
});

register('/pipeline/nueva', {
  module: '/src/modules/ficha-oportunidad.js',
  title: 'Nueva oportunidad',
  num: '02.0',
});

register('/pipeline/:id', {
  module: '/src/modules/ficha-oportunidad.js',
  title: 'Oportunidad',
  num: '02.1',
});

register('/bandeja', {
  module: '/src/modules/bandeja.js',
  title: 'Bandeja',
  num: '03',
});

register('/bandeja/:contactId', {
  module: '/src/modules/bandeja.js',
  title: 'Bandeja',
  num: '03.1',
});

register('/contactos', {
  module: '/src/modules/contactos.js',
  title: 'Contactos',
  num: '04',
});

register('/contactos/:id', {
  module: '/src/modules/contactos.js',
  title: 'Contacto',
  num: '04.1',
});

register('/agenda', {
  module: '/src/modules/agenda.js',
  title: 'Agenda',
  num: '05',
});

register('/mi-performance', {
  module: '/src/modules/mi-performance.js',
  title: 'Mi performance',
  num: '05.5',
});

register('/mi-performance/:vendedorId', {
  module: '/src/modules/mi-performance.js',
  title: 'Performance vendedor',
  num: '05.6',
  supervisor: true,
});

register('/unidades', {
  module: '/src/modules/unidades.js',
  title: 'Stock',
  num: '06',
});

register('/unidades/nueva', {
  module: '/src/modules/unidad-form.js',
  title: 'Nueva unidad',
  num: '06.0',
  admin: true,
});

register('/unidades/:id/editar', {
  module: '/src/modules/unidad-form.js',
  title: 'Editar unidad',
  num: '06.2',
  admin: true,
});

register('/unidades/:id', {
  module: '/src/modules/ficha-unidad.js',
  title: 'Unidad',
  num: '06.1',
});

register('/publicaciones', {
  module: '/src/modules/publicaciones.js',
  title: 'Publicaciones',
  num: '07',
  noSeller: true,
});

register('/consignaciones', {
  module: '/src/modules/consignaciones.js',
  title: 'Consignaciones',
  num: '08',
  noSeller: true,
});

register('/ventas', {
  module: '/src/modules/ventas.js',
  title: 'Ventas',
  num: '09',
  noSeller: true,
});

register('/ventas/nueva', {
  module: '/src/modules/ventas.js',
  title: 'Nueva venta',
  num: '09.0',
  noSeller: true,
});

register('/ventas/:id', {
  module: '/src/modules/ventas.js',
  title: 'Venta',
  num: '09.1',
  noSeller: true,
});

register('/documentacion', {
  module: '/src/modules/documentacion.js',
  title: 'Documentación',
  num: '10',
  noSeller: true,
});

register('/cobros', {
  module: '/src/modules/cobros.js',
  title: 'Cobros',
  num: '11',
  noSeller: true,
});

register('/reportes', {
  module: '/src/modules/reportes.js',
  title: 'Reportes',
  num: '12',
  supervisor: true,
});

register('/equipo', {
  module: '/src/modules/equipo.js',
  title: 'Equipo',
  num: '13',
  supervisor: true,
});

register('/estadisticas', {
  module: '/src/modules/estadisticas.js',
  title: 'Estadísticas equipo',
  num: '13.5',
  supervisor: true,
});

register('/meta-ads', {
  module: '/src/modules/meta-ads.js',
  title: 'Meta Ads',
  num: '13.7',
  supervisor: true,
});

register('/configuracion', {
  module: '/src/modules/configuracion.js',
  title: 'Configuración',
  num: '14',
  admin: true,
});

register('/usuarios', {
  module: '/src/modules/usuarios.js',
  title: 'Usuarios y roles',
  num: '17',
  admin: true,
});

register('/credenciales', {
  module: '/src/modules/credenciales.js',
  title: 'Vault credenciales',
  num: '16',
  admin: true,
});

register('/integraciones', {
  module: '/src/modules/integraciones.js',
  title: 'Integraciones',
  num: '15',
  admin: true,
});

register('/integraciones/:hub', {
  module: '/src/modules/integraciones.js',
  title: 'Integración',
  num: '15.1',
  admin: true,
});

// ============================================================
// AUTH FLOW
// ============================================================

async function checkAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  state.user = session.user;

  const { data: profile, error } = await supabase
    .from('users_profile')
    .select('*')
    .eq('id', session.user.id)
    .single();

  if (error) {
    console.error('Error loading profile:', error);
    return null;
  }
  if (!profile || !profile.active) {
    await supabase.auth.signOut();
    return null;
  }
  state.profile = profile;
  return profile;
}

async function login(email, password) {
  const errorEl = $('#login-error');
  const btn = $('#login-btn');
  btn.disabled = true;
  btn.textContent = 'Ingresando…';
  errorEl.classList.remove('show');

  try {
    const { data: authData, error: authError } =
      await supabase.auth.signInWithPassword({ email, password });

    if (authError) {
      console.error('[AUTH ERROR]', authError);
      if (authError.message === 'Invalid login credentials') {
        throw new Error('Email o contraseña incorrectos');
      }
      if (authError.message?.includes('Email not confirmed')) {
        throw new Error('Email no confirmado. Confirmalo en Supabase → Authentication → Users.');
      }
      throw new Error('Auth: ' + authError.message);
    }

    const { data: profile, error: profileError } = await supabase
      .from('users_profile')
      .select('*')
      .eq('id', authData.user.id)
      .single();

    if (profileError) {
      if (profileError.code === 'PGRST116') {
        throw new Error('No existe perfil para este usuario en users_profile.');
      }
      if (profileError.code === '42P01') {
        throw new Error('La tabla users_profile no existe. Hay que correr el schema.sql.');
      }
      throw new Error('Perfil: ' + (profileError.message || profileError.code));
    }
    if (!profile.active) {
      await supabase.auth.signOut();
      throw new Error('Este usuario está desactivado.');
    }

    state.user = authData.user;
    state.profile = profile;
    showApp();
  } catch (err) {
    console.error('[LOGIN FAIL]', err);
    errorEl.textContent = err.message;
    errorEl.classList.add('show');
    btn.disabled = false;
    btn.textContent = 'Ingresar';
  }
}

async function logout() {
  stopNotifications();
  await supabase.auth.signOut();
  state.user = null;
  state.profile = null;
  location.reload();
}

// ============================================================
// SHELL CONTROL
// ============================================================

function showLoading() {
  $('#loading').classList.remove('hidden');
  $('#login').classList.add('hidden');
  $('#app').classList.add('hidden');
}

function showLogin() {
  $('#loading').classList.add('hidden');
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

function showApp() {
  $('#loading').classList.add('hidden');
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');

  $('#avatar-initials').textContent = state.profile.avatar_initials || fmt.initials(state.profile.full_name);
  $('#avatar-name').textContent = state.profile.full_name;
  $('#avatar-role').textContent = (state.profile.role || '').toUpperCase();

  // Limpiar todas las clases de rol
  document.body.classList.remove('is-admin', 'is-vendedor', 'is-supervisor', 'is-owner', 'is-back');
  $('#avatar').classList.remove('is-admin');

  if (isOwner()) {
    document.body.classList.add('is-admin', 'is-owner');
    $('#avatar').classList.add('is-admin');
  } else if (state.profile.role === 'gerente') {
    document.body.classList.add('is-admin');
    $('#avatar').classList.add('is-admin');
  } else if (state.profile.role === 'supervisor') {
    document.body.classList.add('is-supervisor');
  } else if (state.profile.role === 'vendedor') {
    document.body.classList.add('is-vendedor');
  } else if (state.profile.role === 'admin_back') {
    document.body.classList.add('is-back');
  }

  // Arrancar polling de notificaciones
  startNotifications();

  // Cierre de mes idempotente: si el mes anterior quedó sin snapshot,
  // lo genera ahora. Así los objetivos/estadísticas quedan históricos
  // y los contadores del mes en curso arrancan de 0 cada mes.
  (async () => {
    try { await supabase.rpc('close_previous_month_if_pending'); }
    catch (e) { console.warn('close_previous_month_if_pending:', e?.message || e); }
  })();

  // Iniciar router con contexto
  routeOnce();
}

// ============================================================
// ROUTER CONTEXT
// ============================================================

// ============================================================
// MÓDULOS BLOQUEADOS (visibles pero no contratados)
// Para activar uno, sacalo de esta lista y (si corresponde) registrá su ruta.
// ============================================================
const LOCKED_ROUTES = ['/documentacion', '/cobros', '/financiero'];
const LOCKED_LABELS = { '/documentacion': 'Documentación', '/cobros': 'Cobros', '/financiero': 'Financiero' };
function isLocked(path) {
  return LOCKED_ROUTES.some((r) => path === r || path.startsWith(r + '/'));
}
function renderLocked(path) {
  const base = LOCKED_ROUTES.find((r) => path === r || path.startsWith(r + '/')) || path;
  const label = LOCKED_LABELS[base] || 'Módulo';
  state.route = path;
  updateCrumbs(path);
  document.querySelectorAll('.nav a[data-route]').forEach((a) => a.classList.toggle('active', a.dataset.route === base));
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('backdrop')?.classList.remove('open');
  const view = $('#view');
  view.innerHTML = '';
  view.appendChild(
    el('div', { class: 'placeholder' },
      el('div', { class: 'placeholder-content locked' },
        el('div', { class: 'placeholder-num' }, '\uD83D\uDD12 NO INCLUIDO'),
        el('div', { class: 'placeholder-title', html: `M\u00f3dulo <i>${escapeHtml(label)}</i>` }),
        el('div', { class: 'placeholder-desc' }, 'Este m\u00f3dulo no est\u00e1 incluido en tu plan actual. Lo pod\u00e9s activar cuando quieras sumarlo.'),
        el('div', { class: 'placeholder-status' }, 'DISPONIBLE PARA ACTIVAR')
      )
    )
  );
}

function routeOnce() {
  const { path } = parseHash();
  if (isLocked(path)) { renderLocked(path); return; }
  runRouter({
    profile: state.profile,
    beforeRender: ({ def, path }) => {
      state.route = path;
      updateCrumbs(path, def);
    },
    onNotFound: (path) => {
      renderPlaceholder('!', 'Página no encontrada', `La ruta "${path}" no existe.`, '404');
    },
    onForbidden: (path) => {
      renderPlaceholder('×', 'Acceso restringido', `La ruta "${path}" es solo para dueño / gerente.`, 'NO AUTORIZADO');
    },
    onError: (err, def) => {
      const notFound = err?.message?.includes('Failed to fetch dynamically') ||
                       err?.message?.includes('Failed to resolve module') ||
                       err?.message?.includes('404');
      renderPlaceholder(
        def?.num || '!',
        def?.title || 'Módulo',
        notFound
          ? `El módulo "${def?.title}" todavía no está implementado en el repo.`
          : `Error al cargar el módulo: ${err.message}`,
        notFound ? 'EN DESARROLLO' : 'ERROR'
      );
    },
  });
}

const CRUMB_LABELS = {
  tablero: 'Tablero',
  pipeline: 'Pipeline',
  bandeja: 'Bandeja',
  contactos: 'Contactos',
  agenda: 'Agenda',
  unidades: 'Stock',
  publicaciones: 'Publicaciones',
  consignaciones: 'Consignaciones',
  ventas: 'Ventas',
  documentacion: 'Documentación',
  cobros: 'Cobros',
  reportes: 'Dashboard',
  equipo: 'Equipo',
  configuracion: 'Configuración',
  usuarios: 'Usuarios',
  integraciones: 'Integraciones',
  nueva: 'Nueva',
  canal: 'Canales',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  mercadolibre: 'Mercado Libre',
};

function updateCrumbs(path) {
  const crumbs = $('#crumbs');
  crumbs.innerHTML = '';
  const parts = path.split('/').filter(Boolean);
  parts.forEach((p, i) => {
    if (i > 0) crumbs.appendChild(el('span', { class: 'sep' }, '/'));
    const label = CRUMB_LABELS[p] || p.toUpperCase();
    if (i === parts.length - 1) {
      crumbs.appendChild(el('b', {}, label));
    } else {
      crumbs.appendChild(el('a', { dataset: { route: '/' + parts.slice(0, i + 1).join('/') } }, label));
    }
  });
}

function renderPlaceholder(num, title, desc, status) {
  const view = $('#view');
  view.innerHTML = '';
  view.appendChild(
    el('div', { class: 'placeholder' },
      el('div', { class: 'placeholder-content' },
        el('div', { class: 'placeholder-num' }, `MÓDULO ${num}`),
        el('div', { class: 'placeholder-title', html: escapeHtml(title).replace(/\b(\w+)$/, '<i>$1</i>') }),
        el('div', { class: 'placeholder-desc' }, desc),
        el('div', { class: 'placeholder-status' }, status)
      )
    )
  );
}

// Exponer a CarCash global
window.CarCash.renderPlaceholder = renderPlaceholder;
window.CarCash.routeOnce = routeOnce;

// ============================================================
// EVENT LISTENERS DE LA SHELL
// ============================================================

function attachShellHandlers() {
  // Login form
  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const email = $('#login-email').value.trim();
    const password = $('#login-password').value;
    login(email, password);
  });

  // Sidebar / breadcrumb links (delegation)
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-route]');
    if (link) {
      e.preventDefault();
      navigate(link.dataset.route);
    }
  });

  // Mobile menu
  $('#menuBtn').addEventListener('click', () => {
    $('#sidebar').classList.toggle('open');
    $('#backdrop').classList.toggle('open');
  });
  $('#backdrop').addEventListener('click', () => {
    $('#sidebar').classList.remove('open');
    $('#backdrop').classList.remove('open');
  });

  // Avatar dropdown
  $('#avatar').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#avatar-menu').classList.toggle('open');
  });
  document.addEventListener('click', () => {
    $('#avatar-menu').classList.remove('open');
  });
  $('#logout-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    logout();
  });

  // FAB: agregar cliente / lead (siempre a mano)
  const fabWrap = $('#fab-wrap');
  $('#fab-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    fabWrap.classList.toggle('open');
  });
  $('#fab-menu')?.addEventListener('click', (e) => {
    const item = e.target.closest('[data-fab]');
    if (!item) return;
    fabWrap.classList.remove('open');
    if (item.dataset.fab === 'lead') navigate('/pipeline/nueva');
    else navigate('/contactos?new=1');
  });
  document.addEventListener('click', () => fabWrap?.classList.remove('open'));

  // Hash change
  window.addEventListener('hashchange', routeOnce);
}

// ============================================================
// INIT
// ============================================================

// ============================================================
// RUTAS PÚBLICAS (no requieren auth, se renderizan standalone)
// Patrón: #/u/<unit_code>
// ============================================================
function isPublicRoute(hash) {
  const path = (hash || location.hash).slice(1) || '/';
  return /^\/u\/[^/]+/i.test(path);
}

async function mountPublicRoute() {
  const hash = location.hash.slice(1) || '/';
  const m = hash.match(/^\/u\/([^/?#]+)/i);
  if (!m) return;
  const code = decodeURIComponent(m[1]);
  // Importar dinámicamente para que no afecte el bundle del CRM
  try {
    const mod = await import('/src/modules/unidad-publica.js');
    await (mod.mount || mod.default)({ code });
  } catch (err) {
    console.error('Error cargando vista pública', err);
    document.body.innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui;color:#6E6B65;padding:20px;text-align:center">
        <div>
          <h2 style="font-family:serif;font-weight:300">Error cargando la unidad</h2>
          <p>${err.message}</p>
        </div>
      </div>
    `;
  }
}

(async function init() {
  // CHECK: ruta pública → bypass auth completo
  if (isPublicRoute()) {
    await mountPublicRoute();
    // Re-mount al cambiar el hash (por si navegan entre unidades públicas)
    window.addEventListener('hashchange', () => {
      if (isPublicRoute()) mountPublicRoute();
      else location.reload(); // saliendo de pública → recarga al CRM
    });
    return;
  }

  attachShellHandlers();

  // Verificar credenciales
  if (
    !SUPABASE_URL ||
    SUPABASE_URL.includes('TU-PROJECT-REF') ||
    !SUPABASE_ANON_KEY ||
    SUPABASE_ANON_KEY.includes('TU-ANON-KEY')
  ) {
    $('#loading').innerHTML = `
      <div class="loading-logo">Car<b>Cash</b></div>
      <div style="max-width: 400px; text-align: center; padding: 20px; border: 1px solid #D6D2CA; background: white; margin-top: 20px;">
        <div style="font-weight: 500; color: #E3050C; margin-bottom: 8px;">Configuración pendiente</div>
        <div style="font-size: 12px; color: #6E6B65; line-height: 1.6;">
          Completá las credenciales de Supabase en <code>public/src/lib/supabase-client.js</code>
          o en <code>window.__CARCASH_CONFIG__</code> antes de cargar este script.
        </div>
      </div>
    `;
    return;
  }

  const profile = await checkAuth();
  if (profile) {
    showApp();
  } else {
    showLogin();
  }
})();
