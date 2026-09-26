// Pavilion Worker — three jobs living on one Worker:
//
// 1. Push-notification relay (POST /) — receives { secret, tokens, title,
//    body } from index.html, checks the shared secret, sends to Firebase
//    Cloud Messaging.
// 2. Tap-to-pay QR card (GET /qr-image, GET /p/:token) — serves a match's
//    payment QR as a real fetchable image, and a tiny page whose WhatsApp
//    link-preview thumbnail IS that QR — tapping the resulting card in
//    WhatsApp (image included) opens the page, which bounces straight
//    into the UPI app. /p/:token only carries team+matchId — the amount,
//    UPI id, and payee name are looked up here from Firestore rather than
//    riding along in the URL, so the link isn't the whole message's worth
//    of query string when it lands as visible text in WhatsApp.
//    /m/:token + /banner-image do the same for a match's uploaded banner —
//    the availability message links to /m/:token so WhatsApp shows the
//    poster as a card.
//    /qr-image-sub and /sp/:token are the same trick for nets-fee
//    subscription payments instead of a match — /sp/:token carries
//    team+monthKey (there's no match to point at), and the amount comes
//    from the team's rates.subAmount instead of a match's totalCost split.
// 3. Live video broker (POST /live/start, /live/join, /live/end) — a thin,
//    authenticated relay between the browser and Cloudflare RealtimeKit's
//    own REST API. The browser never sees the RealtimeKit API key; it only
//    ever talks to this Worker, which holds that key and makes the real
//    calls on its behalf — the same "Worker holds the secret, the app
//    never does" shape as the other two jobs above. Every /live/* route is
//    gated by the same PUSH_SHARED_SECRET already baked into index.html,
//    so a stranger who finds this Worker's URL can't spend the team's free
//    RealtimeKit quota.
//
// All three share the same kind of setup: real credentials live ONLY in
// this Worker's own secret storage, never in the app's client-side code.
//
// Required secrets (set via `wrangler secret put <NAME>`, or the
// Cloudflare dashboard: Workers & Pages → this Worker → Settings →
// Variables and Secrets):
//   PUSH_SHARED_SECRET   - must match PUSH_SHARED_SECRET in index.html
//   FIREBASE_SERVICE_ACCOUNT - the *entire* contents of the service-account
//                               JSON file downloaded from Firebase Console
//                               → Project Settings → Service Accounts,
//                               pasted in as one string.
//   REALTIMEKIT_ACCOUNT_ID - your Cloudflare account ID (shown on almost
//                             every page of the Cloudflare dashboard).
//   REALTIMEKIT_APP_ID     - the RealtimeKit app's own id (from its page
//                             under Media → Realtime → RealtimeKit).
//   REALTIMEKIT_API_TOKEN  - a Cloudflare API Token (dashboard → My
//                             Profile → API Tokens → Create Token),
//                             scoped to the "Realtime Admin" permission.
//   REALTIMEKIT_HOST_PRESET   - optional; defaults to "group_call_host" if
//                                unset. Only needs setting if your account's
//                                preset is named differently. (Not
//                                "livestream_host" — RealtimeKit's
//                                Interactive Livestream feature calls a
//                                retired legacy API domain internally as of
//                                writing and 404s for every viewer, so this
//                                app uses a plain WebRTC meeting preset
//                                instead. Cloudflare's SFU still forwards
//                                video server-side under this preset too —
//                                one broadcaster upload regardless of
//                                viewer count — so nothing about the actual
//                                scaling story changes.)
//   REALTIMEKIT_VIEWER_PRESET - optional; defaults to "group_call_participant"
//                                if unset, same idea as the host preset.

