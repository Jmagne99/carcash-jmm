# CarCash CRM · Reporte de auditoría y mejoras

Trabajo realizado sobre el CRM (SPA en JavaScript vanilla + Supabase). El backend
ya estaba muy completo (18 tablas con RLS, 4 vistas, ~25 funciones, triggers). El
código del frontend era de buena calidad; el trabajo fue cerrar huecos, corregir
bugs, sumar lo que faltaba y mejorar la estética.

---

## 1. Auditoría — bugs encontrados y corregidos

| # | Severidad | Problema | Estado |
|---|-----------|----------|--------|
| 1 | Crítico | 5 módulos registrados en el router sin archivo (mostraban "EN DESARROLLO") | ✅ Creados |
| 2 | Medio | `/mi-performance/:vendedorId` bloqueaba al supervisor (estaba como `admin`) | ✅ Pasa a `supervisor` + `isSupervisorOrAdmin()` |
| 3 | Medio | El barrel `lib/index.js` no re-exportaba `isOwner/isSupervisor/isSupervisorOrAdmin` | ✅ Agregados |
| 4 | Medio | Al crear oportunidad desde un contacto, el `?contact=` no se precargaba | ✅ Implementado |
| 5 | Menor | Botón "Crear oportunidad" quedaba trabado en "Creando…" si faltaba el nombre | ✅ Corregido |
| 6 | Menor | Tablero contaba ventas con soft-delete (faltaba `deleted_at is null`) | ✅ Corregido |

Verificado además: todos los `joins` de Supabase apuntan a FKs reales, los enums
usados son válidos, las RPCs existen con sus firmas correctas, y los 46 archivos JS
pasan el chequeo de sintaxis y de resolución de imports.

---

## 2. Módulos nuevos (los 5 que faltaban)

- **Agenda** (`/agenda`) — el centro de seguimiento del vendedor: tareas + próximas
  acciones agrupadas por Vencidas / Hoy / Mañana / Próximos 7 días, y **leads que se
  enfrían** (alerta a las 24h, **FRÍO a los 4 días**). Acciones manuales: *Contacté*,
  *Llamar +1d* (reprogramar) y *Perdido* (compró en otra agencia). Supervisor/admin
  ven a todo el equipo con filtro por vendedor.
- **Publicaciones** (`/publicaciones`) — estado por canal (ML/IG): vistas, consultas,
  sync, errores, y unidades disponibles **sin publicar**.
- **Consignaciones** (`/consignaciones`) — unidades en consignación con consignante,
  precio a liquidar, comisión estimada y días en stock.
- **Documentación** (`/documentacion`) — control de papeles por unidad (título, 08, VTV,
  cédulas, libre deuda…) con resaltado de **vencidos** y **por vencer**.
- **Cobros** (`/cobros`) — saldo por venta (precio vs. cobrado), registro de pagos y KPIs.

---

## 3. Lógica de leads y estadísticas

- **Recordatorios cada 24h / lead frío a los 4 días**: umbral configurable en
  `settings.alerts_rules.contact_alert_hours_cold` (se cargó en 96h). La Agenda lo usa.
- **Acciones manuales del vendedor**: reprogramar llamada, registrar contacto (resetea
  las horas sin contacto) y marcar "compró en la competencia" (pierde la oportunidad).
- **Estadísticas mensuales que arrancan de 0 y quedan históricas**: se conectó el cierre
  de mes idempotente (`close_previous_month_if_pending`) al arranque de la app, así los
  `monthly_snapshots` se generan solos al cambiar de mes. Los objetivos del supervisor
  (`monthly_sales_target`) siguen editándose en Equipo y quedan registrados por mes.

---

## 4. Ruteo de conversaciones al supervisor (nuevo)

Flujo pedido: **toda conversación entra como lead sin asignar; el supervisor recibe la
alerta y asigna manualmente al vendedor correcto.**

- **DB (migración aplicada `supervisor_lead_routing_notifications`)**:
  - Al entrar un lead **sin asignar** → notifica a todos los supervisores/gerentes/dueños.
  - Al **asignarlo** (o reasignarlo) → notifica al vendedor elegido.
  - Probado en transacción: 2 avisos al crear sin asignar, 1 al asignar. ✅
- **Bandeja**: filtro **"Sin asignar"**, badge rojo en la lista, contador "X sin asignar"
  y un **selector de vendedor** en la cabecera del hilo (visible para supervisor/admin)
  para asignar/reasignar en un click.
