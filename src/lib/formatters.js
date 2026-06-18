// ============================================================
// CARCASH · FORMATTERS
// Funciones puras para formatear datos en UI (es-AR, USD interno)
// ============================================================

const TZ = 'America/Argentina/Buenos_Aires';

export const fmt = {
  // ----------------------------------------------------------
  // MONTOS
  // ----------------------------------------------------------
  /** USD sin decimales: 1234567 → "1,234,567" */
  usd(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return new Intl.NumberFormat('en-US', {
      style: 'decimal',
      maximumFractionDigits: 0,
    }).format(n);
  },

  /** USD con prefijo: 1234567 → "USD 1,234,567" */
  usdLabel(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return 'USD ' + fmt.usd(n);
  },

  /** Pesos argentinos: 1234567 → "$1.234.567" */
  ars(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      maximumFractionDigits: 0,
    }).format(n);
  },

  /** Porcentaje: 0.123 → "12.3%" o 12.3 → "12.3%" (acepta ambas) */
  pct(n, decimals = 1) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    // Si viene en decimal (0..1), multiplico
    const v = Math.abs(n) <= 1 ? n * 100 : n;
    return v.toFixed(decimals) + '%';
  },

  /** Number compacto: 12500 → "12.5k", 1500000 → "1.5M" */
  compact(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(n);
  },

  // ----------------------------------------------------------
  // FECHAS
  // ----------------------------------------------------------
  /** "27 abr 2026" */
  dateAR(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('es-AR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: TZ,
    });
  },

  /** "27/04/2026" */
  dateShortAR(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: TZ,
    });
  },

  /** "10:24" */
  timeAR(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleTimeString('es-AR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: TZ,
    });
  },

  /** "27 abr 2026 · 10:24" */
  datetime(iso) {
    if (!iso) return '—';
    return fmt.dateAR(iso) + ' · ' + fmt.timeAR(iso);
  },

  /** "hace 5m", "hace 3h", "hace 2d", "27 abr 2026" */
  relative(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    const diff = Date.now() - d.getTime();
    const future = diff < 0;
    const abs = Math.abs(diff);
    const mins = Math.floor(abs / 60000);
    if (mins < 1) return future ? 'ya' : 'ahora';
    if (mins < 60) return future ? `en ${mins}m` : `hace ${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return future ? `en ${hrs}h` : `hace ${hrs}h`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return future ? `en ${days}d` : `hace ${days}d`;
    return fmt.dateAR(iso);
  },

  /** Devuelve string "hoy", "mañana", "ayer", o dateAR */
  dayLabel(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    const today = new Date();
    const startOfDay = (date) =>
      new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const a = startOfDay(d);
    const b = startOfDay(today);
    const diffDays = Math.round((a - b) / 86400000);
    if (diffDays === 0) return 'hoy';
    if (diffDays === 1) return 'mañana';
    if (diffDays === -1) return 'ayer';
    if (diffDays > 0 && diffDays < 7) {
      return d.toLocaleDateString('es-AR', { weekday: 'long', timeZone: TZ });
    }
    return fmt.dateAR(iso);
  },

  // ----------------------------------------------------------
  // STRINGS
  // ----------------------------------------------------------
  /** Trunca a N chars con "…" */
  truncate(str, max = 60) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  },

  /** Iniciales del nombre: "Juan Carlos Pérez" → "JC" */
  initials(name) {
    if (!name) return '··';
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() || '')
      .join('');
  },

  /** Capitalize primera letra */
  cap(str) {
    if (!str) return '';
    return str[0].toUpperCase() + str.slice(1);
  },

  /** snake_case → "Snake Case" */
  humanize(str) {
    if (!str) return '';
    return str
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  },

  /** Teléfono argentino visible: "+5491145678901" → "+54 9 11 4567-8901" */
  phone(raw) {
    if (!raw) return '—';
    const digits = String(raw).replace(/\D/g, '');
    if (digits.length === 13 && digits.startsWith('549')) {
      // +54 9 XX XXXX-XXXX
      return `+54 9 ${digits.slice(3, 5)} ${digits.slice(5, 9)}-${digits.slice(9)}`;
    }
    if (digits.length === 11 && digits.startsWith('54')) {
      return `+54 ${digits.slice(2, 4)} ${digits.slice(4, 8)}-${digits.slice(8)}`;
    }
    if (digits.length === 10) {
      return `${digits.slice(0, 2)} ${digits.slice(2, 6)}-${digits.slice(6)}`;
    }
    return raw;
  },

  /** DNI: 12345678 → "12.345.678" */
  dni(raw) {
    if (!raw) return '—';
    const digits = String(raw).replace(/\D/g, '');
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  },

  /** CUIT: 30123456789 → "30-12345678-9" */
  cuit(raw) {
    if (!raw) return '—';
    const digits = String(raw).replace(/\D/g, '');
    if (digits.length !== 11) return raw;
    return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
  },

  /** Patente: "AB123CD" o "ABC123" — devuelve uppercase con guión */
  plate(raw) {
    if (!raw) return '—';
    return String(raw).toUpperCase().replace(/\s/g, '');
  },

  /** Kilómetros: 123456 → "123.456 km" */
  km(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return new Intl.NumberFormat('es-AR').format(n) + ' km';
  },
};

/** Helper para escapar HTML en strings que vienen de la base */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m]));
}
