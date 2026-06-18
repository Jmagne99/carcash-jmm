# CarCash · Guía de integraciones (Instagram · Mercado Libre · Meta Ads · WhatsApp)

Esta guía explica cómo pasar de los **datos mock** (lo que ves hoy en la app)
a las **integraciones reales**. El frontend ya está listo: cada panel llama a
una *Edge Function* de Netlify y, si esa función todavía no está deployada o
sin credenciales, cae a un mock para que la UI nunca se rompa.

El trabajo restante es **server-side**: cargar credenciales y completar el
cuerpo de las funciones en `server/functions/`. Ninguna API key vive en el
browser — eso es a propósito y es la forma correcta y segura de hacerlo.

---

>  **Dos formas de deployar:**
>  - **Arrastrar/soltar (drop)** en Netlify → publica el **CRM estático** (anda 100%; las
>    funciones quedan en mock con avisos). Es lo más rápido para tener el sistema online.
>  - **Conectar por Git** → Netlify corre `npm install` y deploya también las **funciones**
>    (WhatsApp, ML, IG). Necesario para que las integraciones server-side funcionen de verdad.
>    Configurá `functions = "server/functions"` (ver `netlify.toml`).

## 0. Arquitectura en 30 segundos

```
Browser (CRM)  ──►  /.netlify/functions/<fn>  ──►  API externa (Meta / ML)
                         │                              │
                         └────────►  Supabase  ◄────────┘   (opportunities, publications…)
```

- **Publicar stock**: `publish-to-ml.js`, `publish-to-ig.js`
- **Recibir leads/DMs**: webhooks `ml-webhook.js`, `ig-webhook.js`, `meta-leads-webhook.js`
- **Estado de conexión** (los hubs en verde): `integrations-status.js` — *ya es funcional*
- **Estadísticas de Instagram**: `ig-insights.js`

---

## 1. Deploy base en Netlify

1. Subí el repo a GitHub y conectalo en **Netlify → Add new site → Import**.
2. Build settings: *publish directory* = `.` y *functions directory* = `server/functions` (ya está en `netlify.toml`).
3. **Netlify → Site settings → Environment variables**: cargá las variables de `.env.example` (sección por sección, abajo). Dejá vacías las que todavía no tengas.
4. Deploy. Con solo `SUPABASE_*` cargadas, `integrations-status` ya empieza a reportar el estado real y los hubs dejan de mostrar el aviso amarillo.

> Las claves de Supabase: `SUPABASE_URL` es la misma del proyecto; la
> **SERVICE ROLE KEY** (Supabase → Project Settings → API) es secreta y solo
> va en Netlify, nunca en el frontend.

---

## 2. Instagram (Meta Graph API)

Para **leer estadísticas**, **recibir DMs** y **publicar**, necesitás una
cuenta de **Instagram Business** vinculada a una **página de Facebook**.

### 2.1 Crear la app de Meta
1. Entrá a <https://developers.facebook.com> → **My Apps → Create App → Business**.
2. Agregá los productos **Instagram Graph API** y **Webhooks**.
3. En **App Roles** sumá tu usuario; para producción vas a necesitar
   **App Review** con estos permisos:
   `instagram_basic`, `instagram_manage_insights`,
   `instagram_manage_messages`, `pages_show_list`, `pages_manage_metadata`.

### 2.2 Obtener token e IDs
1. Generá un **token de usuario** desde el Graph API Explorer con los permisos de arriba.
2. Convertilo a **token de larga duración** (60 días) y configurá su renovación.
3. Conseguí el **Instagram Business Account ID**:
   `GET /me/accounts` → tomá el `page id` → `GET /{page-id}?fields=instagram_business_account`.
4. Cargá en Netlify:
   - `META_ACCESS_TOKEN` = token de larga duración
   - `META_INSTAGRAM_ACCOUNT_ID` = el IG business id
   - `META_PAGE_ID` = id de la página de Facebook
   - `META_VERIFY_TOKEN` = una string aleatoria que vos inventás (para validar el webhook)

### 2.3 Activar estadísticas
- Completá la implementación marcada con `TODO` en `server/functions/ig-insights.js`
  (ya está el esqueleto con las URLs de Graph API). Devolvé el shape
  `{ profile, totals, series, top_media }` — el panel de la app lo dibuja solo.
- Listo: **Integraciones → Instagram** muestra alcance, impresiones, visitas al
  perfil, nuevos seguidores, engagement, leads y los posts top, con datos reales.

### 2.4 Recibir DMs como oportunidades
1. En **Webhooks** del app, suscribite al objeto **Instagram**, campos `messages` y `messaging_postbacks`.
2. Callback URL: `https://TU-SITIO.netlify.app/.netlify/functions/ig-webhook`
3. Verify token: el mismo `META_VERIFY_TOKEN`.
4. Completá el `TODO` de `ig-webhook.js` para crear el contacto + la oportunidad (`origin='instagram'`).

---

## 3. Mercado Libre

### 3.1 Crear la aplicación
1. <https://developers.mercadolibre.com.ar/devcenter> → **Crear aplicación**.
2. Anotá **App ID** y **Secret Key**.
3. Redirect URI: `https://TU-SITIO.netlify.app/.netlify/functions/ml-oauth-callback`
   (si automatizás el OAuth) o hacé el flujo una vez a mano.

### 3.2 OAuth (token + refresh)
1. Autorizá la app y obtené `access_token`, `refresh_token` y tu `user_id`.
2. Cargá en Netlify: `ML_APP_ID`, `ML_CLIENT_SECRET`, `ML_ACCESS_TOKEN`,
   `ML_REFRESH_TOKEN`, `ML_USER_ID`.
