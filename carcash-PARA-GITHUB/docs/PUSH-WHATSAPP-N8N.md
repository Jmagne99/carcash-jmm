# CarCash · Enviar alertas y ventas por WhatsApp (vía n8n)

El CRM genera **notificaciones** automáticamente (alertas de leads, leads fríos,
presupuestos sin respuesta, stock viejo, documentación vencida, y **ventas nuevas**
para el dueño). Cada notificación tiene un **destinatario**. Para que además lleguen
al **WhatsApp** de esa persona, n8n las levanta de la base y las envía. Todo server-side,
sin depender de Netlify.

> Requisito: cada usuario debe tener su **teléfono cargado** en su perfil
> (Usuarios y roles → editar → Teléfono). El dueño también, para recibir las ventas.

## Funciones disponibles (llamar con la SERVICE ROLE key)

**1. Traer pendientes**
```
POST https://vnwxdannrgwizvjlvlfr.supabase.co/rest/v1/rpc/get_pending_whatsapp_pushes
Headers: apikey + Authorization: Bearer <SERVICE_ROLE_KEY>, Content-Type: application/json
Body: { "p_limit": 50 }
```
Devuelve una lista:
```json
[{ "id":"...", "recipient_id":"...", "recipient_name":"Diego",
   "phone":"+5491122334455", "type":"new_sale",
   "title":"Diego cerró una venta",
   "body":"Juan Pérez · Toyota Hilux 2022 · USD 38.000",
   "link":"/ventas/v-0001", "created_at":"..." }]
```

**2. Marcar como enviada** (para no repetir)
```
POST .../rest/v1/rpc/mark_whatsapp_pushed
Body: { "p_id": "<id de la notificación>" }
```

## Flujo en n8n (1 minuto de cadencia)

1. **Schedule** cada 1–2 min → nodo HTTP a `get_pending_whatsapp_pushes`.
2. Por cada item: enviar WhatsApp al `phone` con un texto como:
   `*{{title}}*\n{{body}}` (podés sumar el link del CRM si querés).
3. Llamar a `mark_whatsapp_pushed` con el `id` de esa notificación.

Solo el service_role puede llamar estas funciones (no el navegador), así que va seguro
del lado de n8n.

## Tipos de notificación que vas a recibir

| type | Para quién | Cuándo |
|------|-----------|--------|
| `new_sale` | Dueño / gerente | Se cargó una venta |
| `sale_delivered` | Dueño / gerente | Se entregó una venta |
| `unassigned_lead` | Supervisores | Entró un lead sin asignar |
| `new_lead` | Vendedor | Le asignaron un lead |
| `lead_cold` | Vendedor (o supervisores) | Lead sin contacto 24/72/96 h |
| `lead_uncontacted` | Vendedor | Lead nuevo sin responder |
| `quote_no_response` | Vendedor | Presupuesto sin respuesta 48 h |
| `opp_stale` | Vendedor | Oportunidad estancada |
| `stock_stale` | Dueño / gerente | Auto con rotación lenta |
| `doc_expired` | Back office / admins | Documento vencido |

Si querés que **solo** algunos tipos vayan por WhatsApp (ej. únicamente `new_sale`
y `lead_cold`), filtralo en n8n por el campo `type`.

> ¿Querés que al dueño le entre una **llamada** (no solo WhatsApp) por cada venta?
> Eso es un paso extra con un servicio de voz (ej. Twilio); se puede sumar después.
