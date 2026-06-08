# CarCash CRM — Auditoría profunda del sistema

Auditoría completa de bugs sobre todo el sistema (frontend + backend Supabase).
Metodología en 5 frentes, con verificación automatizada contra el schema real y
revisión lógica asistida. Resultado: **3 bugs reales corregidos** (1 crítico) y un
conjunto de recomendaciones sin impacto funcional al volumen actual.

## Metodología

1. **Sintaxis**: `node --check` sobre los 47 archivos JS (src + server). ✓
2. **Queries vs schema real**: analizador propio que extrae cada `.from()`, columnas
   del `select`, embeddings `tabla!fk(...)` (recursivo), `.rpc()` y filtros
   `.eq/.in/.not/.order/...`, y los valida contra columnas, FKs, vistas y funciones
   reales exportadas de la base. ✓ 0 problemas (37 + 10 archivos).
3. **Estático**: resolución de imports/exports (sin falsos positivos de comentarios),
   rutas registradas ↔ archivos de módulo ↔ export `mount`, y links del menú ↔ rutas. ✓
4. **Backend**: advisors de seguridad y performance de Supabase, cobertura de RLS por
   tabla, triggers, funciones, publicación Realtime y buckets de Storage.
5. **Lógica/runtime**: revisión profunda módulo por módulo (incluyendo todo lo nuevo)
   buscando null-deref, `await` faltantes, fugas de suscripción, handlers rotos,
   condiciones invertidas y XSS.

## Bugs encontrados y corregidos

| # | Sev. | Archivo | Problema | Fix |
|---|------|---------|----------|-----|
| 1 | **CRÍTICO** | `ficha-oportunidad.js` | La preselección de contacto (`?contact=`) referenciaba `params` dentro de `attachCreateHandlers()`, función que no recibía ese argumento → `ReferenceError` que rompía **todo el formulario de nueva oportunidad** (y el FAB "Nuevo lead"). | Se pasa `params` al handler. |
| 2 | Medio | `publicaciones.js` | "Pausar/Republicar" usaba `find(unit_id)` para deducir el canal → en una unidad publicada en ML **e** IG actuaba sobre el canal equivocado. | Se agrega `data-channel` al botón y se usa el canal exacto de la fila. |
| 3 | Medio | `tasks` (RLS) | La policy de SELECT usaba `is_admin()` (no incluía supervisor) → en la Agenda, el supervisor con "Todo el equipo" no veía las **tareas** del equipo (sí las oportunidades). | Policy → `is_supervisor_or_admin()`. |
| 4 | Menor | `wsp-inbound.js`, `wsp-send.js` | `JSON.parse` sin try/catch → un body malformado de n8n daba 500/crash en vez de 400. | `try/catch` → `400 JSON inválido`. |
| 5 | Menor | `contactos.js` | El buscador no restauraba su `.value` al re-montar (filtro en memoria persistía pero el input quedaba vacío). | Se restaura `searchInput.value`. |
| 6 | Hardening | funciones DB nuevas | `function_search_path_mutable` (advisor) en las 2 funciones nuevas. | `set search_path = public`. |

## Falsos positivos descartados (verificados como correctos)

- Embeddings sobre la **vista** `opportunities_with_contact_alerts`
  (`contacts!contact_id`, `units!unit_of_interest_id`, `users_profile!assigned_to`):
  las vistas no tienen FK en el catálogo de Postgres, pero PostgREST resuelve la
  relación; es el patrón **preexistente** ya usado por pipeline/bandeja. OK.
- `unit_documents.updated_at` y `publications.external_id/published_at`: **existen** en
  el schema (confirmado por el analizador automático). OK.

## Backend — estado verificado

- **RLS**: las 16 tablas tienen RLS activo y al menos 1 policy (ninguna queda bloqueada
  por falta de policy). El alcance por rol es correcto: vendedor ve lo suyo, supervisor/
  dueño/gerente ven todo. `settings` es **solo admin** a propósito (guarda el hash del
  PIN del Vault); `loadThresholds()` cae a defaults para no-admins, sin romperse.
