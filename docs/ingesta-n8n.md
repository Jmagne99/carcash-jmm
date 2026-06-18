# CarCash · Contrato de ingesta para n8n (WhatsApp / Instagram)

Para que un mensaje **aparezca en la Bandeja del CRM** tiene que quedar guardado en
la base de datos del CRM (Supabase del proyecto **Car Cash**). La forma más simple y
robusta: n8n hace **una sola llamada** a la función `ingest_inbound_message`, que
matchea/crea el contacto, asegura el lead (oportunidad) y registra el mensaje. No hace
falta deployar ninguna Netlify Function: funciona con el deploy estático actual.

> El CRM muestra el mensaje **en vivo** (Supabase Realtime) ni bien queda insertado.

---

## 1. Entrante (cliente → CRM)

Desde n8n, agregá un nodo **HTTP Request** (o el nodo Supabase → RPC):

```
POST https://vnwxdannrgwizvjlvlfr.supabase.co/rest/v1/rpc/ingest_inbound_message
Headers:
  apikey: <SUPABASE_SERVICE_ROLE_KEY>
  Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
  Content-Type: application/json
Body (JSON):
{
  "p_phone": "+5491122334455",      // WhatsApp: teléfono. Instagram: el sender id (PSID)
  "p_text": "Hola, ¿sigue disponible la Hilux?",
  "p_name": "Juan Pérez",           // opcional (nombre del perfil)
  "p_channel": "whatsapp",          // "whatsapp" | "instagram"
  "p_direction": "entrante",        // "entrante" | "saliente"
  "p_external_id": "wamid.HBgN...", // opcional, da idempotencia (no duplica)
  "p_event_at": "2026-06-01T12:00:00Z"  // opcional
}
```

Respuesta: `{ "ok": true, "contact_id": "...", "opportunity_id": "...", "event_id": "..." }`
o `{ "deduped": true, ... }` si ya se había registrado ese `external_id`.

Qué hace automáticamente:
- Busca el contacto por `whatsapp_id` o por los últimos 10 dígitos del teléfono; si no
  existe, lo **crea**.
- Si no hay una oportunidad abierta, **crea el lead** (`origin = whatsapp|instagram`,
  estado `nuevo`, **sin asignar**) → dispara la notificación al supervisor para que lo
  asigne.
- Inserta el mensaje en la conversación (`timeline_events`, canal correspondiente).

> **Seguridad:** la función solo se puede llamar con la **service_role key** (server-side,
> en n8n). No está habilitada para el navegador/anon.

### Instagram
Idéntico, con `"p_channel": "instagram"` y `p_phone` = id del usuario de IG (PSID). El
mensaje cae en la **misma Bandeja**, con su etiqueta de Instagram.

---

## 2. Saliente (respuesta del vendedor → cliente)

Tu flujo de respuestas por WhatsApp ya está hecho en n8n. Para que esas respuestas
**también queden en el historial del CRM**, hay dos opciones (cualquiera sirve):

- **A.** Cuando el vendedor responde **desde el CRM**, el CRM ya inserta el mensaje
  saliente en `timeline_events` (`direction = 'saliente'`). Configurá un disparador en
  n8n (Supabase Realtime o polling) sobre esos registros y enviá por Meta. Para no
  reenviar, marcá `metadata.sent = true` después de mandar.
  ```sql
  -- polling sugerido en n8n
  select id, opportunity_id, channel, body, metadata
  from timeline_events
  where direction = 'saliente' and channel in ('whatsapp','instagram')
    and coalesce((metadata->>'sent')::bool, false) = false
  order by event_at asc;
  ```
- **B.** Si las respuestas salen por **otro lado** (ej. el vendedor responde desde
  WhatsApp directo), registralas en el CRM con la misma función del punto 1 usando
  `"p_direction": "saliente"`. Así la conversación queda completa de los dos lados.

---

## 3. Checklist para la demo

1. En Supabase → Project Settings → API, copiá la **service_role key** y cargala en n8n.
2. En el flujo de WhatsApp entrante de n8n, agregá el HTTP Request del punto 1.
3. (Instagram) Mismo nodo con `p_channel = instagram`.
4. Probá: mandá un WhatsApp al número → en segundos tiene que aparecer en la **Bandeja**
   del CRM como conversación nueva, y el supervisor recibe la alerta para asignarla.
5. Verificá que la respuesta (desde el CRM o desde n8n) quede en el hilo.

Con esto, **WhatsApp e Instagram entran y se ven en vivo en el CRM** sin depender de
ningún deploy de funciones.
