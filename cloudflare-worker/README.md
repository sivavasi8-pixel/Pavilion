# Pavilion push-notification Worker

Deploy this from your own machine, using your own Cloudflare login — I can't
run these commands for you since I don't have access to your Cloudflare
account.

## 1. Install wrangler (Cloudflare's CLI), if you don't have it

```
npm install -g wrangler
```

## 2. Log in

```
wrangler login
```

This opens a browser tab to authorize the CLI against your Cloudflare
account.

## 3. Deploy

From inside this `cloudflare-worker` folder:

```
cd cloudflare-worker
wrangler deploy
```

Wrangler will print a URL that looks like:

```
https://pavilion-push.<your-subdomain>.workers.dev
```

**Send me that URL** (it's not secret, just needs to be correct) — I'll drop
it into `PUSH_WORKER_URL` in `public/index.html`.

## 4. Set the two secrets

Still from inside this folder:

```
wrangler secret put PUSH_SHARED_SECRET
```
When prompted, paste exactly this value (already baked into `index.html`,
so it has to match):
```
vK4Tq41nBB5eKlnlemgzYPDJavfwu9XrSV-pPDh0NFM
```

```
wrangler secret put FIREBASE_SERVICE_ACCOUNT
```
When prompted, paste the **entire contents** of the service-account `.json`
file you downloaded from Firebase Console → Project Settings → Service
Accounts. The whole file, as-is — don't edit or reformat it.

(Both of these can also be set from the Cloudflare dashboard instead, under
Workers & Pages → `pavilion-push` → Settings → Variables and Secrets, if
you'd rather not use the terminal for this part.)

## 5. That's it

Once the Worker's deployed and both secrets are set, notifications should
start working end to end: a player turns on "Match notifications" in the app
→ a new match gets created (or someone's promoted off a waitlist) → this
Worker relays it to their device.

## 6. Live video setup (only needed for the "Go Live" feature)

This is a separate, optional credential — skip this section entirely if
you're not using live match video. This uses **Cloudflare RealtimeKit**,
confirmed to need no card on file to create an app and start using it
(free during its current Beta; see the plan doc for what happens if that
ever changes).

Cloudflare retired RealtimeKit's original standalone API/dashboard
(`dash.realtime.cloudflare.com`) partway through this build, so setup now
goes through the main Cloudflare dashboard and a regular API Token instead
of an Org ID + API key pair.

1. In the Cloudflare dashboard, go to **Realtime** in the left sidebar →
   **RealtimeKit** → **Create app**. Give it any name (e.g.
   `pavilion-live`) — you've likely already done this step.
2. Find two IDs:
   - Your **Cloudflare Account ID** — shown on the right-hand side of
     almost any page in the dashboard (or under **Account Home**).
   - The RealtimeKit **App ID** — on the `pavilion-live` app's own page
     (Media → Realtime → RealtimeKit → the app).
3. Create an API Token: dashboard → click your profile icon → **My
   Profile** → **API Tokens** → **Create Token** → give it the
   **Realtime Admin** permission (custom token) → create, then copy the
   token (shown once).
4. Check the **Presets** tab for your app. This app expects two presets
   named `group_call_host` (full publish rights — the broadcaster) and
   `group_call_participant` (everyone else — the app itself never asks
   viewers to publish anything, regardless of what the preset technically
   allows). If your account's presets are named differently, either rename
   them to match, or set the two optional secrets below to whatever names
   your account actually uses.

   (Not `livestream_host`/`livestream_viewer`, despite those existing too
   and sounding like the obvious fit — RealtimeKit's Interactive Livestream
   feature calls a Cloudflare API domain that's since been retired, and
   404s for every viewer as of writing. Plain meeting presets sidestep that
   entirely — Cloudflare's SFU still only asks the broadcaster's phone for
   one upload no matter how many viewers connect either way.)
5. From inside this `cloudflare-worker` folder:
   ```
   wrangler secret put REALTIMEKIT_ACCOUNT_ID
   ```
   Paste the Account ID when prompted.
   ```
   wrangler secret put REALTIMEKIT_APP_ID
   ```
   Paste the App ID when prompted.
   ```
   wrangler secret put REALTIMEKIT_API_TOKEN
   ```
   Paste the API Token when prompted.

   Only if your preset names differ from step 4's defaults:
   ```
   wrangler secret put REALTIMEKIT_HOST_PRESET
   wrangler secret put REALTIMEKIT_VIEWER_PRESET
   ```
6. `wrangler deploy` again to pick these up.

Same rule as the other secrets: never paste these values into chat — only
into the `wrangler secret put` prompt, or the Cloudflare dashboard
directly. An API Token is sensitive the same way a password is; treat it
accordingly (and note it's only shown once at creation time — if you lose
it, delete that token and create a new one rather than trying to recover it).

## Redeploying after a code change

If I ever hand you an updated `worker.js`, just run `wrangler deploy` again
from this folder — no need to redo steps 2, 4, or 6 unless the secrets
themselves changed.
