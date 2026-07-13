# WAPI API 2 — fixed Baileys core

This is a clean, GitHub-ready backend for a **second WAPI installation**. It keeps the routes used by the WAPI frontend for creating a Baileys connection, generating a QR code, checking connection status, and sending WhatsApp text messages.

It intentionally does **not** depend on MongoDB or Redis. Connections are stored in a small JSON file and Baileys credentials are stored on disk, which avoids the MongoDB Atlas whitelist and Redis startup errors from the older API.

## Included fixes

- QR polling endpoint: `GET /api/whatsapp/baileys/qrcode/:wabaId`
- Connection endpoint: `POST /api/whatsapp/connect`
- Text sending endpoint: `POST /api/whatsapp/send`
- Correct Baileys sent message ID: `result.key.id`
- Multiple independent WhatsApp sessions
- Separate `INSTANCE_NAMESPACE` for the second system
- Persistent session restoration after restart
- Automatic reconnect with exponential backoff
- Correct comma-separated CORS handling
- Optional API-key protection
- Socket.IO status, QR, and incoming-message events
- Render, Railway, Docker, and GitHub Actions files

## 1. Upload to GitHub

Create or open your empty repository, for example `wapi-api-2`, then upload **the contents inside this folder**. Do not upload `node_modules`, `.env`, `data`, or real WhatsApp session credentials.

Using Git:

```bash
git init
git add .
git commit -m "Add fixed WAPI API 2"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/wapi-api-2.git
git push -u origin main
```

## 2. Local setup

```bash
cp .env.example .env
npm install
npm start
```

Open:

```text
http://localhost:5000/health
```

## 3. Connect your frontend

Set the WAPI frontend environment variables to the deployed backend URL:

```env
BACKEND_API_URL=https://YOUR-WAPI-API-2-DOMAIN
NEXT_PUBLIC_API_URL=https://YOUR-WAPI-API-2-DOMAIN/api
```

The frontend QR proxy should call:

```text
GET /api/whatsapp/baileys/qrcode/:wabaId
```

## 4. Required production settings

```env
NODE_ENV=production
PORT=5000
INSTANCE_NAMESPACE=wapi-system-2
ALLOWED_ORIGINS=https://your-frontend.example,https://your-admin.example
AUTH_MODE=none
DATA_DIR=/persistent/path/data
SESSION_DIR=/persistent/path/sessions
```

Every separate system must have a different `INSTANCE_NAMESPACE`, `DATA_DIR`, and `SESSION_DIR`.

## 5. Render warning

WhatsApp login credentials must be on a **persistent disk**. Without a disk, Render deletes the session after restart and you must scan the QR again. The included `render.yaml` uses:

```text
/var/data/wapi-system-2/data
/var/data/wapi-system-2/sessions
```

A service plan that supports persistent disks is required. Free ephemeral hosting is not reliable for Baileys WhatsApp sessions.

## API examples

### Create connection

```bash
curl -X POST https://YOUR-DOMAIN/api/whatsapp/connect \
  -H "Content-Type: application/json" \
  -d '{"name":"My Second WhatsApp","provider":"baileys"}'
```

Copy `data.waba_id` from the response.

### Get QR

```bash
curl https://YOUR-DOMAIN/api/whatsapp/baileys/qrcode/WABA_ID
```

`data.qr_code` is a `data:image/png;base64,...` image URL.

### Send a message

Use an international phone number without `+` or spaces:

```bash
curl -X POST https://YOUR-DOMAIN/api/whatsapp/send \
  -H "Content-Type: application/json" \
  -d '{
    "waba_id":"WABA_ID",
    "contact_no":"93700123456",
    "message":"Hello from WAPI API 2"
  }'
```

## Important WhatsApp safety

This backend does not bypass WhatsApp restrictions. Avoid unsolicited bulk messaging, use customer consent, start slowly, and respect WhatsApp policies. Heavy automated use can still cause rate limits or account restrictions.

## What is not included

This package is the fixed WhatsApp/Baileys core, not the full older CRM backend. The older CRM modules for subscriptions, campaigns, contacts, Facebook ads, Stripe, Google integrations, and admin analytics are not included. Those modules can be connected later without changing the QR and send routes above.
