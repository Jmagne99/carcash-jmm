// ============================================================
// CARCASH · DOM HELPERS
// Utilidades de manipulación de DOM sin frameworks
// ============================================================

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * Crea un elemento DOM con props y children.
 *
 *   el('div', { class: 'card', dataset: { id: 1 } },
 *     el('h2', {}, 'Título'),
 *     el('p', { html: '<i>texto</i>' })
 *   )
 *
 * Props especiales:
 *   class    → className
 *   html     → innerHTML
 *   onClick  → addEventListener('click', ...)
 *   style    → Object.assign(style, ...)
 *   dataset  → Object.assign(dataset, ...)
 *   ref      → callback con el nodo
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'ref' && typeof v === 'function') v(node);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (typeof v === 'boolean') {
      if (v) node.setAttribute(k, '');
    } else {
      node.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    if (typeof c === 'string' || typeof c === 'number') {
      node.appendChild(document.createTextNode(String(c)));
    } else {
      node.appendChild(c);
    }
  }
  return node;
}

/**
 * Toast/notificación efímera.
 *   toast('Guardado', 'Cambios persistidos', 'ok');
 *
 * type: 'info' | 'ok' | 'error' | 'warn'
 */
export function toast(title, desc, type = 'info') {
  let host = $('#toasts');
  if (!host) {
    host = el('div', { id: 'toasts' });
    document.body.appendChild(host);
  }
  const node = el('div', { class: `toast ${type}` },
    el('div', { class: 'toast-body' },
      el('div', { class: 'toast-title' }, title),
      desc ? el('div', { class: 'toast-desc' }, desc) : null
    )
  );
  host.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateX(20px)';
    node.style.transition = 'all .25s ease';
    setTimeout(() => node.remove(), 300);
  }, 3500);
}

/** Confirm modal simple, devuelve Promise<boolean> */
export function confirmDialog(message, { okText = 'Confirmar', cancelText = 'Cancelar' } = {}) {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const modal = el('div', { class: 'modal modal-confirm' },
      el('div', { class: 'modal-body' }, message),
      el('div', { class: 'modal-actions' },
        el('button', {
          class: 'btn btn-ghost',
          onClick: () => { close(false); }
        }, cancelText),
        el('button', {
          class: 'btn',
          onClick: () => { close(true); }
        }, okText),
      )
    );
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    function close(value) {
      backdrop.remove();
      resolve(value);
    }
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(false);
    });
  });
}

/** Debounce simple */
export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Empty a node */
export function clear(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Inyecta una hoja de estilos del módulo (idempotente por id)
 */
export function injectStyles(id, css) {
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}