function base64UrlEncode(input) {
  let binary;
  if (typeof input === "string") {
    binary = input;
  } else {
    const bytes = new Uint8Array(input);
    binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

// Standard Google service-account JWT-bearer flow, using the Workers
// runtime's built-in Web Crypto — no external JWT library needed. Scopes
// is a list so the same helper covers both jobs this Worker does — an FCM
// send only ever needs the messaging scope; reading Firestore for the QR
// card needs the datastore (read) scope instead.
async function getAccessToken(serviceAccount, scopes) {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: serviceAccount.client_email,
    scope: scopes.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(serviceAccount.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64UrlEncode(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Token exchange failed: " + JSON.stringify(data));
  return data.access_token;
}

// The browser calling POST / from index.html is always a cross-origin
// request (web.app → workers.dev), which means every response — including
// the automatic OPTIONS preflight the browser sends before the real POST —
// needs these headers, or the browser blocks the request before it ever
// reaches the code below. Wildcard origin is fine here: the shared secret
// already gates actual use, and this endpoint has nothing to read back
// that would matter if another site could see the response. The QR-card
// routes below don't need these at all — they're opened as normal
// navigations/image loads, never fetched cross-origin from JS.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function loadServiceAccount(env) {
  try {
    return JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  } catch {
    return null;
  }
}

// Reads one nets_data/{docId} document via the Firestore REST API and
// returns just its `value` string (the same shape window.storage.get
// already unwraps client-side) — or null if it doesn't exist. Firestore's
// REST responses wrap every field in a type tag (stringValue, mapValue,
// ...), unlike the SDK's plain JSON, so this is the one bit of translation
// needed to read the same documents the app itself writes.
async function firestoreGetValue(projectId, accessToken, docId) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/nets_data/${encodeURIComponent(docId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return null;
  const doc = await res.json();
  const val = doc.fields && doc.fields.value && doc.fields.value.stringValue;
  return val || null;
}

// Same read as firestoreGetValue, but keeps the HTTP status and error body
// instead of collapsing every failure to a silent null — used where a
// missing/forbidden doc needs to say which one it was, rather than being
// indistinguishable from "the match just isn't in there".
async function firestoreGetDoc(projectId, accessToken, docId) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/nets_data/${encodeURIComponent(docId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (res.status === 404) return { found: false, status: 404, value: null, error: null };
  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    return { found: false, status: res.status, value: null, error: errorBody.slice(0, 300) };
  }
  const doc = await res.json();
  const val = doc.fields && doc.fields.value && doc.fields.value.stringValue;
  return { found: true, status: res.status, value: val || null, error: null };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Reverse of the encoding index.html's buildPayCardUrl does client-side —
// plain base64url back to the original "team:matchId" string.
function base64UrlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(str.length + ((4 - (str.length % 4)) % 4), "=");
  return atob(padded);
}

// Same rule index.html's computePlayedIds uses to decide who actually
// played (and so who the fee splits across) — ported here so the Worker
// can work out the per-player amount itself instead of trusting a number
// passed in the URL.
function computePlayedIds(match) {
  const availableIds = match.available || [];
  if (match.playedExclusions) {
    return availableIds.filter((id) => !match.playedExclusions.includes(id));
  }
  if (match.played != null) {
    return availableIds.filter((id) => match.played.includes(id));
  }
  return availableIds;
}

// Serves a match's payment QR as a real image at a real URL — the one
// thing Firestore's embedded-base64 storage can't offer on its own, and
// exactly what WhatsApp's link-preview fetcher needs to build a card.
// Tries the match's own QR override first, then the team's default
// payment QR — the same fallback order the app's own effectiveQr already
// uses, so this never shows a different picture than the app does.
async function handleQrImage(url, env) {
  const team = url.searchParams.get("team");
  const matchId = url.searchParams.get("match");
  if (!team || !matchId) return new Response("Missing team or match", { status: 400 });

  const serviceAccount = loadServiceAccount(env);
  if (!serviceAccount) return new Response("Server misconfigured", { status: 500 });

  let accessToken;
  try {
    accessToken = await getAccessToken(serviceAccount, ["https://www.googleapis.com/auth/datastore"]);
  } catch (e) {
    return new Response("Auth failed: " + e.message, { status: 500 });
  }

  const projectId = serviceAccount.project_id;
  let dataUrl = await firestoreGetValue(projectId, accessToken, `${team}__photo_qr_${matchId}`);
  if (!dataUrl) {
    const defaultRaw = await firestoreGetValue(projectId, accessToken, `${team}__paymentDefault`);
    if (defaultRaw) {
      try {
        dataUrl = JSON.parse(defaultRaw).qr || null;
      } catch {
        dataUrl = null;
      }
    }
  }

  if (!dataUrl || !dataUrl.startsWith("data:")) {
    return new Response("Not found", { status: 404 });
  }

  const parsed = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!parsed) return new Response("Bad image data", { status: 500 });
  const mime = parsed[1];
  const binary = atob(parsed[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return new Response(bytes, {
    headers: { "Content-Type": mime, "Cache-Control": "public, max-age=3600" },
  });
}

// Same job as handleQrImage above, but for nets-fee/subscription payments
// instead of a match — team-wide, not per-month, so there's no per-match
// override to check first here. Nets-fee config only: this used to fall
// back to the match default (paymentDefault) whenever no subscription QR
// was set, which meant a player paying their monthly subscription could
// see the match's QR. Now it just 404s until a nets-fee QR is actually
// uploaded in Settings — the app's own effectiveSubQr (Subscription tab)
// and the message builders in index.html all made the same change.
async function handleSubQrImage(url, env) {
  const team = url.searchParams.get("team");
  if (!team) return new Response("Missing team", { status: 400 });

  const serviceAccount = loadServiceAccount(env);
  if (!serviceAccount) return new Response("Server misconfigured", { status: 500 });

  let accessToken;
  try {
    accessToken = await getAccessToken(serviceAccount, ["https://www.googleapis.com/auth/datastore"]);
  } catch (e) {
    return new Response("Auth failed: " + e.message, { status: 500 });
  }

  const projectId = serviceAccount.project_id;
  let dataUrl = null;
  const subRaw = await firestoreGetValue(projectId, accessToken, `${team}__subscriptionPaymentDefault`);
  if (subRaw) {
    try { dataUrl = JSON.parse(subRaw).qr || null; } catch { dataUrl = null; }
  }

  if (!dataUrl || !dataUrl.startsWith("data:")) {
    return new Response("Not found", { status: 404 });
  }

  const parsed = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!parsed) return new Response("Bad image data", { status: 500 });
  const mime = parsed[1];
  const binary = atob(parsed[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return new Response(bytes, {
    headers: { "Content-Type": mime, "Cache-Control": "public, max-age=3600" },
  });
}

// The actual link that goes in the WhatsApp message — /p/<token>, where
// token is just base64url("team:matchId"). Everything else (amount, UPI
// id, payee name) is looked up here rather than carried in the URL.
// WhatsApp's own preview-fetcher only ever reads the <meta> tags below —
// it doesn't run the redirect script — so it always builds the card
// correctly regardless of what a real visitor's browser does next.
async function handlePayCard(url, env, token) {
  let team = "";
  let matchId = "";
  try {
    const decoded = base64UrlDecode(token);
    const sep = decoded.indexOf(":");
    if (sep === -1) throw new Error("bad token");
    team = decoded.slice(0, sep);
    matchId = decoded.slice(sep + 1);
  } catch {
    return new Response("Bad link", { status: 400 });
  }
  if (!team || !matchId) return new Response("Bad link", { status: 400 });

  const serviceAccount = loadServiceAccount(env);
  if (!serviceAccount) return new Response("Server misconfigured", { status: 500 });

  let accessToken;
  try {
    accessToken = await getAccessToken(serviceAccount, ["https://www.googleapis.com/auth/datastore"]);
  } catch (e) {
    return new Response("Auth failed: " + e.message, { status: 500 });
  }

  const projectId = serviceAccount.project_id;
  // The matches doc uses the diagnostic reader — everything else stays on
  // the plain one, since paymentDefault/teamsIndex missing is a normal,
  // already-handled case ("no default QR set yet"), but "matches" missing
  // or unreadable is the one failure that otherwise looked identical to
  // "that match id doesn't exist", which is what made this hard to debug
  // from the outside.
  const [matchesDoc, defaultRaw, teamsIndexRaw] = await Promise.all([
    firestoreGetDoc(projectId, accessToken, `${team}__matches`),
    firestoreGetValue(projectId, accessToken, `${team}__paymentDefault`),
    firestoreGetValue(projectId, accessToken, "teamsIndex"),
  ]);

  if (!matchesDoc.found) {
    const detail = matchesDoc.status === 404
      ? `no "matches" record exists for team "${team}"`
      : `Firestore read failed (HTTP ${matchesDoc.status})${matchesDoc.error ? " — " + matchesDoc.error : ""}`;
    return new Response(`Could not load match data: ${detail}`, { status: 502 });
  }

  let matches = {};
  try {
    // Stored (and kept in React state) as an object keyed by match id —
    // { [id]: match } — not an array, same shape index.html's own
    // matches/setMatches state uses everywhere else.
    matches = matchesDoc.value ? JSON.parse(matchesDoc.value) : {};
  } catch (e) {
    return new Response(`Could not load match data: matches record wasn't valid JSON (${e.message})`, { status: 502 });
  }
  const match = matches[matchId] || null;
  if (!match) {
    return new Response(`Match not found: team "${team}" has ${Object.keys(matches).length} match(es) on record, none with id "${matchId}"`, { status: 404 });
  }

  let paymentDefault = {};
  try {
    paymentDefault = defaultRaw ? JSON.parse(defaultRaw) : {};
  } catch {
    paymentDefault = {};
  }

  let payeeName = "Pavilion";
  try {
    const teamsIndex = teamsIndexRaw ? JSON.parse(teamsIndexRaw) : {};
    if (teamsIndex[team] && teamsIndex[team].teamName) payeeName = teamsIndex[team].teamName;
  } catch {
    // fall through with the default name
  }

  const upiId = (match.upiNumber || paymentDefault.upiNumber || "").trim();
  const playedCount = computePlayedIds(match).length;
  const amount = match.totalCost && playedCount ? Math.round((Number(match.totalCost) / playedCount) * 100) / 100 : 0;

  const imageUrl = `${url.origin}/qr-image?team=${encodeURIComponent(team)}&match=${encodeURIComponent(matchId)}`;
  const upiParams = new URLSearchParams();
  if (upiId) upiParams.set("pa", upiId);
  upiParams.set("pn", payeeName);
  if (amount) upiParams.set("am", String(amount));
  upiParams.set("cu", "INR");
  const upiLink = upiId ? `upi://pay?${upiParams.toString()}` : "";
  const title = amount ? `Pay ₹${amount} — Match Fee` : "Match Fee Payment";

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="Tap to pay via UPI">
<meta property="og:image" content="${imageUrl}">
<meta property="og:type" content="website">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #16301F; color: #F3EEDF; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; text-align: center; }
  img { width: 160px; height: 160px; border-radius: 12px; background: #fff; margin-bottom: 20px; object-fit: contain; }
  a.btn { background: #C08A45; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; display: inline-block; margin-top: 16px; }
</style>
</head>
<body>
  <img src="${imageUrl}" alt="Payment QR" />
  <div>${escapeHtml(title)}</div>
  ${upiLink ? `<a class="btn" href="${upiLink}">Tap to pay</a>` : `<div style="margin-top:16px;color:#B7C4B8;font-size:13px;">Scan the QR above to pay</div>`}
  ${upiLink ? `<script>
    // A visible fallback button is above regardless — some mobile
    // browsers only allow a page to redirect after a real tap, so this
    // automatic attempt isn't guaranteed to fire on every device.
    setTimeout(function () { window.location.href = ${JSON.stringify(upiLink)}; }, 300);
  </script>` : ""}
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// The published app's address — where the tap-through page's "Open
// Pavilion" button goes. Fixed rather than derived because this Worker
// lives on a different origin (workers.dev) from the app (web.app).
const APP_URL = "https://cricket-nets-tracker.web.app/";
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

// A match's uploaded banner as a real fetchable image — the same job
// handleQrImage does for payment QRs. Banners live in their own
// photo_banner_<matchId> document (see matchBannerKey in index.html), so
// this works even for a match that's since been moved into an archive
// year and no longer appears in the live matches document.
async function handleBannerImage(url, env) {
  const team = url.searchParams.get("team");
  const matchId = url.searchParams.get("match");
  if (!team || !matchId || !SAFE_ID.test(team) || !SAFE_ID.test(matchId)) return new Response("Missing or bad team/match", { status: 400 });

  const serviceAccount = loadServiceAccount(env);
  if (!serviceAccount) return new Response("Server misconfigured", { status: 500 });

  let accessToken;
  try {
    accessToken = await getAccessToken(serviceAccount, ["https://www.googleapis.com/auth/datastore"]);
  } catch (e) {
    return new Response("Auth failed: " + e.message, { status: 500 });
  }

  const dataUrl = await firestoreGetValue(serviceAccount.project_id, accessToken, `${team}__photo_banner_${matchId}`);
  if (!dataUrl || !dataUrl.startsWith("data:")) return new Response("Not found", { status: 404 });

  const parsed = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!parsed) return new Response("Bad image data", { status: 500 });
  const binary = atob(parsed[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Response(bytes, { headers: { "Content-Type": parsed[1], "Cache-Control": "public, max-age=3600" } });
}

// "07:00" -> "7:00 AM". Anything else (an older free-text time like
// "11:30 AM") passes through unchanged — same rule index.html's
// formatTimeDisplay uses.
function formatMatchTime(value) {
  const s = String(value || "").trim();
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) return s;
  let h = Number(m[1]);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ampm}`;
}

// The link that goes in the availability WhatsApp message — /m/<token>
// with token = base64url("team:matchId"), same shape as /p/<token>. Its
// og:image is the match's banner, so WhatsApp builds a card with the
// poster as the picture; tapping it lands on the page below (full banner,
// the essentials, and a way into the app).
async function handleMatchCard(url, env, token) {
  let team = "";
  let matchId = "";
  try {
    const decoded = base64UrlDecode(token);
    const sep = decoded.indexOf(":");
    if (sep === -1) throw new Error("bad token");
    team = decoded.slice(0, sep);
    matchId = decoded.slice(sep + 1);
  } catch {
    return new Response("Bad link", { status: 400 });
  }
  if (!team || !matchId || !SAFE_ID.test(team) || !SAFE_ID.test(matchId)) return new Response("Bad link", { status: 400 });

  const serviceAccount = loadServiceAccount(env);
  if (!serviceAccount) return new Response("Server misconfigured", { status: 500 });

  let accessToken;
  try {
    accessToken = await getAccessToken(serviceAccount, ["https://www.googleapis.com/auth/datastore"]);
  } catch (e) {
    return new Response("Auth failed: " + e.message, { status: 500 });
  }

  const projectId = serviceAccount.project_id;
  const [matchesRaw, teamsIndexRaw] = await Promise.all([
    firestoreGetValue(projectId, accessToken, `${team}__matches`),
    firestoreGetValue(projectId, accessToken, "teamsIndex"),
  ]);

  let match = null;
  try { match = (matchesRaw ? JSON.parse(matchesRaw) : {})[matchId] || null; } catch { match = null; }
  let teamName = "Pavilion";
  try {
    const idx = teamsIndexRaw ? JSON.parse(teamsIndexRaw) : {};
    if (idx[team] && idx[team].teamName) teamName = idx[team].teamName;
  } catch {
    // keep the default name
  }

  // A match that's been archived or deleted since the message went out
  // still has its banner, so the card degrades to just the picture and the
  // team name instead of erroring.
  const title = match ? `${match.matchType || "Match"} — ${match.groundName || "TBD"}` : `${teamName} match`;
  const dateText = match && match.date
    ? new Date(match.date + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })
    : "";
  const timeText = match ? formatMatchTime(match.time) : "";
  const when = [dateText, timeText].filter(Boolean).join(" · ");
  const details = match
    ? [when, match.overs ? `${match.overs} overs` : "", match.ballType || "", match.groundName || ""].filter(Boolean)
    : [];

  const imageUrl = `${url.origin}/banner-image?team=${encodeURIComponent(team)}&match=${encodeURIComponent(matchId)}`;
  const appLink = `${APP_URL}?team=${encodeURIComponent(team)}`;
  const description = when ? `${when} — tap to view` : "Tap to view";
  // The Location line in the availability message carries this card's link
  // instead of the raw Maps URL (WhatsApp always shows a link's text, so
  // one link does both jobs), and tapping it still has to end up at the
  // ground like the Maps link always did. Redirected in the page, not with
  // an HTTP 302: WhatsApp's fetcher follows redirects, so a 302 would make
  // it preview Google Maps and the banner card would never appear. It only
  // reads this page's meta tags and doesn't run its script, so people
  // bounce to the location and the card keeps its banner.
  const locationUrl = match && /^https?:\/\//i.test(String(match.locationUrl || "").trim()) ? String(match.locationUrl).trim() : "";

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${imageUrl}">
<meta property="og:type" content="website">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #16301F; color: #F3EEDF; margin: 0; padding: 16px; display: flex; flex-direction: column; align-items: center; }
  .card { width: 100%; max-width: 420px; }
  img { width: 100%; height: auto; border-radius: 12px; display: block; background: #1F4530; }
  h1 { font-size: 20px; margin: 16px 0 6px; }
  .meta { font-size: 14px; color: #B7C4B8; line-height: 1.6; }
  a.btn { background: #C08A45; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; display: block; text-align: center; margin-top: 18px; }
  a.btn2 { color: #B7C4B8; text-decoration: underline; display: block; text-align: center; margin-top: 12px; font-size: 13px; }
  .team { font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: #C08A45; font-weight: 700; margin-top: 4px; }
</style>
</head>
<body>
  <div class="card">
    <img src="${imageUrl}" alt="Match banner" />
    <div class="team">${escapeHtml(teamName)}</div>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">${details.map(escapeHtml).join("<br>")}</div>
    ${locationUrl
      ? `<a class="btn" href="${escapeHtml(locationUrl)}">Open location</a>
    <a class="btn2" href="${appLink}">Open Pavilion to confirm</a>`
      : `<a class="btn" href="${appLink}">Open Pavilion to confirm</a>`}
  </div>
  ${locationUrl ? `<script>location.replace(${JSON.stringify(locationUrl).replace(/</g, "\\u003c")});</script>` : ""}
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// Same job as handlePayCard above, for nets-fee/subscription payments.
// token is base64url("team:monthKey") instead of "team:matchId" — a
// subscription doesn't have a match to point at, just a team and which
// month it's for. The amount comes from the team's rates.subAmount
// (a fixed per-player figure) rather than being split across playedCount
// the way a match's totalCost is, so there's no matches doc to read here.
async function handleSubPayCard(url, env, token) {
  let team = "";
  let monthKeyStr = "";
  try {
    const decoded = base64UrlDecode(token);
    const sep = decoded.indexOf(":");
    if (sep === -1) throw new Error("bad token");
    team = decoded.slice(0, sep);
    monthKeyStr = decoded.slice(sep + 1);
  } catch {
    return new Response("Bad link", { status: 400 });
  }
  if (!team || !monthKeyStr) return new Response("Bad link", { status: 400 });

  const serviceAccount = loadServiceAccount(env);
  if (!serviceAccount) return new Response("Server misconfigured", { status: 500 });

  let accessToken;
  try {
    accessToken = await getAccessToken(serviceAccount, ["https://www.googleapis.com/auth/datastore"]);
  } catch (e) {
    return new Response("Auth failed: " + e.message, { status: 500 });
  }

  const projectId = serviceAccount.project_id;
  // Nets-fee config only — no paymentDefault (match) read here anymore, so
  // there's nothing left to fall back to for the UPI id below either.
  const [subRaw, ratesRaw, teamsIndexRaw] = await Promise.all([
    firestoreGetValue(projectId, accessToken, `${team}__subscriptionPaymentDefault`),
    firestoreGetValue(projectId, accessToken, `${team}__rates`),
    firestoreGetValue(projectId, accessToken, "teamsIndex"),
  ]);

  let subDefault = {};
  try { subDefault = subRaw ? JSON.parse(subRaw) : {}; } catch { subDefault = {}; }

  let payeeName = "Pavilion";
  try {
    const teamsIndex = teamsIndexRaw ? JSON.parse(teamsIndexRaw) : {};
    if (teamsIndex[team] && teamsIndex[team].teamName) payeeName = teamsIndex[team].teamName;
  } catch {
    // fall through with the default name
  }

  let subAmount = 1000; // same DEFAULT_RATES.subAmount fallback index.html itself uses
  try {
    const rates = ratesRaw ? JSON.parse(ratesRaw) : {};
    if (rates.subAmount) subAmount = Number(rates.subAmount) || subAmount;
  } catch {
    // fall through with the default amount
  }

  const upiId = (subDefault.upiNumber || "").trim();

  const imageUrl = `${url.origin}/qr-image-sub?team=${encodeURIComponent(team)}`;
  const upiParams = new URLSearchParams();
  if (upiId) upiParams.set("pa", upiId);
  upiParams.set("pn", payeeName);
  if (subAmount) upiParams.set("am", String(subAmount));
  upiParams.set("cu", "INR");
  const upiLink = upiId ? `upi://pay?${upiParams.toString()}` : "";
  const title = `Pay ₹${subAmount} — Nets Subscription`;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="Tap to pay via UPI">
<meta property="og:image" content="${imageUrl}">
<meta property="og:type" content="website">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #16301F; color: #F3EEDF; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; text-align: center; }
  img { width: 160px; height: 160px; border-radius: 12px; background: #fff; margin-bottom: 20px; object-fit: contain; }
  a.btn { background: #C08A45; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; display: inline-block; margin-top: 16px; }
</style>
</head>
<body>
  <img src="${imageUrl}" alt="Payment QR" />
  <div>${escapeHtml(title)}</div>
  ${upiLink ? `<a class="btn" href="${upiLink}">Tap to pay</a>` : `<div style="margin-top:16px;color:#B7C4B8;font-size:13px;">Scan the QR above to pay</div>`}
  ${upiLink ? `<script>
    setTimeout(function () { window.location.href = ${JSON.stringify(upiLink)}; }, 300);
  </script>` : ""}
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function handlePushSend(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response("Bad request", { status: 400, headers: CORS_HEADERS });
  }

  if (!payload.secret || payload.secret !== env.PUSH_SHARED_SECRET) {
    return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
  }

  // Capped well above any realistic squad size — a sanity limit, not a
  // real quota control.
  const tokens = Array.isArray(payload.tokens) ? payload.tokens.filter(Boolean).slice(0, 500) : [];
  if (tokens.length === 0) {
    return new Response(JSON.stringify({ ok: true, sent: 0 }), {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  const title = String(payload.title || "Pavilion").slice(0, 200);
  const body = String(payload.body || "").slice(0, 500);

  const serviceAccount = loadServiceAccount(env);
  if (!serviceAccount) {
    return new Response("Server misconfigured (bad FIREBASE_SERVICE_ACCOUNT secret)", { status: 500, headers: CORS_HEADERS });
  }

  let accessToken;
  try {
    accessToken = await getAccessToken(serviceAccount, ["https://www.googleapis.com/auth/firebase.messaging"]);
  } catch (e) {
    return new Response("Auth to Firebase failed: " + e.message, { status: 500, headers: CORS_HEADERS });
  }

  const projectId = serviceAccount.project_id;
  const results = await Promise.allSettled(
    tokens.map((token) =>
      fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        // `data`, not `notification` — a top-level `notification` field
        // makes the browser's own push service auto-display a system
        // notification on its own, in addition to (not instead of) the
        // one sw.js's onBackgroundMessage/foreground onMessage handler
        // builds — that's what caused every push to arrive twice.
        // data-only puts the app in full, single control of what's shown.
        body: JSON.stringify({
          message: {
            token,
            data: { title, body },
          },
        }),
      })
    )
  );

  const sent = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;
  return new Response(JSON.stringify({ ok: true, sent, total: tokens.length }), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ---- Live video (Cloudflare RealtimeKit) ----
// https://api.cloudflare.com/client/v4/accounts/{accountId}/realtime/kit/
// {appId}/... — Cloudflare's current, unified API for RealtimeKit,
// Bearer-token authenticated with a real Cloudflare API Token (scoped to
// the "Realtime Admin" permission), entirely separate from the
// Firebase/Google credential used above. This replaces an earlier,
// now-retired standalone RealtimeKit API (Org ID + API key, Basic auth) —
// Cloudflare shut that one down mid-build, hence the Bearer-token shape
// here rather than Basic. RealtimeKit is a meeting layer built on top of
// Cloudflare's own Realtime SFU: creating a "meeting" and adding
// participants under a preset (host vs. viewer) is what raw SFU sessions
// and hand-built publish/pull track logic used to require us to do
// ourselves — the preset system does that instead.
function rtkBase(env) {
  return `https://api.cloudflare.com/client/v4/accounts/${env.REALTIMEKIT_ACCOUNT_ID}/realtime/kit/${env.REALTIMEKIT_APP_ID}`;
}

async function rtkFetch(env, method, path, body) {
  const res = await fetch(`${rtkBase(env)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.REALTIMEKIT_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// RealtimeKit wraps every response as { success, result/data: {...} } —
// this pulls the actual object out regardless of which key a given
// endpoint uses, or whether it also happens to echo fields at the top
// level.
function rtkData(res) {
  return (res.data && (res.data.result || res.data.data)) || res.data || {};
}

// Shared front door for every /live/* route: handles the OPTIONS
// preflight, requires POST, parses the JSON body, and checks the same
// shared secret every other route already checks.
async function readLiveRequest(request, env) {
  if (request.method === "OPTIONS") return { preflight: true };
  if (request.method !== "POST") {
    return { error: new Response("Method not allowed", { status: 405, headers: CORS_HEADERS }) };
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return { error: new Response("Bad request", { status: 400, headers: CORS_HEADERS }) };
  }
  if (!payload.secret || payload.secret !== env.PUSH_SHARED_SECRET) {
    return { error: new Response("Forbidden", { status: 403, headers: CORS_HEADERS }) };
  }
  if (!env.REALTIMEKIT_ACCOUNT_ID || !env.REALTIMEKIT_APP_ID || !env.REALTIMEKIT_API_TOKEN) {
    return { error: new Response("Server misconfigured (missing REALTIMEKIT_ACCOUNT_ID/REALTIMEKIT_APP_ID/REALTIMEKIT_API_TOKEN)", { status: 500, headers: CORS_HEADERS }) };
  }
  return { payload };
}

// The broadcaster's side — opens a fresh RealtimeKit meeting for this
// match, then adds the broadcaster into it under the host preset (full
// publish rights). Returns the meeting id (goes in Firestore, so every
// viewer's device can find it) and the broadcaster's own auth token (goes
// straight into the client SDK, never touches Firestore).
async function handleLiveStart(request, env) {
  const { preflight, error, payload } = await readLiveRequest(request, env);
  if (preflight) return new Response(null, { headers: CORS_HEADERS });
  if (error) return error;
  const { matchLabel, broadcasterId, broadcasterName } = payload;

  const meetingRes = await rtkFetch(env, "POST", "/meetings", {
    title: String(matchLabel || "Pavilion Live").slice(0, 100),
    record_on_start: false,
  });
  const meetingId = rtkData(meetingRes).id;
  if (!meetingRes.ok || !meetingId) {
    return new Response(`Could not start a live meeting: ${JSON.stringify(meetingRes.data)}`, { status: 502, headers: CORS_HEADERS });
  }

  const hostPreset = env.REALTIMEKIT_HOST_PRESET || "group_call_host";
  const participantRes = await rtkFetch(env, "POST", `/meetings/${meetingId}/participants`, {
    name: String(broadcasterName || "Broadcaster").slice(0, 60),
    preset_name: hostPreset,
    custom_participant_id: String(broadcasterId || crypto.randomUUID()),
  });
  const token = rtkData(participantRes).token;
  if (!participantRes.ok || !token) {
    return new Response(`Could not join as host: ${JSON.stringify(participantRes.data)}`, { status: 502, headers: CORS_HEADERS });
  }

  return new Response(JSON.stringify({ meetingId, authToken: token }), { headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

// A viewer's side — adds them into the broadcaster's already-open meeting
// under the viewer preset (watch-only by default, can't accidentally
// publish their own camera/mic).
async function handleLiveJoin(request, env) {
  const { preflight, error, payload } = await readLiveRequest(request, env);
  if (preflight) return new Response(null, { headers: CORS_HEADERS });
  if (error) return error;
  const { meetingId, viewerId, viewerName } = payload;
  if (!meetingId) {
    return new Response("Missing meetingId", { status: 400, headers: CORS_HEADERS });
  }

  const viewerPreset = env.REALTIMEKIT_VIEWER_PRESET || "group_call_participant";
  const participantRes = await rtkFetch(env, "POST", `/meetings/${meetingId}/participants`, {
    name: String(viewerName || "Viewer").slice(0, 60),
    preset_name: viewerPreset,
    custom_participant_id: String(viewerId || crypto.randomUUID()),
  });
  const token = rtkData(participantRes).token;
  if (!participantRes.ok || !token) {
    return new Response(`Could not join as viewer: ${JSON.stringify(participantRes.data)}`, { status: 502, headers: CORS_HEADERS });
  }

  return new Response(JSON.stringify({ authToken: token }), { headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

// Called when the broadcaster taps "End broadcast" — best-effort; the
// browser leaves the meeting on its own regardless, and Firestore's own
// liveMeetingId being cleared is what actually drives every viewer's UI
// back to normal. This just also tells RealtimeKit the meeting is done, so
// a stale meeting id can't be rejoined later.
async function handleLiveEnd(request, env) {
  const { preflight, error, payload } = await readLiveRequest(request, env);
  if (preflight) return new Response(null, { headers: CORS_HEADERS });
  if (error) return error;
  const { meetingId } = payload;
  if (!meetingId) {
    return new Response("Missing meetingId", { status: 400, headers: CORS_HEADERS });
  }
  const res = await rtkFetch(env, "PATCH", `/meetings/${meetingId}`, { status: "INACTIVE" });
  return new Response(JSON.stringify({ ok: true, deactivated: res.ok }), { headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/qr-image") return await handleQrImage(url, env);
      if (url.pathname === "/qr-image-sub") return await handleSubQrImage(url, env);
      if (url.pathname === "/banner-image") return await handleBannerImage(url, env);
      if (url.pathname.startsWith("/m/")) return await handleMatchCard(url, env, url.pathname.slice(3));
      if (url.pathname.startsWith("/p/")) return await handlePayCard(url, env, url.pathname.slice(3));
      if (url.pathname.startsWith("/sp/")) return await handleSubPayCard(url, env, url.pathname.slice(4));
      if (url.pathname === "/live/start") return await handleLiveStart(request, env);
      if (url.pathname === "/live/join") return await handleLiveJoin(request, env);
      if (url.pathname === "/live/end") return await handleLiveEnd(request, env);
      return await handlePushSend(request, env);
    } catch (e) {
      // Without this, any uncaught exception anywhere above surfaces to
      // the visitor as Cloudflare's generic "Error 1101" page, which hides
      // the actual JS error entirely — useless for tracking down what
      // broke. This turns it back into a readable message instead.
      return new Response("Worker error: " + (e && e.stack ? e.stack : String(e)), { status: 500 });
    }
  },
};
