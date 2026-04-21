# SyncWatch

Watch **local video files** in sync with a friend (no uploads) + **in-room voice chat**.

## Local run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Deploy (works anywhere)

### Option A (recommended): Render (no code changes)

1. Create a GitHub repo and push this project.
2. In Render, create a **New Web Service** from your repo.
3. Settings:
   - **Runtime**: Node
   - **Build command**: `npm ci`
   - **Start command**: `npm start`
4. Deploy. Render will give you an HTTPS URL.

**Important**: Mic access generally requires **HTTPS**, so this is ideal.

### Option B: Fly.io (Docker)

1. Install Fly CLI, login.
2. From this folder:

```bash
fly launch
fly deploy
```

## Voice chat reliability (TURN)

This app uses public Google STUN servers by default. Voice will work for most users, but on some networks (strict NAT/firewalls) you’ll need a **TURN** relay.

If you want, tell me which provider you want:
- Twilio TURN
- Cloudflare Calls TURN
- Self-hosted coturn

…and I’ll wire `public/app.js` to read TURN creds from environment (served from the backend) so it works globally.

