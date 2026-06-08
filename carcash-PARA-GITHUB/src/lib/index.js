// ============================================================
// CARCASH · LIB BARREL
// Re-export de todas las utilidades compartidas para que los
// módulos puedan importar cómodo:
//
//   import { supabase, state, fmt, el, $, $$, toast, navigate } from '../lib/index.js';
// ============================================================

export { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-client.js';
export { fmt, escapeHtml } from './formatters.js';
export {
  isValidDNI,
  isValidCUIT,
  isValidPlate,
  isValidPhone,
  isValidEmail,
  isValidCarYear,
  isValidAmount,
  isValidVIN,
  validate,
} from './validators.js';
export { $, $$, el, toast, confirmDialog, debounce, clear, injectStyles } from './dom.js';
export {
  register,
  navigate,
  parseHash,
  matchRoute,
  runRouter,
  current,
  list,
} from './router.js';
export {
  state,
  isAdmin,
  isOwner,
  isSupervisor,
  isSupervisorOrAdmin,
  isSeller,
  isBackOffice,
  currentUserId,
} from './state.js';
export { analyzeOpportunity, suggestReply, summarizeThread } from './ai.js';