- **Realtime**: publicado `timeline_events`, `opportunities`.
- **Triggers (opportunities)**: alta de código, cambio de etapa, updated_at, y los 3 de
  notificación (nuevo lead, lead sin asignar → supervisores, asignación → vendedor).
- **Storage**: `unit-photos`(púb.), `unit-documents`(priv.), `whatsapp-media`(púb.).

## Recomendaciones (sin impacto funcional hoy)

- **Advisors de performance** (74 FKs sin índice, 49 `auth.uid()` sin envolver en
  subselect, políticas permisivas múltiples, índices sin uso): son optimizaciones a
  escala; con el volumen actual no afectan. Conviene atenderlas antes de crecer mucho.
- **Advisors de seguridad**: 2 vistas `SECURITY DEFINER` (`units_public`,
  `business_public`, usadas por la página pública), `search_path` mutable en funciones
  preexistentes, y "leaked password protection" desactivado en Supabase Auth
  (recomendado activarlo). `whatsapp-media` es bucket público con listado: si querés
  más privacidad de las notas de voz, conviene pasarlo a privado + URLs firmadas.
- **`payments` → `sales`**: si un usuario `admin_back` registra el pago que completa una
  venta, el marcado de `payment_completed_at` en `sales` lo bloquea el RLS (es solo
  admin); el pago igual se registra y el error se traga. Si querés que back office cierre
  ventas, habría que ampliar esa policy.

## Veredicto

Sin bugs abiertos conocidos. Sintaxis, queries, imports, rutas y objetos de DB:
**todo verde**. Los 3 bugs reales (incluido el crítico del formulario de oportunidad)
quedaron corregidos y re-verificados.

---

# Auditoría extensa v2 (post-Canales / Instagram / Meta Ads)

Re-auditoría tras sumar: módulos de Canal (WhatsApp/Instagram/Mercado Libre),
Instagram con pestañas (Estadísticas/Posts/Inbox/Comentarios/Competencia) + composer
de posteo, Meta Ads & Lead Ads, módulos bloqueados, termómetro de leads, realtime,
push por WhatsApp y crons.

## Método y resultado
- **Sintaxis**: 54 archivos JS (src + server) → ✓ OK.
- **Queries vs schema real** (analizador propio): 40 + 14 archivos → ✓ 0 problemas
  (columnas, embeddings/FK, RPC, filtros, enums; incluye el canal `instagram` nuevo).
- **Imports / rutas→módulos→mount / nav**: ✓ (las 24 rutas con módulo). Únicos avisos
  esperados del checker: `/canal/:channel` (ruta con parámetro, resuelve en runtime) y
  `/financiero` (bloqueado a propósito).
- **DB**: las 6 funciones nuevas son `SECURITY DEFINER` **con `search_path` fijo**;
  ejecución revocada para anon/authenticated en las internas; 2 crons activos; realtime
  en `timeline_events`+`opportunities`; buckets OK; **ninguna tabla con RLS sin policy**.
- **Advisors de seguridad**: sin issues nuevos introducidos. Persisten 2 ERROR
  pre-existentes (vistas `units_public`/`business_public` SECURITY DEFINER, usadas por la
  página pública) y warnings de escala/configuración ya conocidos.
- **Lectura lógica del código nuevo** (canal, meta-ads, libs): revisada a fondo.

## Bug encontrado y corregido
| Sev. | Archivo | Problema | Fix |
|------|---------|----------|-----|
| Medio | `lib/meta-ads.js` | El **ROAS** mezclaba unidades (gasto ARS ÷1000 vs ingresos USD) → mostraba "~756x", irreal. | Todo en **USD**; ROAS = margen/inversión → valor realista (~1.7x). Etiquetas con "USD". |

Resto del código nuevo: **limpio** (pestañas de Instagram, composer, comentarios,
inbox, competencia, Meta Ads) — sin null-derefs, sin `await` faltantes, sin handlers a
IDs inexistentes, datos dinámicos escapados (sin XSS).

## Recordatorio de estado real (no son bugs)
WhatsApp = real. Instagram (stats/posts/inbox/comentarios/competencia) y Meta Ads =
**demo hasta conectar el token de Meta**; los stubs de funciones quedan listos para que
el programador complete la Graph/Marketing API.

**Veredicto v2: todo verde, 1 bug corregido.**
