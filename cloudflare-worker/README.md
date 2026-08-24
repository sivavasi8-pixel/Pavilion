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

## Redeploying after a code change

If I ever hand you an updated `worker.js`, just run `wrangler deploy` again
from this folder — no need to redo steps 2 or 4 unless the secrets
themselves changed.
