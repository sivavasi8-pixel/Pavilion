# Security model & known trade-offs

Pavilion has no login system by design — players and admins authenticate with a
name/PIN pair checked client-side, not Firebase Auth. That keeps the app
frictionless (no accounts to create), but it means Firestore Security Rules
can't express "only the real admin of this team" as a rule — rules have no
identity to check against. What they *can* still enforce is documented here,
along with what's knowingly left open.

## What `firestore.rules` actually enforces

- **Reads are open to anyone** (`allow read: if true`), for every document in
  `nets_data`. Needed because the app itself has no auth to gate reads with —
  it reads PIN hashes, votes, and payments straight from the client.
- **Writes are restricted to known document-ID shapes** (`teamCode__players`,
  `teamCode__adminPin`, `teamCode__photo_<id>`, etc.) and a size cap per field
  — but **not** to any particular writer's identity, because there isn't one.
- **`superAdminPin` is locked to create-once** (fixed 2026-08-11). The app
  never rewrites this document after first setup, so this was a free,
  zero-risk close of the worst hole: previously anyone could overwrite it and
  take over the entire platform (approve/reject any team, reset any team's
  admin PIN, suspend/delete any team) with one Firestore write, no login
  required.
- **Deletes are blocked entirely** — nothing in the app deletes documents, so
  this is denied outright as a safety net.

## What's knowingly still open (accepted 2026-08-11)

- **Any `<team>__adminPin`, `pins`, `payments`, `days`, `matches`, `rates`,
  etc. is writable by anyone who knows (or guesses) that team's code** — no
  identity check beyond the document-ID pattern matching. Someone with the
  code and a browser console could overwrite a team's admin PIN, forge
  attendance or "paid" status, or unlock a locked month directly via the
  Firestore SDK, bypassing every PIN gate in the app's UI.
- **`teamsIndex` is fully readable by anyone**, including every team's
  `requestedBy` name and `contactNumber` — not just approved teams shown in
  the landing screen's suggestions, but pending/rejected/suspended ones too.
- **PINs are 4 digits.** Reads being open means anyone who reads a `pins` or
  `adminPin` document can crack the actual PIN offline in well under a
  second (SHA-256 is fast) — there's no rate limiting, and none is possible
  purely at the rules layer without an authenticated backend.

**Why this is accepted for now:** no money actually moves through the app —
payments are a claimed/confirmed status, settled by UPI or cash outside it.
Worst case here is data mischief (forged records, a hijacked club) or a PII
leak (phone numbers), not theft. For a casual club tool at this scale, that's
judged an acceptable trade-off against the cost of adding real backend auth.

## If this gets revisited

Two directions were considered, in increasing order of effort:

1. **Rules-only tightening** — require privileged writes (e.g. changing
   `adminPin`, marking a payment paid) to include the correct PIN hash, which
   the rule verifies server-side via `get()` against the sibling document
   before allowing the write. No login system added, but the rules get
   meaningfully more complex and would need careful testing before deploying.
2. **Real auth layer** — move privileged writes behind Firebase Auth (e.g.
   anonymous auth + a Cloud Function that checks PINs server-side and mints
   custom claims Firestore rules can trust). Closes the gap properly, but is
   a genuine architecture change — new moving parts, more to maintain.

Neither has been started. If the app's stakes change (real payments start
flowing through it, or it grows past a single trusted club), this is the
first thing to revisit.