- **RLS** (ya existente, verificada): los leads sin asignar solo los ven supervisores/
  admin; el vendedor recién los ve cuando se los asignan.

---

## 5. WhatsApp (Meta + n8n)

WhatsApp ya está automatizado con Meta + n8n. Se integró **en ambos sentidos** para que
**todas las conversaciones vivan en el CRM y se conviertan en leads**:

- **Entrante** — `server/functions/wsp-inbound.js` (**funcional**): n8n postea cada
  mensaje; la función matchea/crea el contacto, **asegura una oportunidad** (`origin=whatsapp`)
  y guarda el mensaje. Aparece solo en la Bandeja. Con idempotencia por `wa_message_id`.
- **Saliente** — al responder desde la Bandeja, además de registrar el mensaje, se despacha
  a n8n (`wsp-send.js` → `N8N_WSP_SEND_URL`) para que Meta lo envíe. Si no está conectado,
  el mensaje igual queda en el historial y la app avisa.

---

## 6. Estética

- Se **hoistearon** los componentes compartidos (`page-hd`, `kpi`, tablas, chips, etc.)
  al CSS global. Antes estaban duplicados en 8 módulos y **se rompían** si entrabas
  directo a un módulo que no los definía (p. ej. Equipo).
- Nueva capa de componentes pulidos: tablas de datos, chips/pills, segmented controls,
  inputs con focus champagne, skeletons, empty-states ricos, barras de progreso, notas/
  banners, sombras y motion suave, scrollbars y `focus-visible` accesibles, modales con
  animación de entrada. Respeta la identidad editorial (Fraunces + champagne, bordes rectos).

---

## 7. Integraciones — estructura + guía

- **Instagram**: panel de **estadísticas** real (alcance, impresiones, visitas, nuevos
  seguidores, engagement, leads, sparkline de crecimiento y posts top) en
  Integraciones → Instagram, con datos mock hasta conectar la API.
- **Netlify Functions** listas (algunas funcionales, otras esqueleto con TODO): estado de
  integraciones, IG insights, publicar en ML/IG, webhooks de ML/IG/Meta Ads, WhatsApp.
- **`netlify.toml`**, **`.env.example`** y guía completa en **`docs/INTEGRACIONES.md`**
  con el paso a paso de Instagram, Mercado Libre, Meta Ads y WhatsApp (incluye el flujo n8n).

---

## 8. Cómo correrlo / deployarlo

1. Servir la carpeta como sitio estático (las credenciales de Supabase ya están en
   `src/lib/supabase-client.js`, o inyectá `window.__CARCASH_CONFIG__` en `index.html`).
2. Para las integraciones: conectar el repo a Netlify, cargar las env vars de
   `.env.example` y seguir `docs/INTEGRACIONES.md`. Mientras tanto, la app funciona con
   datos mock y avisos claros donde falte conectar.

> Nota: las funciones de IG/ML/Meta Ads quedan como esqueleto (necesitan tus credenciales
> y completar la llamada a cada API). WhatsApp, el estado de integraciones y todo el CRM
> comercial quedan operativos.

---

## 9. Agregados posteriores

- **WhatsApp en vivo (Bandeja)**: Supabase Realtime — los mensajes nuevos y las
  reasignaciones aparecen solos, con indicador "● en vivo". Se podés intervenir
  manualmente respondiendo desde el composer (sale por n8n → Meta).
- **Usuarios y roles** (`/usuarios`, admin): alta de usuarios con login + rol + objetivo,
  edición de rol / activación, separado de Equipo.
- **Base de clientes con filtros avanzados** (`/contactos`): filtro por **vendedor**
  (dueño/supervisor ven todo; el vendedor ve su base por RLS), **marca**, **año de compra**,
  **monto** (+30k/50k/70k/100k), estado (compradores/recurrentes/VIP/con opp activa) y
  **orden** (mayor gasto, más compras, recientes). El header muestra compradores y facturado.
- **Botón global "Agregar cliente/lead"**: FAB siempre visible → Nuevo lead o Nuevo cliente.
- **Notas de voz**: grabar y enviar **audios** desde el chat (suben a Storage
  `whatsapp-media` y se despachan a n8n; se reproducen en el hilo).
- **DB**: triggers de ruteo al supervisor + notificación al asignar; Realtime habilitado;
  bucket `whatsapp-media`. Todo aplicado por migración.