3. El access token dura 6 horas → refrescalo con el `refresh_token`
   (conviene un pequeño job o refrescar on-demand dentro de las functions).

### 3.3 Publicar stock
- Completá `publish-to-ml.js` (esqueleto con el `POST /items`). Al guardar una
  unidad con el canal ML en sus `auto_publish_channels`, o desde
  **Publicaciones → + ML**, se dispara la publicación y se registra la fila en
  `public.publications`.

### 3.4 Recibir preguntas como leads
1. En la app de ML, configurá **Notificaciones** (callback):
   `https://TU-SITIO.netlify.app/.netlify/functions/ml-webhook`
2. Suscribite a los topics `questions`, `orders`, `items`.
3. Completá `ml-webhook.js` para crear la oportunidad con `origin='mercado_libre'`.

---

## 4. Meta Ads (Lead Ads)

1. En **Business Manager** asociá tu cuenta de Ads a la app de Meta.
2. Webhook objeto **Page**, campo `leadgen`.
   Callback: `.../.netlify/functions/meta-leads-webhook` (mismo verify token).
3. Cargá `META_AD_ACCOUNT_ID` (`act_xxxxxxxxx`).
4. Completá `meta-leads-webhook.js`: por cada lead, traé los `field_data` y creá
   contacto + oportunidad `origin='meta_ads'`.

---

## 5. WhatsApp (Meta + n8n)

WhatsApp **ya está automatizado** con Meta y **n8n**. No hace falta que el CRM
hable con Meta directamente: n8n es el puente. Las conversaciones se ven
completas dentro del CRM, en la **Bandeja**.

```
Cliente WhatsApp ──► Meta ──► n8n ──(POST wsp-inbound)──► CRM/Supabase ──► Bandeja
Bandeja (responder) ──(wsp-send)──► n8n (webhook) ──► Meta ──► Cliente WhatsApp
```

### 5.1 Entrante (cliente → CRM)
1. En tu flujo de n8n que recibe el WhatsApp de Meta, agregá un nodo **HTTP Request**.
2. `POST https://TU-SITIO.netlify.app/.netlify/functions/wsp-inbound`
   con header `X-CarCash-Secret: <N8N_SHARED_SECRET>` y body:
   ```json
   {
     "phone": "+5491122334455",
     "name": "Juan Pérez",
     "text": "Hola, ¿sigue disponible la Hilux?",
     "direction": "entrante",
     "wa_message_id": "wamid....",
     "timestamp": "2026-06-01T12:00:00Z"
   }
   ```
3. La función `wsp-inbound.js` (**ya funcional**) matchea o crea el contacto por
   teléfono, asegura una oportunidad abierta (`origin='whatsapp'`) e inserta el
   mensaje en `timeline_events`. Aparece solo en la Bandeja. `wa_message_id` da
   idempotencia (no duplica si n8n reintenta).

### 5.2 Saliente (CRM → cliente)
1. En n8n creá un **Webhook** que reciba `{ to, text, opportunity_id, contact_id }`
   y mande el mensaje por la API de WhatsApp de Meta.
2. Pegá esa URL del webhook en Netlify como `N8N_WSP_SEND_URL`.
3. Cuando un vendedor responde desde la Bandeja, el CRM:
   guarda el mensaje en el historial **y** llama a `wsp-send.js`, que reenvía a
   n8n para el envío real. Si `N8N_WSP_SEND_URL` no está cargada, el mensaje
   igual queda registrado y la app avisa "WhatsApp aún no conectado".

### 5.3 Variables
- `N8N_WSP_SEND_URL` — webhook de n8n para enviar.
- `N8N_SHARED_SECRET` — secreto compartido en ambos sentidos (header `X-CarCash-Secret`).

Con esto, **toda la conversación de WhatsApp queda dentro del CRM**, asociada al
contacto y a su oportunidad, junto al resto de los canales.

---

## 6. Checklist de verificación

| Quiero… | Función | Env vars | Estado del esqueleto |
|---|---|---|---|
| Hubs en verde | `integrations-status.js` | `SUPABASE_*` + las de cada canal | ✅ Funcional |
| Stats de Instagram | `ig-insights.js` | `META_ACCESS_TOKEN`, `META_INSTAGRAM_ACCOUNT_ID` | ⏳ Completar fetch |
| DMs de IG → pipeline | `ig-webhook.js` | `META_*` | ⏳ Completar insert |
| Publicar en ML | `publish-to-ml.js` | `ML_*` | ⏳ Completar POST |
| Preguntas ML → pipeline | `ml-webhook.js` | `ML_*` | ⏳ Completar insert |
| Lead Ads → pipeline | `meta-leads-webhook.js` | `META_*` | ⏳ Completar insert |
| Publicar en IG | `publish-to-ig.js` | `META_*` | ⏳ Completar publishing |
| WhatsApp entrante → Bandeja | `wsp-inbound.js` | `N8N_SHARED_SECRET` | ✅ Funcional (n8n postea) |
| WhatsApp saliente desde la app | `wsp-send.js` | `N8N_WSP_SEND_URL` | ✅ Funcional (reenvía a n8n) |

Cuando una función no está lista o sin credenciales, **la app sigue andando**
con datos de demostración y un aviso claro. Así podés ir conectando un canal a
la vez sin romper nada.

---

## 7. Seguridad — no negociable

- La **service role key** y los **access tokens** van **solo** en Netlify env vars.
- El frontend usa la **anon key** de Supabase (pública) protegida por **RLS**.
- Validá siempre el `verify_token` en los webhooks entrantes.
- Si filtrás un token, **rotálo** en el panel del proveedor de inmediato.
