# Integración Instagram → CarCash CRM (resumen para dev)

## Contexto del proyecto
- App de Meta: **CarCash CRM** · App ID `1317726543838841` · App Secret en *Configuración → Básica*.
- Supabase project ref: `vnwxdannrgwizvjlvlfr`.
- Sitio Netlify conectado por Git (con funciones): `euphonious-fudge-46b046.netlify.app`
  - Base dir del repo en Netlify: `carcash-PARA-GITHUB` (si subiste la carpeta anidada)
  - `netlify.toml` ya tiene `publish = "."` y `functions = "server/functions"`
- Env vars YA cargadas en Netlify: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

## Enfoque que usa el código (IMPORTANTE)
Las funciones en `server/functions/` ya están **completas** y usan la **Instagram Graph API basada en Página de Facebook**:
- Base: `https://graph.facebook.com/v21.0`
- Leen estas env vars: `META_ACCESS_TOKEN`, `META_INSTAGRAM_ACCOUNT_ID`, `META_PAGE_ID`, `META_VERIFY_TOKEN`

Por eso el token debe ser el **de la Página** (Page access token), NO el de "Instagram Login"
(ese usa `graph.instagram.com` y obligaría a adaptar las funciones).

Funciones afectadas:
- `ig-insights.js`     → estadísticas de la cuenta (reach, impresiones, seguidores, top media)
- `ig-inbox.js`        → DMs (conversaciones)
- `ig-comments.js`     → comentarios de publicaciones
- `ig-competitor.js`   → Business Discovery de la competencia
- `ig-webhook.js`      → recibe DMs y los inserta como leads vía RPC `ingest_inbound_message`
- `publish-to-ig.js`   → publica una unidad como post (content publishing)
- `integrations-status.js` → reporta si Instagram quedó configurado

Todas devuelven mock/avisos si falta el token, así el front nunca se rompe.

## Prerequisito
Cuenta de Instagram **Business/Creator** vinculada a una **Página de Facebook**,
administrada por la **misma cuenta de Facebook** que creó la app.

## Permisos
`instagram_basic`, `instagram_manage_insights`, `instagram_manage_comments`,
`instagram_manage_messages`, `pages_show_list`, `pages_read_engagement` (+ `business_management`).

## Generar token (Page-based) y obtener los IDs
```bash
# 1) Token de usuario corto -> largo (60 días)
GET https://graph.facebook.com/v21.0/oauth/access_token
    ?grant_type=fb_exchange_token
    &client_id=APP_ID
    &client_secret=APP_SECRET
    &fb_exchange_token=SHORT_USER_TOKEN

# 2) Página + token de página (el page token derivado de un user token largo no expira)
GET https://graph.facebook.com/v21.0/me/accounts?access_token=LONG_USER_TOKEN
    -> id          (= META_PAGE_ID)
    -> access_token (= META_ACCESS_TOKEN)

# 3) Instagram Business Account ID
GET https://graph.facebook.com/v21.0/{PAGE_ID}?fields=instagram_business_account&access_token=PAGE_TOKEN
    -> instagram_business_account.id  (= META_INSTAGRAM_ACCOUNT_ID)
```
Recomendado para producción: usar un token de **System User**
(Business Settings → System Users → asignar la página → generar token) → no expira.

## Cargar en Netlify (Site config → Environment variables) y redeploy
```
META_ACCESS_TOKEN            = <page token largo>
META_INSTAGRAM_ACCOUNT_ID    = <instagram_business_account.id>
META_PAGE_ID                 = <page id>
META_VERIFY_TOKEN            = <string a elección, p.ej. carcash-ig-2026>
```
Luego: Deploys → Trigger deploy → Deploy project.

## Webhook DMs -> leads (Meta app → Webhooks → objeto Instagram)
- Callback URL: `https://euphonious-fudge-46b046.netlify.app/.netlify/functions/ig-webhook`
- Verify token: el mismo `META_VERIFY_TOKEN`
- Campos: `messages`, `messaging_postbacks`
- `ig-webhook.js` ya parsea el payload y llama al RPC `ingest_inbound_message`
  (crea contacto + lead `origin='instagram'` + notifica al supervisor). No hay que tocar nada más.

## Verificar
- Abrir `https://euphonious-fudge-46b046.netlify.app/.netlify/functions/integrations-status`
  → Instagram debe figurar `configured: true`.
- En el CRM, el módulo Instagram pasa de demo a datos reales.

## Alternativa (Instagram Login, graph.instagram.com)
Si por algún motivo se genera un token por "API setup with Instagram login" en vez del page token,
hay que adaptar las funciones IG para usar `https://graph.instagram.com` y los endpoints
`/me`, `/me/media`, `/me/conversations`, etc. con el IG User token. (No es el camino del código actual.)

## Mercado Libre (queda pendiente, mismo patrón)
`server/functions/ml-webhook.js` y `publish-to-ml.js` están como esqueleto.
Requiere app en developers.mercadolibre.com.ar, OAuth (access_token + refresh_token + user_id),
env vars `ML_*`, y completar el cuerpo de esas dos funciones. El token de ML dura 6 h y se
renueva con el refresh_token.
