# HNC CRM — Development Guide

This document is the source of truth for how to build new features without breaking what's already working.
Read it at the start of every session before touching any code.

---

## Token-Efficient Editing Rules

### Do the work, don't hand it back to Dane.

Claude deploys directly — Dane is not in the deploy loop. When Dane asks for a fix: clone (or reuse) the repo in Claude's own environment, do surgical `str_replace` edits, sanity-check with `node --check`, commit, and push. Vercel auto-deploys from `main` in ~60s. Test against the live site, loop until it works.

Don't generate Claude Code prompts, don't output the patched file for Dane to copy, don't tell Dane to run git commands. The only acceptable fallback is if `git push` itself fails (auth, network) — in which case report the failure plainly and don't pretend the deploy happened.

### One problem, one fix, one deploy, one test — then loop.

Don't propose multiple options or ask clarifying questions about code. Pick the right fix, deploy it, test it against the live site, and iterate until it works. After it works, give a brief summary. No long postambles.

### Update this guide after every successful change — not at session end.

After every change that ships (code or migration), the very next action is updating `DEVELOPMENT_GUIDE.md` to reflect it. Don't batch guide updates for the end of a session and don't move to the next task until the guide is current. The chain is: edit → commit → push → verify deploy → update guide → commit guide → push guide → next task. Skipping the guide update means the next session starts blind.


The single-file `index.html` is large (6500+ lines). To prevent token exhaustion and resume cycles:

1. **Never view the full `index.html`.** Always use `grep -n` to locate the relevant section, then `sed -n 'X,Yp'` to extract only what you're editing.

2. **Read only what you're touching.** If editing the booking form, read just the booking form section (~100 lines), not the whole file.

3. **Make surgical edits.** Use `str_replace` with an exact match. Never rewrite large sections.

4. **Verify syntax after edits.** Run `node --check` on extracted JS to confirm no syntax errors before deploying.

5. **One problem per session.** Don't bundle multiple unrelated fixes — it increases the chance of regressions.

6. **Don't ask Dane clarifying questions about code.** He's not a developer. Use `grep` to find the answer yourself.

7. **Don't propose multiple options.** Pick the right fix and execute it. One diagnosis, one fix, one deploy.

---

## Deployment Workflow

Claude clones, edits, and pushes directly from its own environment. Dane never touches local files or git. Vercel is wired to auto-deploy from `main`.

```bash
# Once per session (skip if already cloned):
git clone https://github.com/danekreisman/hnc-crm.git /home/claude/hnc-crm

# Every edit:
cd /home/claude/hnc-crm
# ...locate with grep -n, extract with sed, edit with str_replace, verify with node --check...
git add -A
git commit -m "<concise message>"
git push origin main
```

Wait ~60s after push for Vercel to roll out, then verify against `hnc-crm.vercel.app`.

**Force redeploy** (when Vercel serves stale content):
```bash
git commit --allow-empty -m "Force redeploy" && git push origin main
```

### Auth

Claude's environment has no persistent GitHub credentials. Dane pastes a GitHub PAT (classic, `repo` scope) into chat at the start of each session. Claude uses it inline on the push URL:

```bash
git push "https://<PAT>@github.com/danekreisman/hnc-crm.git" main
```

Rules when handling the PAT:
- Use it inline on the push command. Don't write it to a file, a commit message, or any other persistent surface.
- Don't echo it back into chat unnecessarily. It's already in context once — don't repeat it.
- The PAT is rotated periodically by Dane. If a push returns `403` or auth-related errors, ask Dane for a fresh one rather than guessing.

If `git push` fails (auth, network, branch protection), report the exact error to Dane immediately. Do NOT silently fall back to outputting the patched file or asking Dane to push manually — that defeats the whole point of the new workflow. Dane's environment is no longer a dependency.

---

## Current Architecture

**Hosting:** Vercel (auto-deploys from GitHub `danekreisman/hnc-crm`)
**Database:** Supabase (PostgreSQL)
**Frontend:** Single HTML file (`index.html`) with inline JS and CSS
**Backend:** Vercel serverless functions in `/api/`

**Active integrations:**
- Supabase — core database (all data lives here)
- Stripe — invoicing and card charging (`/api/stripe-invoice.js`)
- OpenPhone/Quo — SMS sending and webhook receiver (`/api/send-sms.js`, `/api/openphone-webhook.js`)
- Resend — transactional email (`/api/send-email.js`)
- Anthropic — AI summaries (`/api/ai-summary.js`)
- Google Calendar — appointment sync (`gcal-sync.js`)

---

## Lead Form Data Flow (5-Layer Whitelist Trap)

The lead form has FIVE places that each have their own field whitelist. Adding a new lead field requires updating ALL of them or the field gets silently dropped at one of the layers.

The chain, in order:

1. **Form HTML** — `#nl-name`, `#nl-beds`, `#nl-baths`, `#nl-condition`, `#nl-freq`, etc. (in the New Lead modal)
2. **`_buildNLQuote()`** — reads form values and computes `{ total, data: {...} }`. Lives near `nlServiceChange`. The `data` object MUST use these field names or the Quote subsection won't render: `service`, `subtotal`, `discount`, `discount_pct`, `total`. Other fields are fine but those five are required by `loadSuggestedQuote`.
3. **`saveNewLead()` in-memory cache** — `leadDB[id]={...}` block populates the in-memory object IMMEDIATELY so the card renders before the Supabase round-trip. Must include: `value`, `quoteTotal`, `quoteData`, `frequency`, `condition`, `beds`, `baths`. `var _nlQ = _buildNLQuote()` MUST be declared BEFORE this block so the values are available.
4. **`dbSaveLead(data)`** — tiny wrapper (~750 chars) that does `db.from('leads').insert([{...}])` with a HARDCODED field map. Silently drops any field not in its whitelist. As of commit 849f6a5 it includes: name, contact_name, phone, email, address, service, sqft, estimated_value (mapped from `data.value`), beds, baths, condition, quote_total, quote_data, source, stage, next_action, due_date, assigned_to, notes. **If you add a new column to the leads table you MUST add it here too.**
5. **`dbLoadLeads()` → leadDB mapping** — page-load mapping that turns Supabase rows into `leadDB[id]` objects. Lives near `async function dbLoadLeads`. As of commit 016341f, beds/baths/condition/frequency are read from actual columns (`l.beds`, etc.), with fallback to regex-parsing them out of the notes field for backwards-compat with old leads. Map fields with snake_case → camelCase: `l.quote_data → quoteData`, `l.quote_total → quoteTotal`, `l.estimated_value → value`.
6. **`openLead(id)` panel renderer** — sets the lead detail panel fields. Generic fields use a `['contact','phone','email',...].forEach` loop that maps `d[f] → #lead-${f}.textContent`. Special-case fields (frequency, bedbath, condition, value) have their own setter blocks. **Adding a new visible field requires both an HTML `<div class="info-row">` and a setter in openLead.**

### Lead panel HTML row pattern

To add a new readonly row in the OPPORTUNITY section of the lead detail panel:

```html
<div class="info-row"><span class="info-label">My Field</span><span class="info-val" id="lead-myfield">—</span></div>
```

Insert between existing rows (search for "Property size" as a stable anchor). Then add to openLead:

```js
var myEl=document.getElementById('lead-myfield');
if(myEl) myEl.textContent = d.myField || '—';
```


## Auth

The CRM uses Supabase Auth with two sign-in methods, both granting the same session:
- **Magic link** via `db.auth.signInWithOtp({ email })` — used by VAs (e.g., Leo). Email delivered through the Resend SMTP setup on the Supabase project.
- **Google OAuth** via `db.auth.signInWithOAuth({ provider: 'google' })` — primary for admins.

UI gating after sign-in is done client-side in `applyUserRole(email)`:
- Email in `ADMIN_EMAILS` → no class added, full UI.
- Otherwise → `hnc-va-user` class added to `<body>`, which hides admin-only sections via CSS rules at the top of `index.html`.

> **Important:** This is UI hiding, not server-side authorization. A non-admin with a valid Supabase session can still call the API directly. Real enforcement is tracked under "VA login & security" in Pending.

### Auth code locations
| What | File / Line |
|---|---|
| Login overlay CSS | `index.html` ~line 408 |
| Login overlay HTML (Google button + email field) | `index.html` ~line 413 |
| Sidebar user footer (signed-in email + sign-out button) | `index.html` ~line 440 |
| `ADMIN_EMAILS`, `initAuth`, `applyUserRole`, `_setUserFooter`, `hncSendMagicLink`, `hncSignInWithGoogle`, `hncSignOut` | `index.html` ~lines 14575–14619 |

### Adding a new OAuth provider
1. Enable provider in Supabase Studio: **Authentication → Providers → [Provider]**.
2. Provide the Client ID and Client Secret from the provider's developer console.
3. In the provider's developer console, add Supabase's callback URL as an authorized redirect:
   `https://hehfecnjmgsthxjxlvpz.supabase.co/auth/v1/callback`
4. In Supabase: **Authentication → URL Configuration → Redirect URLs**, ensure `https://hnc-crm.vercel.app` (and any other deploy domains) are allowlisted.
5. Add a button in the login overlay HTML (~line 413) and a handler near `hncSignInWithGoogle` (~line 14572) modeled on the existing pattern.

### Symptoms when a provider isn't configured
Clicking the provider's button surfaces an error in `#hnc-login-msg` like *"Unsupported provider: Provider is not enabled"*. The user stays on the login overlay. If you see this, the fix is on the Supabase config side — not in the frontend code.

---


## Stripe Charge Security (defense-in-depth, added 2026-04-30)

After a fired VA used a residual session to fire 4 duplicate charges (~$782 to one customer), the entire charge path was hardened with five independent layers, any one of which would have stopped the incident on its own. **Don't remove any of these without understanding what they protect against.**

### Layer 0 — kill switch
Env var `ALLOW_STRIPE_CHARGES=true` (Production scope only, in Vercel) must be set for charges to fire. When unset/missing, `/api/stripe-invoice` returns 503 immediately, before any auth, dispatch, or Stripe call.

To engage the kill switch in an emergency, set the var to `false` (or delete it) and trigger a redeploy. **Vercel env-var changes don't apply to running deployments — push an empty commit to redeploy:**
```
git commit --allow-empty -m "Force redeploy" && git push origin main
```

### Layer 1 — Stripe idempotency keys on every `.create`
All 8 `.create` calls in `api/stripe-invoice.js` are wrapped with `_hncIdempCreate(resource, prefix, params)`. The wrapper builds a deterministic key like `hnc_pi_2026-04-30_a3f9b201` (prefix + UTC day + djb2 hash of params) and passes it to Stripe. Stripe then guarantees that any retry of the same logical request inside 24h returns the **same resource** instead of creating a new one.

Resource → prefix mapping (do not change):
- `customers.create` → `cu`
- `invoiceItems.create` → `ii`
- `invoices.create` → `inv`
- `paymentIntents.create` → `pi` ← the critical one
- `setupIntents.create` → `si`

`finalizeInvoice` and `sendInvoice` are intentionally NOT wrapped; they're already idempotent on the invoice id.

### Layer 2 — charge audit log + invoice backfill
After every successful `paymentIntents.create`, `_hncRecordCharge(req, paymentIntent)` runs and:
1. Fire-and-forget POSTs an immutable row to `error_logs` with `source='stripe-charge-success'` and full context (payment_intent_id, stripe_customer_id, amount, action, requesting_user_email)
2. Best-effort PATCHes any matching invoice rows that lack `stripe_payment_intent_id` (matched by client_id + total + created_at within last 10 min)

Both are wrapped in try/catch — Supabase failures never break the charge response. Forensic query:
```sql
SELECT occurred_at,
       context->>'payment_intent_id' AS pi,
       context->>'amount' AS amount,
       context->>'action' AS action,
       context->>'requesting_user_email' AS user
FROM error_logs
WHERE source = 'stripe-charge-success'
ORDER BY occurred_at DESC
LIMIT 100;
```

### Layer 3 — server-side duplicate guard
Before each `paymentIntents.create` in `charge_card` and `charge_specific_card`, `_hncRecentDuplicateGuard(stripeCustomerId, amount)` runs. It looks up the local client by `stripe_customer_id`, then queries `invoices` for `status='paid'` rows matching `client_id + total + created_at >= now()-5min`. If found, returns **409 `duplicate_charge_blocked`** without ever calling Stripe.

Fail-open on Supabase errors so a Supabase blip can't block legit charges (Layer 1 idempotency stays primary).

### Layer 4 — client-side fetch interceptor (`index.html`)
A self-installing IIFE at the very top of the first inline `<script>` block patches `window.fetch` for `/api/stripe-invoice` URLs only. It:
- **Auto-injects `Authorization: Bearer <access_token>`** by reading the Supabase session from localStorage — so all 18 charge call sites pass the requireAdmin gate without any onclick changes
- **Coalesces in-flight duplicates**: identical bodies fired before the first response returns the same Promise
- **Refuses near-duplicates**: identical bodies within a 10s post-completion window get a synthetic **429 `duplicate_request_blocked`**

Marker: `window.__hncStripeFetchPatched = true`. The patch is idempotent; reloads re-install it. Search for the comment `// ── HNC: client-side stripe-invoice de-duplication` to find the IIFE.

### Layer 5 — admin-only auth gate
`requireAdmin(req, res)` in `api/utils/auth-check.js` calls `requireAuth` then enforces an `ADMIN_EMAILS` allowlist. Anyone not on the allowlist (VA, employee, anonymous) gets **403 `admin_only`**.

Used by:
- `/api/stripe-invoice` (after the kill switch)
- `/api/admin/revoke-user`

`requireAuth` itself enforces a `BLOCKED_EMAILS` denylist for instant lockout of compromised accounts.

### Adding/removing admins or blocked users
Both lists live in `api/utils/auth-check.js`:
- `ADMIN_EMAILS` — Set of lowercase emails who can hit financial endpoints
- `BLOCKED_EMAILS` — Set of lowercase emails who get 403 on ANY auth-gated endpoint

Edit and push. Effective on next deploy (~60s).

### Locking out a compromised user end-to-end
1. Add their email to `BLOCKED_EMAILS` in `auth-check.js` and push (instant on deploy)
2. POST `/api/admin/revoke-user` with `{email}` to permanently ban their Supabase auth user (sets `banned_until` ~year 9999)
3. (Belt-and-suspenders) Manually ban in Supabase auth dashboard

### Action normalization (Unknown-action bug fix, 2026-04-30)
The dispatcher in `stripe-invoice.js` normalizes the input so whitespace/case/null don't fall through to the catch-all:
```js
let { action, ... } = (req.body || {});
action = (typeof action === 'string' ? action : '').trim().toLowerCase();
```
The catch-all also writes a forensic row to `error_logs`:
```sql
SELECT occurred_at, message,
       context->>'received_action' AS got,
       context->>'received_type' AS type,
       context->'body_keys' AS body_keys
FROM error_logs
WHERE source = 'stripe-invoice-unknown-action'
ORDER BY occurred_at DESC LIMIT 50;
```

### Helper reference (all in `api/stripe-invoice.js`)
| Helper | Purpose |
|---|---|
| `_hncIdempKey(prefix, payload)` | Deterministic idempotency key (prefix + UTC day + djb2 hash) |
| `_hncIdempCreate(resource, prefix, params)` | Wrapper around `resource.create()` that adds the idempotency key |
| `_hncRecordCharge(req, paymentIntent)` | Audit log + invoice backfill after successful charge |
| `_hncRecentDuplicateGuard(stripeCustomerId, amount)` | Pre-charge DB lookup for recent paid-invoice match |

## The Foundation (DO NOT SKIP THESE)

These four things were built specifically so new features don't corrupt data or fail silently.
Every new feature must use them.

### 1. Validation — `api/utils/validate.js`
**Always validate incoming data before touching the database.**

```js
import { validateOrFail, SCHEMAS } from './utils/validate.js';

const invalid = validateOrFail(req.body, SCHEMAS.leadCapture);
if (invalid) return res.status(400).json(invalid);
```

- Use an existing schema from `SCHEMAS` if one fits
- If your endpoint takes new data shapes, **add a new schema to `SCHEMAS`** rather than skipping validation
- Never trust data from `req.body` without validating it first — this includes data generated by AI

### 2. Error Logging — `api/utils/error-logger.js`
**All errors must be logged to Supabase, not just console.error.**

```js
import { logError } from './utils/error-logger.js';

try {
  // your code
} catch (err) {
  await logError('your-filename', err, { any: 'context', that: 'helps' });
  return res.status(500).json({ error: err.message });
}
```

- First argument is the source label — use the filename (e.g. `'lead-capture'`)
- Third argument is context — include any IDs or inputs that would help you debug
- `logError` never throws, so it's safe to call anywhere
- Check `error_logs` table in Supabase when something breaks

### 3. Timeouts — `api/utils/with-timeout.js`
**Every call to an external API must have a timeout.**

```js
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';

const response = await fetchWithTimeout(url, options, TIMEOUTS.RESEND);
```

Preset timeouts:
| Service | Constant | Duration |
|---|---|---|
| Supabase | `TIMEOUTS.SUPABASE` | 5s |
| Anthropic | `TIMEOUTS.ANTHROPIC` | 15s |
| Stripe | `TIMEOUTS.STRIPE` | 10s |
| OpenPhone | `TIMEOUTS.OPENPHONE` | 8s |
| Resend | `TIMEOUTS.RESEND` | 8s |

Never use raw `fetch()` for external services. Always use `fetchWithTimeout()`.

### 4. Atomic DB Operations — `api/utils/webhook-idempotency.js` + Supabase RPC
**Multi-step database operations must be atomic.**

If your feature writes to more than one table in sequence, use a Supabase stored procedure (RPC) so all steps succeed or all roll back. See `supabase/book_lead_atomic.sql` for an example.

If your feature handles webhooks, use the idempotency utility:
```js
import { isWebhookProcessed, recordWebhook } from './utils/webhook-idempotency.js';
```

---

## Adding a New API Endpoint

Copy this template every time:

```js
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1. Validate
  const invalid = validateOrFail(req.body, SCHEMAS.yourSchema);
  if (invalid) return res.status(400).json(invalid);

  try {
    // 2. Do your work (use fetchWithTimeout for any external calls)

    return res.status(200).json({ success: true });
  } catch (err) {
    await logError('your-endpoint', err, { ...req.body });
    return res.status(500).json({ error: err.message });
  }
}
```

---

## Adding a New Automation Action Type

1. Add the new type to the whitelist in `api/utils/validate.js` → `validateActions()` → `validTypes` array
2. Add handling for it in `api/run-automations.js` under the action execution loop
3. Test that invalid structures for the new type are properly rejected

---

## Adding a New AI Feature

AI features have extra rules because AI-generated data is often unprompted and can be malformed:

- **Always validate AI output** before writing it to the database — use `validate()` just like you would for user input
- **Always set a prompt length limit** — add it to `SCHEMAS.aiSummary` or create a new schema
- **Never let AI write directly to the DB** — AI output should go through the same API endpoints as everything else, so validation runs on it
- **Log AI errors separately** — use `logError('ai-feature-name', err, { prompt: prompt.slice(0, 200) })`
- **Add timeouts** — use `TIMEOUTS.ANTHROPIC` (15s) for all Anthropic calls

---

## Supabase Rules

- **Never use `SUPABASE_ANON_KEY` for server-side writes** — use `SUPABASE_SERVICE_ROLE_KEY` in API functions
- **Keep RLS disabled** until going to production — when you're ready, enable it and lock down policies per table
- **For multi-table operations**, write a stored procedure in `supabase/` and call it with `.rpc()`
- **New tables** should have an index on any column you filter or sort by

---

## Before Pushing Any Code

Run through this checklist:

- [ ] Does the new endpoint validate its inputs?
- [ ] Are all external API calls using `fetchWithTimeout()`?
- [ ] Are all errors caught and logged with `logError()`?
- [ ] If it writes to multiple tables, is it wrapped in a transaction?
- [ ] If it processes webhooks, is it checking for duplicates?
- [ ] Did you test the happy path (valid data works)?
- [ ] Did you test the failure path (bad data returns a clear error, not a crash)?

---

## Known Gotchas

- **Google Places autocomplete** was added and removed — it broke the address input. Don't reintroduce it without careful testing on the address fields first.
- **`places-autocomplete.js`** uses `module.exports` (CommonJS) while all other API files use `export default` (ES Modules). Don't mix these.
- **`run-automations.js`** is not yet using `logError` — errors only go to console. Add it when touching that file.
- **`lead-capture.js`** does not have an atomic transaction like `lead-book.js` does — if it fails midway you can end up with a lead but no email/SMS sent.
- **Context drift** between chat sessions is a recurring problem. Always reference this document at the start of a session and update it when something significant changes.
- **RLS on `appointments`** caused a "phantom delete" bug (April 2026): appointments appeared to save (UI-first insert into in-memory `apptData`) but vanished on refresh because the anon-key SELECT returned 0 rows. Inserts were also silently rejected because errors went only to `console.error`, not to a toast. Fix: disable RLS in Supabase dashboard. Lesson: any new DB write path must surface errors to the user via `showToast(msg, true)` AND roll back the optimistic in-memory update — never trust the UI-first pattern without an error fallback.
- **Large duplicate block in `index.html`** (discovered and fixed April 28, 2026): a copy/paste accident left ~1958 lines duplicated (Copy A: L13234-L14779 scripts + L12739-L13150 HTML overlays; Copy B: L14782-L16xxx). At runtime, Copy B's later function declarations overrode Copy A's, so most of A was dead code — except for two unique blocks that each copy had: A had the activity log feature (`logActivity`, `showLogsTab`, `loadLogs`) and B had the AI broadcast generator (`openAiBroadcastForm`). Fix: relocated A's activity-log block (92 lines) into B at the matching position, then deleted all of A's scripts and the duplicate HTML overlays. File went from 16981 → 15115 lines (-1866). Verified by JS syntax check on every script block, HTML tag balance check, duplicate-ID delta check (86 → 3, all 3 were pre-existing), and full functional browser test (calendar, booking form, broadcasts modal with AI broadcast option, logs page). Lesson: any future copy/paste of large script regions should be diffed before merging — and `grep -nE '^(function|var|const) ' index.html | awk -F: '{print $2}' | sort | uniq -d` is a quick canary for this class of bug.

---
- **The 5-layer lead form whitelist trap** (see "Lead Form Data Flow" section above). When a new lead field "isn't saving" or "shows TBD", check all 5 layers: `_buildNLQuote` data shape, `saveNewLead` in-memory cache, `dbSaveLead` insert whitelist, `dbLoadLeads` mapping, `openLead` setter.
- **Quote subsection (loadSuggestedQuote) requires specific field names** in `quote_data`: `subtotal`, `discount`, `discount_pct`, `total`, `service`. If you write `subtotal_after_discount` or `discount_amount` instead, the renderer crashes on `result.subtotal.toFixed` and the subsection appears empty/black.
- **Supabase REST API needs the project key as `apikey` header**, NOT the user's JWT. The user's session.access_token goes in `Authorization: Bearer ...`. Server-side fetches should use `apikey: SUPABASE_SERVICE_ROLE_KEY` and `Authorization: Bearer SUPABASE_SERVICE_ROLE_KEY` (or pass through the user's auth header for RLS-aware queries).
- **HTML script-tag balance after big edits.** If raw JS code starts appearing as text on the page, the script open/close count is unbalanced. Use `(html.match(/<script[^>]*>/g)||[]).length` and `(html.match(/<\/script>/g)||[]).length` to verify equal count. Premature `</body></html>` tags in the middle of the file are a common cause — search for multiple occurrences with `[...html.matchAll(/<\/html>/g)]`.
- **`generateLeadSummary` failure mode.** If "Error generating summary" appears with no fetch call to `/api/ai-summary`, an exception is being thrown OUTSIDE the try block (during prompt building). The function should build the prompt synchronously from `leadDB[currentLeadId]` fields with no async calls before the fetch.
- **AI summary API accepts EITHER `{ prompt }` or `{ leadData }`** but not just `{ leadId }` — it has no Supabase fetch in its current form. Frontend builds the prompt and sends it.
- **In-memory leadDB after `saveNewLead`.** Even after Supabase save succeeds, the card renders from `leadDB[id]` BEFORE the next `dbLoadLeads()`. So the in-memory object built in `saveNewLead` must include quoteTotal, quoteData, frequency, condition, beds, baths — otherwise the card shows TBD until a hard refresh.
- **Lead form condition is a 5-tier picker, NOT a 1-10 slider** (changed April 2026). `lead-form.html` shows 5 photo cards (Extreme / Very dirty / Moderately dirty / Decent / Pristine), each with a photo, tier name, and short description (e.g. "Cleaned weekly. Almost no visible dust, dirt, or wear."). The descriptions are decision-support for self-classification — keep them concise (1-2 sentences) and frequency-based where possible. The cards map to numeric values 2 / 4 / 6 / 8 / 10 respectively. The numeric value is what gets sent to `/api/lead-capture` as `condition` and what `pricing_condition.score_min/score_max` looks up — backend pricing logic is unchanged. The mapping lives in the `data-value` attribute on each `.tier-card` in the form. After tier selection, a warning modal appears reminding the customer that misrepresented condition triggers an on-arrival upcharge — this is intentional, do not auto-dismiss it. Cards have a hover-zoom effect (scale 1.12 + lift) gated by `@media (hover:hover)` so it's desktop-only and doesn't break on touch devices. Tier photos for Extreme / Very dirty / Moderately dirty / Decent live in `/tier-photos/*.jpg` in the repo (real HNC job photos, resized to 800px wide, ~70-100KB each); Pristine still uses a Pexels CDN URL until a real after-shot replaces it. To swap a photo: replace the file in `tier-photos/` (keep the same filename) and commit — Vercel auto-serves it.
- **Cleaner-arrival tier mismatch escalation is currently MANUAL.** When a cleaner arrives and the actual condition exceeds what the customer described, the cleaner texts the office via OpenPhone with photos and the office handles the re-quote / cancellation conversation manually. There is no automated layer-3 workflow yet (no in-CRM submission, no auto-SMS to the customer). Don't build automation around it without confirming with Dane first.
- **Quote-locking via customer photo upload is NOT yet implemented** — only the tier picker + warning modal shipped. The "upload photos to lock your quote" feature was discussed but deferred. When building it, the photos will need a Supabase Storage bucket (`lead-photos` is the proposed name, not yet created) and a corresponding column on the `leads` table (also not yet added).
- **Waiver page (`agree.html`) AND booking page step 2 (`book.html`) both load policies + checklists from `settings` table** (added April 2026). Two endpoints power both: `/api/get-policies` returns `settings.policy_items`, and `/api/get-checklists` returns `settings.service_checklists`. Both have hardcoded fallback defaults in their `.js` files so the pages never break if the DB rows aren't seeded. To edit waiver content live without code changes, edit the JSONB in those two `settings` rows directly in Supabase — changes flow to BOTH pages.

  Service checklists are organized as `{services:[{id,label,intro?,required?,sections:[{heading,items:[]}],notIncluded?,footnote?}],beforeArrival:[]}`. The `required` array (only on move-out today) is NOT rendered inside the service card when the booked/filtered service is move-out — instead its items are joined into a single bulleted policy checkbox titled "Move-out preparation requirements" so the customer must acknowledge them as one item. The `notIncluded` array renders as a dashed-border gray block at the bottom of the service card. The `id` field on each service maps to an emoji in `SERVICE_EMOJI` — adding a new service requires updating that map in BOTH `agree.html` and `book.html`.

  The `p5` policy ("Quote accuracy & on-arrival adjustment") is the contractual basis for raising prices on under-described moveouts; do not remove or weaken its language without thinking through legal implications.

  **Service-specific behavior:** `agree.html` accepts `?svc=moveout` URL param. `book.html` infers the service from `LEAD.service` (the booking lead's service field) via `serviceLabelToId()` — "Move-out Cleaning" → 'moveout', "Deep Cleaning" → 'deep', etc. Both pages auto-pair Deep with Regular (shows both cards) since Deep's content references Regular. Both hide the universal "Before we arrive" prep card when only move-out is shown (move-out has its own requirements). All service cards render collapsed by default.

  To deploy on a new environment, run `supabase/add_service_checklists.sql` once in the SQL editor to upsert both rows.

- **Lead pipeline lifecycle** (added April 2026 during automations rollout audit). Stages: `New inquiry` → `Quoted` → `Follow-up` → `Closed won` / `Closed lost`. Transitions:

  - **→ New inquiry**: set on insert by `api/lead-capture.js` when the public `lead-form.html` is submitted. Also sets `segment: 'initial_sequence'` + `segment_moved_at` so the `days_since_response` automation (in `run-automations.js`) can find them later.
  - **→ Quoted**: set inside `api/lead-capture.js` on the same DB call that writes `quote_sent_at`, in BOTH branches (regular auto-quote and janitorial walkthrough). Gated by `auto_quote_enabled` for regular and `janitorial_enabled` for janitorial — if neither flag is on, the lead never gets a quote and stays in `New inquiry`.
  - **→ Follow-up**: set by daily cron `api/run-task-automations.js` (18:00 UTC) when `stage = 'Quoted'` AND `quote_sent_at` is 3+ days old AND `last_responded_at IS NULL` AND `do_not_contact = false`. Pure DB write, no kill switch, does NOT respect `TASK_AUTOMATIONS_TEST_MODE`. Also set manually by `reactivateLead()` in `index.html` when a user clicks "Reactivate" on a Closed-lost lead.
  - **→ Closed won**: set by `api/lead-book.js` (via the `book_lead_atomic` RPC) when the lead books through `book.html`.
  - **→ Closed lost**: only set manually via the lead detail panel's stage dropdown.

  Tracking fields used by the pipeline: `quote_sent_at` (set in lead-capture, used by both task automations and stage advance); `last_responded_at` (set by `openphone-webhook.js` on inbound SMS replies, used by stage advance and `days_since_response` trigger); `response_count` (incremented by openphone-webhook); `segment` + `segment_moved_at` (used by run-automations triggers).

  Owner notifications on new lead: `api/lead-capture.js` fires both an email (gated by `new_lead_owner_email_enabled`) to `dane@hawaiinaturalclean.net` and an SMS (gated by `new_lead_owner_sms_enabled`) to `+18084685356` (the HNC business line). Both addresses are HARDCODED in `api/lead-capture.js` — change them there if Dane's contact info changes. Note: the `DANE_PHONE_DIGITS = '8082697636'` constants in `run-task-automations.js` / `run-job-completions.js` / `index.html` are intentionally left on Dane's personal number — they're TEST_MODE guards that limit automation runs to Dane during rollout, NOT production notification targets.

## Utilities Reference

| File | What it does |
|---|---|
| `api/utils/validate.js` | Schema-based request validation |
| `api/utils/error-logger.js` | Log errors to Supabase `error_logs` table |
| `api/utils/with-timeout.js` | Wrap fetch() calls with timeouts |
| `api/utils/webhook-idempotency.js` | Prevent duplicate webhook processing |

---

## Supabase Tables Added During Foundation Work

| Table | Purpose |
|---|---|
| `webhook_events` | Tracks processed webhooks to prevent duplicates |
| `error_logs` | Central log of all API errors |
| `cleaner_invites` | One-time tokens for cleaner-portal invite flow (admin-issued, redeemed after Google sign-in) |

## Supabase Functions Added During Foundation Work

| Function | Purpose |
|---|---|
| `book_lead_atomic` | Atomically creates client + appointment + closes lead |
| `redeem_cleaner_invite` | Atomically validates an invite token, marks it used, and writes the verified email to `cleaners.auth_email` |

---

## Recent Commits Log

Single source of truth for what landed in the most recent sessions. Most recent first.

| Commit | What |
|---|---|
| `cb03c79` (this session) | **Critical fix: status propagation across recurring series on edit-all.** User reported Jan Kunst showing 'completed' for multiple future appointments. Diagnosed via browser-based Supabase query: 55 future-dated appointments across two of her recurring series were silently marked `status='completed'`, extending all the way to April 2027. Root cause: when editing a recurring appointment with mode='all', `saveApptEdit` built `sbBasePayload` including `status:statusVal` and ran a single bulk Supabase UPDATE across every series row. So if the user edited an already-completed past appointment (autoComplete-marked) and chose 'edit all', the `completed` status leaked onto every other instance in the series — past, present, and future. Same bug in the in-memory series fan-out (`seriesFields.s = statusVal`). **Fix**: build `sbBulkPayload` as a copy of `sbBasePayload` with `status` key deleted before bulk UPDATE; then run a separate single-row `update({status:statusVal}).eq('id', a.dbId)` for the current appointment so the user's status edit is preserved without leaking. Same surgical fix in-memory: removed `s:statusVal` from `seriesFields`. Comments added at both sites explaining why status is per-instance. **Data cleanup** (no code, just a one-off SQL via authed browser): reset 55 Jan Kunst future rows from completed → unassigned. Verified no other clients affected — only Jan Kunst's two series. **Pattern**: any "apply to all in series" bulk update needs to think carefully about which fields are per-series (cleaner, time, service, pricing, address) vs per-instance (status, completion date, payment state). Other per-instance fields like `paid_at`, `invoice_sent` should also probably be excluded — worth auditing if more bulk-updates get added. |
| `9a18659` (this session) | **Duplicate-to-another-date button on appointment overlay.** User asked: when I press an appointment, give me a Duplicate button — asks what day to schedule another for, then books it. New full-width blue 'Duplicate to another date' button in the appt-overlay action grid (between Charge and Message). Tapping it opens a compact `appt-dup-overlay` showing a 5-row info-block (client, time, cleaner, service, total) so the user can sanity-check what's about to be cloned, plus a single date input pre-filled with tomorrow. On confirm, `confirmApptDuplicate()` builds a `dbSaveAppointment` payload copying every field from `currentAppt` except date, with `freq='One-time'` and `recurring=false` forced (so duplicating a recurring instance doesn't accidentally spawn a brand-new recurring series). Awaits the DB write, checks `res.error` explicitly, calls `_refreshAppointmentsFromDB({settleMs:200})` to reload, closes both overlays, fires a toast 'Duplicated to Tue Jul 8 ✓'. Confirm button disables during save to prevent double-click; failed save re-enables with error toast. Pricing copied as-is (preserves any override the user set). |
| `1186068` (this session) | **Tighten AI brief prompt — fixed structure, no truncation.** User report: 'AI briefing when I make a VA task is way too long. It's getting cut off.' Two compounding issues: (1) Prompt was open-ended ('include who they are, what they need, history, open issues, preferences, talking points') so the model produced 600-700 token responses by default. (2) `max_tokens: 400` chopped the verbose output mid-sentence. Plus history pull was 100 SMS / 10 calls inflating the prompt. **New prompt** uses fixed structure: `📋 Quick read` (3 bullets max), `🚩 Watch for` (1 bullet), `💡 Try this` (1 bullet — concrete next step). Hard caps: 5 bullets total, each under 15 words. Explicit 'No preamble, no closing remarks, no code fences. Output starts with 📋 Quick read.' Plus 'Do not restate fields the rep already sees on the screen' kills the most common bloat (re-listing name/address/quote). `max_tokens` raised to 500 (small safety margin so output can't truncate even if model goes 1-2 bullets over). History dropped to 30 SMS / 5 calls. Output now ~120-150 words, reads in 5 seconds, fits comfortably in the existing pre-wrap details element. **Note**: only affects manual task creation (POST /api/tasks). The Day-1/Day-5 auto-task `va_brief` mode in `summary-prompt.js` is a separate path — can revisit if user reports same issue there. |
| `5d120b1` (this session) | **Calendar month-view: sort appointments chronologically in day cells.** User report: '9am Bobby Nikkhoo is showing up before 5am Jan Kunst on the schedule.' Confirmed via DOM inspection — a single day cell rendered 6pm Bobby, 5am Jan, 9am Susanna, 9am Maurice. Completely random. Root cause: `renderMonth`'s per-cell loop iterated `apptData[k]` in native insertion order. apptData is built from initial DB load + recurring expansion + manual additions, so order inside each day's array is effectively random. Week and Day views weren't affected because they position appointments by absolute `top:<startMin>px` coordinates, not DOM order — only Month view stacks by document order. Fix: `da.slice().sort((x,y) => parseApptHour(x.t)*60 + parseApptMinute(x.t) - parseApptHour(y.t)*60 - parseApptMinute(y.t))` before the forEach. `.slice()` so we don't mutate apptData. Helpers `parseApptHour` and `parseApptMinute` already existed (used by Day/Week renders). |
| `69b2970` (this session) | **Faster page navigation: prefetch secondary view data + tighter view transition.** User report: clicking sidebar tabs shows blank screen for 1-2s before content appears. Two contributors. (1) On-click data fetching: loadTasks, loadLeadAutomations, loadBroadcasts, loadSettings only fetch when their view is activated. Some render-then-fetch (loadTasks); others go straight to await before any render (loadLeadAutomations, loadBroadcasts) so first visit shows blank during the fetch. (2) `.vc.active` CSS animation was 220ms — adds delay even when content is ready. Fixes: (A) New `setTimeout(prefetchSecondary, 1200)` after initial render runs all four load functions in parallel. Each view's static DOM is in the page (just hidden behind .vc:not(.active)) so the load functions populate the hidden DOM in the background. By the time user clicks any of these tabs, content is already rendered. The on-click handler still fires as a freshness refresh, but that happens in background while prefetched content is already visible. 1.2s delay so prefetch doesn't compete with primary loadAllData fetches for bandwidth during critical first-paint window. Each prefetch is best-effort with try/catch. (B) Animation shortened from 220ms → 100ms, same cubic-bezier curve. Heavier views (reporting, payroll) intentionally NOT prefetched — multi-step queries, not worth bandwidth on every page load. |
| `5543d99` (this session) | **Push notifications for ALL admin SMS sites: new lead, new task, auto-booking.** User asked: can all admin SMS notifications also fire as PWA push? Audit found four admin-SMS sites total. Three needed wiring (the deadline cron was already done in commit 19df841). For each, push fan-out lives inside the SAME `if (await isAutomationEnabled(...))` gate as the SMS — toggling the flag off silences both channels (single mental model). Dynamic `import('./utils/send-push.js')` so missing web-push module / VAPID config doesn't break the SMS path. Fire-and-forget `.then().catch()` — no await — so endpoint response isn't blocked. Each push has a unique tag (`new-lead-<id>`, `new-task-<id>`, `auto-book-<leadId>`) so duplicates replace rather than stack. Each push deep-links to lead profile or `/#tasks`. Notification format: `🆕 New lead: <Name>` / `<service> · <phone> · <island> · 3bd/2ba · 1500sf`; `📝 New task: <title>` / `Tap to view (due <date>)`; `✅ Auto-booked: <Name>` / `<service> · <date> at <time> · $<total>`. Side note: lead-book's admin SMS goes to +18083484888 (different number from OWNER_PHONE +18084685356) — push fan-out goes to ALL subscribed devices regardless of which number the SMS targets, since it's user-account-based. Customer SMS (booking confirmations, reminders, review requests) and cleaner SMS intentionally NOT wired to push — those are different audiences. |
| `19df841` (this session) | **Daily 8am task-deadline push + iOS PWA sidebar scroll fix.** Two small fixes shipped together. **(A)** `/api/run-task-deadline-reminders` now fires push to all subscribed devices alongside the existing SMS digest. Title compresses the digest into the notification surface: `'3 due today · 1 overdue — 4 tasks'` or `'1 task needs your attention'` for single-task case. Body lists up to 4 task titles. `tag: 'task-digest-<YYYY-MM-DD>'` dedupes within the day so a re-run replaces rather than stacks. `requireInteraction: true` if any overdue OR any high-priority. Wrapped in try/catch so missing VAPID config doesn't break SMS path. Result included in JSON response for log inspection. Cron schedule unchanged: 18:00 UTC = 8am Hawaii. **(B)** Fixed sidebar scroll on installed iOS PWA. User reported: hamburger menu opens but can't scroll, items hidden. Root: my Phase-1 PWA fix added safe-area body padding so topbar clears the iPhone notch. But `.sidebar` uses `position:fixed` which ignores body padding. So in standalone mode on iPhone the sidebar still extended from the viewport top (under Dynamic Island) to the bottom (under home indicator). Top items hidden under notch, bottom items hidden under home indicator, so scrolling felt 'broken' — content was there but invisible. Fix in `@media (display-mode:standalone) and (max-width:900px)`: added `padding-top: env(safe-area-inset-top)` and `padding-bottom: env(safe-area-inset-bottom)` directly to `.sidebar`, plus `-webkit-overflow-scrolling:touch` for momentum and `overscroll-behavior:contain` so swiping doesn't scroll the page behind. No effect outside installed PWA. |
| `55e4bdf` (this session) | **Replaced PWA icons with user-uploaded square HNC logo.** User uploaded `HNC_Logo_Design_1_.png` (500x500 square version of the Hawaii Natural Clean logo). Previous attempts used the wide horizontal wordmark scaled into a square canvas, which left huge empty top/bottom margins and made the logo hard to read at small sizes. Regenerated all icons from the new square source: `icon-{192,256,384,512}.png` at 98% fill ratio with transparent background; `icon-maskable-{192,512}.png` at 85% fill with white background (so Android's circle/squircle mask doesn't cut into the logo); `apple-touch-icon.png` at 95% fill, white bg, alpha-composited to RGB so iOS doesn't have transparency weirdness. Also generated `favicon-{16,32}.png` and switched index.html's `<link rel="icon">` from `/hnc-logo.png` (wide, illegible at 16px) to the new 32px and 16px PNGs. The wide `hnc-logo.png` is unchanged — still used in sidebar header, login screen, client portal, agree page wherever a horizontal banner placement looks natural. User must remove + reinstall PWA on phone to pick up the new icon (iOS caches at install time). |
| `b8089b3` (this session) | **PWA polish: opaque status bar + larger logo on app icon.** User reported two issues after first PWA install: (1) menu hamburger button hidden behind iPhone status bar / Dynamic Island. (2) home screen icon wasn't showing the logo — was either blank, default Safari snapshot, or so small it looked like nothing. **Fix A**: changed `apple-mobile-web-app-status-bar-style` from `black-translucent` to `default`. black-translucent makes the status bar transparent and pushes content underneath; `default` gives a normal opaque white status bar that sits ABOVE content. Menu button + topbar now have proper space. **Fix B**: regenerated apple-touch-icon with logo at 90% canvas fill (was 78%). The wide horizontal wordmark logo had tons of empty space above/below at small sizes. Standard icons (192-512) regenerated at 92% fill (was 85%). Maskable variants stay at 70% inside Android safe zone for adaptive icon masks. **Fix C**: added `sizes="180x180"` attribute on the apple-touch-icon link, plus `apple-touch-icon-precomposed` fallback for older iOS. Also created copies at root `/apple-touch-icon.png` + `/apple-touch-icon-precomposed.png` for iOS default-discovery (iOS probes these paths if no link tag is found). **Fix D**: added `@media (display-mode:standalone)` body padding using `env(safe-area-inset-*)` as a fallback safety net so if status-bar-style ever gets set back to translucent, content still respects the notch. |
| `c6cf4f1` + `c604825` + `b812a8b` (this session) | **PWA + Web Push notifications.** User asked to turn the CRM into an installable web app with push notifications for cleaners/admins/VAs (no personal-phone routing). Built in three phases. **Phase 1** (`c6cf4f1`): manifest.json, service-worker.js (skipWaiting + clients.claim, push handler stub, notificationclick navigation), PWA icon set generated from `hnc-logo.png` (192/256/384/512 standard + maskable variants with brand-blue bg, plus apple-touch-icon), apple-mobile-web-app-* meta tags, install banner that detects iOS vs Android and shows platform-specific instructions, dismissible with localStorage suppression, `window.hncShowInstallHint` helper to re-show. **Phase 2** (`c604825`): VAPID keys generated (public + private), `migrations/2026-05-03-add-user-push-subscriptions.sql` (user_id, endpoint, p256dh_key, auth_key, user_agent, last_used_at, UNIQUE(endpoint), RLS so users see only own subs but service role bypasses), `/api/register-push-subscription` (Bearer auth, register/unregister actions, upsert by endpoint), `/api/vapid-public-key` (cached public key endpoint for frontend), `/api/utils/send-push.js` shared helper with `sendPushToUsers`, `sendPushToRoles`, `sendPushToAllSubscribed` (auto-prunes 410/404 dead subscriptions), frontend subscription flow with soft prompt banner before the OS permission dialog (7-day dismissal cooldown), iOS-not-standalone detection that silently skips the prompt (Web Push only works in installed PWAs on iOS), `_hncDescribeDevice` for human-readable user_agent labels, `window.hncEnableNotifications`/`hncDisableNotifications` exposed for future settings UI. **Phase 3** (`b812a8b`): openphone-webhook fires push to all subscribed devices on successful lost-intent task creation (dynamic import so missing VAPID config doesn't crash webhook), notification deep-links to `/#tasks`, dedupe tag `review-<lead_id>`, requireInteraction=true for high-confidence verdicts. Cleaner invite SMS updated with install instructions for iOS Safari and Android Chrome. **Comprehensive setup doc**: `PWA_SETUP.md` at repo root covers migration, env vars (with actual VAPID values embedded), per-platform install walkthroughs, troubleshooting (iOS PWA push gotchas, SW update issues), cost, security. **Required setup**: run migration, add `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` + `VAPID_SUBJECT` to Vercel env, redeploy. **Pattern**: any future event that should notify users → import `sendPushToAllSubscribed` from `./utils/send-push.js`, call with `{title, body, url, tag}`. Cost: free (uses native APNs/FCM via Web Push protocol). |
| `8795e3c` (this session) | **Webhook: include name + response_count in lead lookup.** Two latent bugs in `findLeadByPhone` revealed during the lost-intent debug session. (1) `select=id,phone` only — meant `lead.name` was undefined, so task titles read "Lead responded — mark as lost?" instead of "Dane responded — mark as lost?". (2) `response_count` was also missing, so `(lead.response_count \|\| 0) + 1` always evaluated to 1; the counter never incremented past first reply. Both fixed by adding `name` + `response_count` to the select. Bumped limit from 100 to 200 since leads table is ~70+ and growing. |
| `0afa481` (this session) | **Webhook: switch from anon key to service role key (bypass RLS).** Final piece of the lost-intent puzzle. After fixing the schema constraint, tasks STILL weren't being created. Diagnosed live in browser via direct anon-key REST insert: HTTP 401 with code 42501 — `"new row violates row-level security policy for table tasks"`. Webhook was using `process.env.SUPABASE_ANON_KEY`, which is correct for client-side reads but blocked by RLS on writes to most tables. Changed `SUPABASE_KEY` to `process.env.SUPABASE_SERVICE_ROLE_KEY \|\| SUPABASE_ANON_KEY`. Service role bypasses RLS — correct security model for trusted server-side webhooks. Anon-key fallback so a missing env var doesn't take the webhook offline (most read paths still work with anon). **Pattern**: every server-side webhook/cron should use service role; anon is only for client-side fetch. Already used by run-task-automations, run-job-completions, ai-personalize, run-invoice-reminders, unsubscribe — webhook was an outlier. |
| `084c84a` (this session) | **Diagnostic endpoint: `/api/debug-classify-message`.** During the lost-intent debug session, needed to see what verdict the AI was returning for given inbound SMS. Created a debug endpoint that takes `{body, leadName}` and returns the AI's verdict object directly using the same prompt + parser as the webhook's `classifyLeadResponse`. Confirmed AI was classifying correctly all along (`intent: "lost", confidence: "high"` for "we ended up choosing another company") — the failure was downstream in the task insert. Endpoint left deployed for future debugging — safe since it requires the same env var as other AI endpoints and exposes nothing sensitive. |
| `d9177cf` (this session) | **Fix: tasks_type_check constraint blocked review_lead_response + call_lead_reengagement inserts.** User reported lost-intent detection wasn't working — submitted lead form, replied "Not interested", no task appeared. **Diagnosed live via browser-based Supabase query** (after disabling Avira browser extension which was blocking JS injection): synthetic webhook fired correctly, message logged, response_count incremented, but task insert returned PostgreSQL error code 23514: `"new row for relation \"tasks\" violates check constraint \"tasks_type_check\""`. The `tasks_type_check` CHECK constraint only allowed `('invoice', 'call_lead', 'call_client', 'project', 'other')` — both `review_lead_response` (this session's new type) AND `call_lead_reengagement` (used by `run-task-automations.js` for Day-5 follow-up tasks) were getting rejected. Worse: webhook's `supabaseInsert` is fetch-based and doesn't throw on 4xx — failed inserts disappeared silently. **Day-5 re-engagement tasks have likely been failing for who knows how long.** Two fixes: (1) Migration `migrations/2026-05-03-extend-tasks-type-check.sql` drops and re-adds the constraint with both new types. Must be run manually in Supabase SQL Editor — no recovery for previously-failed inserts since they never reached DB. (2) Webhook now reads `taskInsertRes.ok` and logs explicit error with status + body preview on non-2xx. **Pattern**: any fetch-based DB insert that doesn't check `response.ok` is a silent-failure surface. The other `supabaseInsert` calls in `openphone-webhook.js` (messages, call_transcripts) are also unchecked — should audit + harden in a follow-up. **Also note**: `error_logs.created_at` column doesn't exist (it's probably `at` or `logged_at`), discovered while looking for AI errors. Worth checking the actual column name and updating any code that filters on `created_at`. |
| `df9327b` (this session) | **Filter tabs: Won shows only won, Lost shows only lost (no longer both).** User reported clicking Won and Lost filter tabs both showed both Closed won + Closed lost sections side by side, making the two filters functionally identical. Root cause: `closed-leads-section` wraps both Won and Lost tables; the old `filterLeads('won')` and `filterLeads('lost')` just toggled the parent container visibility. Fix: wrapped each section in its own div (`#won-section`, `#lost-section`); `filterLeads` now toggles all three visibility states independently per tab. Removed scrollIntoView calls — no longer needed since unwanted section is hidden entirely. |
| `5809ebe` (this session) | **Fix: closed-lost and closed-won leads disappear after page reload.** **Latent bug since closed-leads section was first built.** User reported marking Sarah Elrachidi as Closed lost via lead profile button at ~4pm. She appeared in Lost section. Hours later she had vanished from Lost view. Search bar still found her with `stage='Closed lost'` — DB was correct, UI wasn't rendering her. Root cause: `lost-leads-tbody` and `won-leads-tbody` were ONLY populated by active session interactions (markLeadLost / convertLeadToClient appending rows). NO function read leadDB at startup or refresh to populate either tbody. Anything closed in a previous session, via SQL/migration, or via the new reviewTaskMarkLost handler — invisible. Fix: (1) leadDB now stores `updatedAt: l.updated_at` raw ISO string for accurate Date won/lost columns. (2) New `renderClosedLeadsTables()` reads leadDB, filters by stage, builds tbody HTML for both Closed lost + Closed won, sorted by `updatedAt` DESC. Parses `Lost: <reason>` from notes for reason column. Uses `esc()` for XSS safety. (3) `renderLeadsPipeline()` calls it at end so closed views always sync with leadDB on every leads-data refresh. **Pattern**: any tbody/list that's only mutated during sessions but not seeded on page load is a latent invisibility bug. Audit other places (won leads, completed tasks, archived clients) for the same antipattern. |
| `4d2a4d5` (this session) | **Lost-intent detection: AI classifies inbound SMS, creates VA task with Yes/No buttons.** User asked if AI could detect when a lead replies "we ended up choosing another service" and mark them lost. Built as a notify-and-confirm flow (not auto-flip) using the existing tasks UI as the surface. Webhook (`api/openphone-webhook.js`) already had idempotency + lead lookup by phone + response tracking from a previous build — added an AI classification layer on top. New `classifyLeadResponse()` helper calls Claude Haiku 4.5 (200 tokens, ~$0.001/call) with a conservative prompt that returns `{intent: lost\|engaged\|deferred\|unclear, confidence: high\|medium\|low, reasoning}`. Biased toward false-negatives ("unclear" when uncertain) since false positives risk hiding real customers. If verdict is `lost` AND confidence isn't `low`, creates a task: `title: "Stephanie responded — mark as lost?"`, `type: 'review_lead_response'`, priority by confidence, description includes the SMS reply + AI's read, `related_lead_id` set. AI errors never fail the webhook. JSON parsing uses brace-tracking extractor (same pattern as lead-followup-generate). Frontend: `renderTaskCard` got the new type added to typeLabel/typeColor maps ('Lead reply', red), and renders inline `Mark as lost` + `Not lost` buttons below the description for open tasks of this type. Two new helpers: `reviewTaskMarkLost(taskId, leadId)` (confirm → DB update with await+error-check → in-memory mirror → renderLeadsPipeline → completeTaskById → toast) and `reviewTaskNotLost(taskId)` (just completeTaskById). **Setup required** before this works: (1) register webhook URL `https://hnc-crm.vercel.app/api/openphone-webhook` in OpenPhone admin for `message.received` events, (2) confirm `ANTHROPIC_API_KEY` env var is set in Vercel (almost certainly already there for AI follow-up + summary). |
| `4d2a4d5` + `3e43518` (this session) | **AI lost-intent detection — VA task with Yes/No buttons.** User asked: "When a lead responds 'we ended up choosing another service' can AI detect it and mark as lost?" Specifically wanted a VA task to surface the question rather than auto-flipping the stage — false positives are worse than false negatives, the boundary between lost and deferred is fuzzy. **Approach**: notify-and-confirm. **Backend** (`api/openphone-webhook.js`): existing `message.received` handler already tracked lead responses; now also calls new `classifyLeadResponse(messageBody, leadName)` helper when `ANTHROPIC_API_KEY` is set. Helper uses Claude Haiku 4.5, 200 max_tokens (~$0.001/call). Returns `{intent, confidence, reasoning}` where intent ∈ {lost, engaged, deferred, unclear}. Conservative prompt: "When in doubt between lost vs deferred, classify as deferred." Only acts on `intent='lost' && confidence !== 'low'`. JSON parsed via brace-tracking extractor (same pattern as `lead-followup-generate`). AI errors never fail the webhook. On lost: creates `tasks` row with `type='review_lead_response'`, `priority` high/medium based on confidence, `description` includes both the SMS reply and AI's reasoning. **Frontend** (`index.html`): `renderTaskCard` typeLabel/typeColor maps get new `review_lead_response → 'Lead reply' / #dc2626`. New `reviewActions` block on open tasks of this type renders inline "Mark as lost" (red, primary) + "Not lost" (white, outlined) buttons. Description div now `white-space:pre-wrap` so multi-line AI reasoning renders properly. **Handlers**: `reviewTaskMarkLost(taskId, leadId)` updates lead.stage='Closed lost' in DB with `res.error` check (mirrors `markLeadLost` pattern), updates local `leadDB`, repaints pipeline, completes task. `reviewTaskNotLost(taskId)` just completes the task — lead stays in current stage. **Setup doc**: `OPENPHONE_WEBHOOK_SETUP.md` added at repo root — explains webhook URL registration in OpenPhone admin, env var requirements (ANTHROPIC_API_KEY), verification steps, and tuning instructions if classifier is too aggressive/conservative. **Dane action required**: register `https://hnc-crm.vercel.app/api/openphone-webhook` in OpenPhone admin, subscribe to `message.received` (and the call.* events while there for transcripts). **Cost**: ~$0.001/inbound SMS — negligible even at 100/day. |
| `a059ec6` (this session) | **Fix: temporal dead zone error in AI follow-up generate.** User saw `Cannot access 'hasStructuredQuote' before initialization` for every lead they tried to follow up. Caused by my own commit `2cae6ad` — I inserted the new `pricesInHistory` + `hasPriceEvidence` block right after the OpenPhone history fetch, but `hasPriceEvidence` references `hasStructuredQuote` which was declared 20+ lines later. JS `const` has temporal dead zone semantics, throws at runtime. `node --check` only validates syntax, not ordering. Fix: consolidated all derived flags into one block in correct dependency order (firstName/stage/quote/etc → `hasStructuredQuote` → `pricesInHistory` scan → `hasPriceEvidence` combined → `city` extract). Same logic, just reordered. **Pattern**: when shuffling derived-value blocks, manually trace the dependency graph — node check won't save you. |
| `2cae6ad` (this session) | **AI follow-up: city-only addresses + restored SMS price detection.** Two issues. (A) AI mentioned full street addresses ("100 malia uli pl") which was creepy. Fixed: new `_extractCity()` helper parses the city from Hawaii-format addresses ("Street, City, HI Zip") and CONTEXT now passes only `General area: Mililani` with explicit instruction to never mention street/apt/zip. Hard rule + self-check item added. (B) AI stopped referencing quotes that exist in SMS history — regression from `377cbc4`'s "Quote on record: NO" line over-anchoring the model. Fixed: server-side regex scan of SMS history for dollar amounts ($50-$5000 range, filters phone numbers and small junk). New `pricesInHistory` array surfaced explicitly in CONTEXT block as a third state: structured quote → "Quote on record: $X" / no structured but prices in SMS → "Quote on record: not in database, BUT prices visible in SMS history: $385, $345 — you may reference them naturally" / nothing anywhere → existing strict NO. Stage guidance for `Quoted + no structured + has SMS prices` now explicitly tells the AI to reference those prices. New `hasPriceEvidence = hasStructuredQuote \|\| pricesInHistory.length > 0` flag drives Follow-up branches. |
| `377cbc4` (this session) | **AI follow-up: don't claim an estimate was sent without evidence.** User report: AI generated *"Hey Chris, just checking in on the estimate we sent you in April"* for a lead where no estimate had been sent. Root cause: stage='Quoted' or 'Follow-up' was treated as proof a quote was sent. For sheet-imported leads, that stage label came from the spreadsheet — actual quote (if any) might've been verbal-by-phone with no SMS trail and no `quote_total`/`quote_sent_at` in DB. Four prompt fixes: (1) new `hasStructuredQuote` flag computed from `quote_total \|\| quote_sent_at`. (2) Stage guidance now branches: Quoted+evidence keeps original behavior, Quoted+no-evidence says "DO NOT claim to have sent an estimate, be open-ended" (same for Follow-up). (3) CONTEXT block explicitly says `Quote on record: NO` (with instructions) instead of omitting the line — absence is too easy for the AI to ignore. (4) Strengthened PRICES rule + new self-check checklist item: "If the message references 'the estimate I sent' or any dollar amount — is that supported by CONTEXT or SMS history? If not, REWRITE without it." Pure prompt change, no logic. |
| `8f12960` (this session) | **AI follow-up: ban suggesting past dates.** User reported AI encouraged a lead to book on a date that had already passed. The prompt didn't tell the AI what today's date was — so when it saw "Are you free May 5th?" in old SMS history, it treated that as still upcoming. Three prompt changes: (1) inject `TODAY'S DATE: <formatted Hawaii time>` at the top of the prompt. (2) New rule: never suggest/confirm/invite booking on a past date; if SMS history contains an expired proposed date, treat it as expired and use open-ended phrasing instead. (3) Adjacent rule: don't invent specific dates the lead never proposed. (4) Checklist item: "If the message references any specific date, is that date today or in the future (NEVER in the past)?" Pure prompt change, no logic. Same Haiku 4.5, same 800 tokens. |
| `4e23405` (this session) | **Bulk AI follow-up — multi-select on pipeline.** User asked for mass follow-up rather than one-by-one. Added multi-select flow without backend changes — reuses `/api/lead-followup-generate` and `/api/lead-followup-send`. Pipeline view: new "Select" toggle in filter tabs. When on, lead cards show a circle indicator in the corner; cards toggle selection instead of opening profile. Selected cards get a green outline + checkmark. Sticky purple action bar shows count, "All Quoted" / "All Follow-up" shortcuts, Clear, and "✨ AI follow-up to N leads" CTA. New bulk modal with 5 stages: channels → generating (4 concurrent generates, progress bar) → preview gallery (scrollable, each draft editable, failed-to-generate rows pre-skipped with disabled checkbox) → sending (3 concurrent sends) → results (per-lead success/fail summary). State in `window._bulkSelectMode` + `window._bulkSelected` Set + `window._bfDrafts`. Auto-clears + exits select mode on all-success run. **Concurrency rationale**: 4 for generate (Anthropic-bound) and 3 for send (OpenPhone+Resend bound) — polite to APIs while keeping a 50-lead batch under ~25s end-to-end. |
| `2c5d358` (this session) | **Sign-off standardized to "— Dane from Hawaii Natural Clean".** Replaces the previous SMS variants ("— Dane, Hawaii Natural Clean" or "— Dane 🌺") and the email two-line ("— Dane" / "Hawaii Natural Clean") with a single consistent sign-off. Flower emoji still allowed elsewhere in message body if it fits. |
| `1785842` (this session) | **SMS segment counter wording.** User asked if a multi-segment message was sending two separate texts. It's not — recipient sees one message; segments are an OpenPhone billing unit. Reworded counter from "X chars · 2 SMS segments" to "X chars · 1 text (sent in 2 segments — recipient sees as one message)". |
| `b6bc335` (this session) | **Fix: AI follow-up updates were silently failing.** User reported historical AI follow-ups didn't appear in the new Comms log panel. Three diagnostic SQL queries returned 0 rows — meaning the sends never wrote to `lead.notes`, `last_followup_sent_at`, OR `activity_logs`. Root cause: Supabase's `.update()` doesn't throw on schema/constraint errors — it returns `{data, error}`. The original `try/catch` only caught network exceptions, so when the `last_followup_sent_at` column didn't exist (migration never run), the entire UPDATE silently failed and the intended notes-only fallback never executed. SMS went out via OpenPhone fine, but nothing structured was persisted. **All historical sends from before this commit are unrecoverable.** Fix: explicit `res.error` check + real fallback to notes-only update if the full payload fails. **Pattern**: Supabase `.update()` and `.insert()` calls must always check `res.error` — never rely on try/catch alone. Audit other endpoints for the same antipattern. |
| `cd442bb` (this session) | **Per-lead Comms log panel.** User asked how to track what was sent to each lead. Existing logging was scattered: `lead_automation_runs` tracked which rule fired, AI follow-ups were appended as text in `lead.notes`, direct SMS went to `activity_logs` without queryable lead_id, and nothing surfaced in the UI. New unified system: (1) Migration `migrations/2026-05-02-add-lead-comms-log.sql` creates `lead_comms_log` (lead_id, channel, kind ai_followup\|automation\|manual\|owner_alert\|auto_quote, content, subject, status sent\|failed\|skipped, error_message, source_label, sent_at). (2) `/api/lead-followup-send` writes a row per channel on every send. Best-effort — warns to console if migration hasn't run, never fails the request. (3) New `/api/lead-comms-log?leadId=X` endpoint combines `lead_comms_log` + `lead_automation_runs` (with rule name JOIN) into a chronological timeline, newest first, auth-gated. (4) Lead profile UI gets a "Comms log" panel below the action buttons. Each entry shows icon, source label, channel badge, status badge (FAILED in red), subject for email, content preview, Hawaii-time timestamp. Lazy-loads via `dataset.loadedFor`, has a Refresh button, auto-refreshes after a successful AI follow-up send. **Future improvement**: when automations are re-enabled, `run-automations.js` should also write to `lead_comms_log` when it sends SMS/email (currently only the run record exists). |
| `6059476` (this session) | **Backfill SQL for historical AI follow-ups.** Side script to recover historical AI follow-up entries from `lead.notes` text into `lead_comms_log`. Parses lines like `[May 2, 10:42 PM] AI follow-up sent (SMS + Email)`, splits the channels, parses partial timestamps as Hawaii time + current year, inserts one row per channel. Marked with `source_label = 'AI follow-up (backfilled from notes)'` so distinguishable. Idempotent (NOT EXISTS guard within 5min of parsed timestamp). **Note**: this turned out to be a no-op for Dane because earlier sends had silently failed to write to notes anyway (see `b6bc335`). Kept in repo for future similar recovery scenarios. File: `migrations/2026-05-02-backfill-comms-log-from-notes.sql`. |
| `86e0a4b` (this session) | **Fix: AI follow-up generate failed when AI returned JSON + extra prose.** User saw `Generation failed: AI response was not valid JSON: Unexpected non-whitespace character after JSON at position 248`. Cause: AI was returning valid JSON followed by commentary like "Note: I made this warm and Hawaiian." or an extra JSON object. My naive parser used `indexOf('{')` and `lastIndexOf('}')` which is brittle — picks up any closing brace including ones inside string values or in trailing content. Replaced with `_extractFirstJsonObject()` — walks forward from first `{`, tracks brace depth, string boundaries, and escape characters, returns the first syntactically balanced `{...}` block. Robust against preamble, postamble, multiple JSON objects, braces inside SMS text, and markdown fences. Also tightened the prompt's OUTPUT FORMAT directive to be strict: "The very first character of your response must be `{` and the very last character must be `}`." with explicit bans on "Here's the message:" preamble and "Note:" postamble. Better failure logging too — both raw and cleaned attempt logged on parse error. **Pattern**: any time a Vercel function asks an LLM for JSON, never use indexOf/lastIndexOf. Use a brace-depth tracker. Should be promoted to a shared utility next time another endpoint needs LLM JSON. |
| `b070e67` (this session) | **Fix: AI follow-up failed with 'Unexpected token <' parse error.** User tested AI follow-up on themselves, got `Send failed: SMS error: Unexpected token "<", "<!doctype "... is not valid JSON`. Root cause: `lead-followup-send.js` used `process.env.VERCEL_URL` for the inter-function base URL — that points to the deployment-specific hostname which hits Vercel's deployment-protection auth wall and returns HTML. `JSON.parse` on HTML throws the cryptic error. Three fixes: (1) hardcoded `BASE_URL = 'https://hnc-crm.vercel.app'` to match the pattern in `run-automations.js` + `run-task-deadline-reminders.js` (production alias is stable and protection-exempt). (2) Fixed bogus `TIMEOUTS.QUO` reference (constant didn't exist; silently `\|\| 10000` fallback) — now uses `TIMEOUTS.OPENPHONE` = 8000 and `TIMEOUTS.RESEND` = 8000. (3) Hardened JSON parsing in both SMS and email branches: read body as `text()` first then try `JSON.parse`, throw clear `/api/X returned non-JSON (HTTP N): <preview>` message on failure so future debugging is easy. **Pattern**: any time a Vercel function calls another Vercel function via HTTP, hardcode `https://hnc-crm.vercel.app` (or the eventual custom domain) — never use `VERCEL_URL`. |
| `527750d` (this session) | **AI follow-up: detect prices quoted via SMS.** User reported many quotes were sent via SMS (not the lead-form auto-quote that populates `lead.quote_total`), and the AI was generating generic "still interested?" messages instead of referencing the actual price the lead saw. Two prompt changes in `/api/lead-followup-generate.js`: (1) PRICES rule rewritten — was "Do NOT include a price unless one is provided in CONTEXT — never invent numbers" (interpreted strictly as only the structured CONTEXT block), now explicitly tells the AI to look in BOTH the structured CONTEXT and the SMS conversation history, and reference any price found naturally. Still bans inventing prices that don't appear anywhere. (2) Bumped `maxSms` from 30 to 100 in the OpenPhone history pull so old quote messages aren't truncated for chatty leads. Call summaries (5 max) also often contain prices and are already part of the prompt — now explicitly allowed for use. |
| `e941f2d` (this session) | **AI follow-up: rewrite prompt for warm Aloha brand voice.** User flagged generated message as CRM-bot tone, not local Hawaii: *"Hey Dane, just checking in on that Regular Cleaning quote for $179.56. Still interested?"* — every phrase in it was corporate. Three prompt changes in `/api/lead-followup-generate.js`: (1) Channel instructions now mandate "Aloha [firstName]," opener and sign-offs of "— Dane, Hawaii Natural Clean" / "— Dane 🌺"; SMS includes a positive tone-reference example. (2) New brand-voice paragraph at top of GENERAL RULES embeds the business identity (small, locally-owned, Oahu+Maui, owner-written messages, never corporate). (3) Explicit BANNED PHRASES list: "just checking in", "following up on that", "wanted to reach out", "circling back", "touching base", "I hope this finds you well", "per our last conversation" + BANNED OPENERS (Hey/Hi/Hello/Dear/Hi there). Plus a self-check checklist at end. No backend logic changes — pure prompt engineering. Same Haiku 4.5, 800 tokens, same JSON shape. The 24-hr appointment reminder in `send-reminders.js` was used as the brand voice anchor. |
| `bedd7c4` (this session) | **do_not_contact semantic change: cron-only, not manual.** After bulk-flipping 46 Quoted/Follow-up leads to `do_not_contact = true`, the AI follow-up button refused to send for all of them — defeating the purpose. The flag now means "exclude from scheduled cron automations" (Day-3 follow-up sweeper, nurture sweepers, broadcasts) — NOT "block all comms". The AI follow-up button is a manual override the user explicitly clicks, so it bypasses the flag. Backend gate removed from `/api/lead-followup-send`. Toggle pill text and state messages on the lead profile updated to clarify scope. Crons still respect the flag — gates in `run-task-automations.js` (line 255), `run-automations.js` (line 248), `send-broadcast.js` (lines 361, 378) all unchanged. **For "never contact" semantics:** delete the lead or use the public unsubscribe link — there's no separate flag for that. |
| `81d417a` (this session) | **Per-lead automation-exclusion toggle (do_not_contact) — initial UI.**
| `dafe2e9` (this session) | **Scheduling: support shifting day-of-week for a recurring series.** User report: tried to move Bobby Nikkhoo's weekly Fridays to Thursdays via "all recurring" — nothing changed. Root cause: `'all'` mode was built for time/cleaner/service/property changes only. The `sbBasePayload`, in-memory `seriesFields`, and `recurringAppts` template update all silently dropped date changes. Now: when in `'all'` mode and the anchor date has changed for a recurring series, compute `dayShift` between original and new dates → confirm with user (shows direction + count + "Friday → Thursday") → after the field-update DB ack, fetch all future non-completed non-paid rows for `series_id` and per-row UPDATE each one's date by `+dayShift days` → update `recurringAppts` template's `dayOfWeek + startYear/Month/Day` → call `_refreshAppointmentsFromDB` to re-bucket `apptData`. Past completed appointments stay where they actually happened. Paid rows are skipped. Per-row UPDATE used because Supabase JS doesn't expose raw Postgres expressions in `.update()` — slightly more network traffic but correct. |
| `dd10d77` (this session) | **Fix: deleting one of two duplicate appointments wiped both from UI.** User report: had two duplicate Susanna DeSantos appointments. Deleted one — both vanished from the calendar. Refresh brought one back. Same overmatch antipattern as the halt-series bug fixed in `0bcf785`: `deleteAppointment`'s in-memory filter was matching by name+time instead of `dbId`. Three fixes: (1) in-memory filter now matches by `dbId` only; rows with no dbId (optimistic-only) drop by exact object reference. (2) DB delete now requires a dbId — removed the latent name+date+time fallback that would have deleted both duplicates from the DB too. (3) After successful delete, calls `_refreshAppointmentsFromDB({settleMs: 200})` so any drift self-corrects. Same pattern as halt-series — destructive ops on appointments should always end with a DB-source-of-truth refresh. |
| `9c26680` + `03dba79` (this session) | **AI follow-up button on lead profiles.** New "✨ AI follow-up" button (purple gradient) on each lead's action grid lets Dane manually nudge a lead with AI-personalized content outside the regular automation cron schedule. Two backend endpoints: `/api/lead-followup-generate` pulls lead row + OpenPhone history (30 SMS + 5 calls) and runs Claude Haiku 4.5 with a stage-aware prompt (different tone for New inquiry vs Quoted-no-reply vs Quoted-with-reply vs Follow-up cold vs Closed lost); `/api/lead-followup-send` routes SMS via `/api/send-sms` and email via `/api/send-email`, records the send to `lead.notes` + sets `last_followup_sent_at`. Frontend modal has 4 steps: channel-picker (SMS / Email checkboxes, auto-disabled when no contact info, SMS pre-checked if phone exists, email pre-unchecked) → loading spinner → preview with editable textarea+subject+body and SMS char/segment counter → success/error result. **TEST_MODE_DANE_ONLY** constant at top of `lead-followup-send.js` (currently `false` = live) gates real sending to Dane only when `true`. Migration `migrations/2026-05-01-add-last-followup-sent-at.sql` adds tracking column; backend tolerates missing column with notes-only fallback. Both endpoints require Bearer auth (same pattern as `/api/tasks`). |
| `81368c3` (this session) | **New appointment form starts blank.** Clicking "+ New appointment" used to leave whatever was typed in the form last time still filled in (name, address, beds/baths, notes, override checkboxes, etc), making it look like saved data from another session. Added `resetNewApptForm()` called from `handleTopCta` before opening the overlay. Resets all 18 form fields to schema defaults (contact blank, service=Regular, freq=Biweekly, time=8am, cleaner=unassigned, beds=3 baths=2, condition=Good, all override checkboxes off, address data-attrs cleared). **Important:** other entry points that intentionally pre-fill (convert lead → booking, click calendar day to add) are unaffected — they don't go through `handleTopCta`. The reset only fires from the topbar "+ New appointment" button. If you ever wire another entry path that should also start blank, call `resetNewApptForm()` before `openOverlay`. |
| `a066bd4` (this session) | **Calendar: always start on current month + wire the dead "Month view" button as Today.** Two bugs in one fix. (1) `curYear`/`curMonth` were hardcoded to `2026, 4` so every reload landed on April 2026 — now read from `new Date()` on init. (2) The topbar `#sec-btn` ("Month view" button next to "+ New appointment") had NO `onclick` handler — clicking it did nothing. Repurposed as "Today": jumps to current month + switches to month view. Wired via new `handleSecBtn()` that dispatches on `currentView`; calendar gets the Today behavior, other views' `secs` labels (`Export` / `Filter`) stay as no-op since they weren't wired to anything before either. |
| `201bc6e` (this session) | **Fix: Google Places address dropdown sometimes stuck visible after selection.** Well-known glitch of Google's legacy `Autocomplete` API — the `.pac-container` dropdown sometimes fails to hide itself after `place_changed` fires, especially under fast clicks or quick focus changes. Three defensive layers added: (1) post-`place_changed` `setTimeout` force-hides all `.pac-container` elements; (2) `blur` handler on each address input defers 150ms then hides (defer needed because Google's own blur handler can momentarily re-show); (3) global `focusin` listener — when focus moves to any non-address field anywhere in the document, immediately hide all `.pac-container` elements. Layer 3 is the one that fixes Dane's reported case (picked address, clicked into beds/baths, dropdown stayed visible). |
| `0bcf785` (this session) | **Halt-series: tighten in-memory match + auto-refresh from DB.** User report: halting one of three Jan Kunst series caused all three to vanish from the schedule until reload. Two compounding issues: (1) `byNameTime` filter ran even when `targetSeriesId` was set, so halting series-A would over-match siblings B/C with same name+time. Fixed by gating `byNameTime` on `!targetSeriesId` — used only as legacy fallback for rows with no series_id. (2) Added two reusable helpers in `index.html`: `_rebuildAppointmentsFromDB(appts)` (wipes + rebuilds `apptData` and `recurringAppts` from fresh DB result, extracted from `loadAllData`) and `_refreshAppointmentsFromDB({settleMs})` (re-fetches via `dbLoadAppointments` + rebuilds + renderCal). Halt-series now calls `_refreshAppointmentsFromDB` on both success and error paths so in-memory state always matches DB state — eliminates the "have to refresh to see correct info" class of bug. **General principle going forward:** any destructive op on appointments should call `_refreshAppointmentsFromDB` rather than relying on in-memory pruning. Cheaper than chasing every edge case in filter logic. |
| `81d53ea` (this session) | **Fix: editing a recurring series duplicates the entire series.** User report: editing weekly appointment from 8am→5am for "all recurring" added a duplicate series at 8am instead of updating the existing one. Root cause: tail-regeneration in `saveApptEdit` ran unconditionally on every 'all' save. Tail-regen exists to forward-generate future occurrences when converting a one-time into a recurring — but it was also firing for edits to an existing series, where there's nothing to regen (the all-series DB UPDATE handles existing rows). The in-memory dedup check missed DB rows for unrendered months, so it inserted duplicates with the same `series_id`. Visible bug: user sees both the updated 5am rows AND fresh 5am duplicates, plus the in-memory dirty render shows mixed states during the parallel DB sync. **Fix:** gate tail-regen on `_isExistingSeries = !!a.seriesId` — only run when CONVERTING a one-time to recurring. Editing an existing series now relies entirely on the all-series UPDATE, which was already correct. **Other scheduling complaints reported in same session ("sometimes doesn't appear immediately", "sometimes wrong times")** are separate and need a specific repro to diagnose. The optimistic in-memory insert + renderCal happens before DB sync, so failure mode is likely either the user being on a different month than the new appt, or rare DB-rollback re-render. |
| `da66865` (this session) | **CRM startup speed: parallelize 4 DB fetches + render pipeline early.** User report: pipeline took 2-3s to show leads after page load. `loadAllData` was running 4 awaits in series — clients → cleaners → appointments → leads — stacking 4 round-trip latencies on top of each other, with pipeline render gated behind the expensive appointments processing pass. Fix: (1) `Promise.all` the four `dbLoad*()` calls; they have no fetch-time dependency on each other (only processing-time), so they can hit the network simultaneously. (2) Move the leads.forEach + `renderLeadsPipeline()` to BEFORE the appointments processing block — the pipeline view has zero dependency on appointments. Result: leads appear 1-2s sooner. Total app load wall-clock is roughly the same but first-useful-view is much faster. **Console marker for measuring:** look for `[loadAllData] All 4 fetches completed in Xms` to see fetch latency, separate from processing time. |
| `5c61f7b` (this session) | **Fix: lead stage changes silently reverting on reload.** User marked Zakyah as Closed lost; worked in UI; reverted to Quoted after reload. Root cause: 4 lead-update sites in `index.html` were fire-and-forget — `db.from('leads').update(...)` returned a Promise nobody awaited or error-checked. Any DB failure (RLS, length limit, network blip) flipped the UI but never persisted. Fixed: `markLeadLost`, `convertLeadToClient` (markLeadWon), `reactivateLead`, and `saveLeadEdit` are now async + await + check `res.error` + show error toast + return early on failure. Optimistic UI now happens AFTER the successful DB write, not before. The auto-fired `_markLeadWonOnBook` (during booking conversion) stayed fire-and-forget so it doesn't block bookings on a stage-update glitch, but now logs failures to console instead of swallowing them. **Watch for this antipattern elsewhere** — any `db.from('xxx').update(...)` followed by `.eq(...)` without an `await` or `.then(res => check error)` is the same bug waiting to surface. |
| `463c328` (this session) | **Tasks: real undo + clickable reopen + daily deadline SMS.** Three things together. (1) `/api/tasks` gets a new `reopen` action — was missing, so any undo was UI-only and reverted on reload. (2) The Undo button on the post-completion toast now syncs to the API; toast lifetime extended 5s → 8s for accidental-tap recovery. New `reopenTaskById()` function in `index.html` and a clickable green-check on tasks already in the Done pile (was a static span before) so you can reopen anytime, not just within the toast window. (3) New cron `/api/run-task-deadline-reminders` runs at 18:00 UTC (8 AM Hawaii) and texts OWNER_PHONE a digest of tasks due today + overdue. No kill switch — owner-only notification, low blast radius. Silent on days with no due tasks. |
| `92c3fde` (this session) | **Fix: manual task create/complete/delete failing with 401.** `/api/tasks` was hardened with a `Bearer` auth check, but the three front-end callers in `index.html` (`submitTask`, completeTask sync, deleteTaskById sync) were firing with no auth header. The global fetch interceptor that auto-injects Supabase auth (~line 2151) is scoped to `/api/stripe-invoice` only, so it didn't help here. Each caller now reads `db.auth.getSession()` and sends `Authorization: Bearer <access_token>` (matching the pattern used at lines 4629 and 7773). |
| `9064411` (this session) | **Fix: "Error: lead-overlay" false-positive on every profile save.** Two `showToast` functions existed in `index.html` — old `showToast(overlayId, msg)` at line 4798 and new `showToast(msg, isError)` at line 14144. Function hoisting meant the second one always won, so every old-style caller (6 of them — lead/client/cleaner save toasts + 3 SMS-result toasts) was passing the overlay ID as `msg` and the success message as `isError` (truthy). Result: red "Error: lead-overlay" / "Error: client-overlay" / "Error: cleaner-overlay" toasts on every successful save, despite the save actually working. **Fix:** collapsed to a single canonical `showToast(msg, isError)` signature, updated all 6 stale callers, removed the dead first definition. Pre-existing bug unrelated to this session's janitorial work — surfaced because Dane was actively editing a lead and saw the misleading error. |
| `c34bc05` (this session) | **Janitorial leads bypass follow-up automations.** Bug: janitorial leads were being marked `stage='Quoted'` + `segment='initial_sequence'` like every other lead, which made them eligible for the Quoted→Follow-up daily cron AND the `days_since_response` segment-based automation. Both wrong — janitorial converts via in-person walkthrough, not text follow-up. Fix: at insert, janitorial leads now get `segment='janitorial_walkthrough'`. After the walkthrough request SMS+email goes out, stage is set to `'Walkthrough requested'` (not `'Quoted'`). Both follow-up sweepers filter on values janitorial leads don't have, so they're now skipped naturally. Frontend stage dropdown, sort map, and color map updated to support the new stage. Optional column `walkthrough_request_sent_at` added via `migrations/2026-05-01-add-walkthrough-request-sent-at.sql`; backend falls back to stage-only update if the migration hasn't run yet so rollout is safe either way. |
| `de14a03` (this session) | **AI summary: simplified lead/client view to a single "🚩 Things to know" section.** Per Dane's feedback, the 6-section format was restating profile fields (LTV, last job, etc.) which made the actual signal harder to find. Now: lead and client modes return ONE section with bullets focused on buried context — preferences, complaints, access notes, open threads, key situational info ("out of country", "second property coming"). Explicitly prohibits tone reads, profile-field restatement, and filler. Falls back to "Nothing notable in their history yet — profile speaks for itself" if nothing surfaces. **VA pre-call brief (mode='va_brief') keeps the full 6-section format** — it's a different surface (Tasks page) read by reps prepping for a call, where the comprehensive structure earns its keep. Branching lives in `buildSummaryPrompt` in `api/utils/summary-prompt.js`. Lowered max_tokens to 600 (was 800) for the user-triggered path since one section needs less room. |
| `2a14bce` (this session, partially superseded by `de14a03`) | **AI summary UX rework + bug fix.** Three things shipped together. (1) Visual bug — positioned `::before` bullet markers were colliding with content for some user → switched to native `list-style:disc` with `padding-left:22px`, browser handles layout. Also fixed `_applyBold` regex to run inside paragraphs (was only running inside bullets). (2) Volumes reverted per Dane's preference: 30 SMS / 5 calls, `max_tokens` back to 800, prompt softened from "max 2 bullets / 10 words" back to "aim for 2-4 bullets, short and scannable". (3) Auto-load + reveal pattern — opening a client OR lead profile now silently fires the summary fetch in the background. The Generate button morphs through `idle → loading (spinner) → ready (View summary) → expanded (Hide summary)`. Summary stays collapsed until user taps View. New `_setSumState(btnId, sumId, state)` helper drives both surfaces. Cache via `data-html` on the container so toggling expanded ↔ ready doesn't refetch. Switching profiles invalidates the cache via `loadedFor` dataset. **Removed** the `cl-ai-thinking` and `lead-ai-thinking` divs (button shows loading state inline) and a duplicate stale `generateLeadSummary` further down in `index.html`. Legacy function names (`generateClientSummary`, `generateLeadSummary`) are kept as aliases that delegate to the new `loadXSummary` for any older call sites. |
| `c9bd40c` (this session, partially superseded by `2a14bce`) | **AI summary: tighten + speed up.** User feedback: slow, jumbled, too long. Three changes: (1) prompt hard-caps at 2 bullets/section + 10 words/bullet + "no preamble" + encourages `**Label:** value` style; (2) OpenPhone fetch dropped to 20 SMS / 2 calls (calls were the slow part — each requires a separate summary-fetch roundtrip); (3) `max_tokens` 1000 → 500; (4) renderer now strips ```markdown fences and any preamble before the first `##`, so Haiku occasionally adding "Here's the briefing:" no longer breaks layout. |
| `1d5d4cd` (this session) | **AI summary speed tuning.** Switched user-triggered `/api/ai-summary` from Sonnet 4.6 → Haiku 4.5 and reduced OpenPhone history fetch from 100 SMS / 10 calls → 30 SMS / 5 calls. Target land time ~2-5s for a button click. The VA pre-call brief in `run-task-automations.js::generateCallBrief` **stays on Sonnet 4.6 with full 100/10 history** because it's a background cron — quality matters more than latency for a brief a human reads before a sales call. **Two-model split is intentional:** if you want richer summaries on the UI buttons later, the cost is ~5x latency; pick the tradeoff per-surface, not globally. |
| `a5c3c8c` (this session, superseded by `1d5d4cd`) | AI summary timeout fix that bumped the structured Sonnet path to 45s. Now moot since the UI path uses Haiku, but the VA cron path still has the 45s timeout so this isn't fully reverted. |
| `7ccdbd5`–`951e6be` (this session) | **Structured AI summaries (6-section bulleted format) — unified across lead profile, client profile, and VA pre-call brief.** New shared helper `api/utils/summary-prompt.js` exports `buildSummaryPrompt({mode, data, history})` returning the canonical prompt that demands six fixed markdown sections (👤 Who / 💰 Money / 📅 Service / 📞 Comms / 🚩 Flags / ➡️ Recommended next action) — Claude must output every section even if empty. Used by `/api/ai-summary` (the manual "Generate" buttons on lead + client profiles in `index.html`) and `api/run-task-automations.js::generateCallBrief` (Day-1 + Day-5 VA tasks). Both bumped to `claude-sonnet-4-6` with `max_tokens: 1000`. The `/api/ai-summary` endpoint accepts `{mode, data, phone}` and when phone is provided, fetches up to 100 SMS + 10 call summaries from OpenPhone server-side via `getOpenPhoneHistory` and feeds them into the prompt. Frontend has `renderSummaryHtml()` that converts the markdown to safe HTML (escapes content first, then converts `##`, `-`, and `**bold**`) and shows a "Generated <date> · includes/no call/SMS history" meta line below each summary. New CSS classes: `.ai-sum-h`, `.ai-sum-ul`, `.ai-sum-p`, `.ai-sum-meta`. **Backwards compat preserved**: legacy `{prompt}` and `{leadData}` callers still work (Haiku, 300 tokens). |
| `0cc1f28` (this session) | **Fix: VA task automation toggles couldn't be turned on.** `_vaTaskToggle` (handles Quote Day 1, Quote Day 5, First Clean Complete toggles in the Automations view) was only writing to `localStorage` and relying on the document-level delegated change listener to write to `ai_booking_settings`. But `_vaTaskToggle` calls `renderAutoList()` synchronously mid-event, which replaces `#auto-list` innerHTML and detaches the input. The delegated handler's `t.matches('#auto-list ...')` guard then returned false, skipping the DB write. Result: toggle visually flipped on but reload restored OFF from DB. Fix: `_vaTaskToggle` now writes directly to `ai_booking_settings.va_task_<key>_enabled` and updates `window._automationFlags`. Also fixed `_vaTaskEnabled` to prefer the in-memory DB cache over localStorage so the ACTIVE/Off badge reflects truth. **Watch for the same antipattern** in any other inline `onchange` handler that calls `renderAutoList()` — the delegated listener WILL silently bail. |
| `94aef6d` (this session) | **Lead automation rollout audit + fixes**. Pre-flight before flipping `auto_quote_enabled` / `new_lead_owner_sms_enabled` on. Three real bugs found and fixed: (1) lead `stage` was never auto-advanced past 'New inquiry' — `lead-capture.js` now sets `stage: 'Quoted'` alongside `quote_sent_at` in BOTH the auto-quote branch and the janitorial-walkthrough branch (commit `69f4fd2`); (2) new leads had `segment = NULL` so the `days_since_response` automation never matched anyone — `lead-capture.js` now sets `segment: 'initial_sequence'` + `segment_moved_at` on insert; (3) no rule ever moved leads to 'Follow-up' — added a step to `run-task-automations.js` (existing daily cron at 18:00 UTC) that advances `Quoted → Follow-up` after 3 days when `quote_sent_at` is 3+ days old AND `last_responded_at IS NULL` AND `do_not_contact = false`. Stage-advance step is a pure DB write with no contact side effects, so it does NOT respect the `TASK_AUTOMATIONS_TEST_MODE` flag at the top of that file. Also: `OWNER_EMAIL` in `lead-capture.js` updated from `dane.kreisman@gmail.com` to `dane@hawaiinaturalclean.net`. |
| (this session, 2026-04-30) | **Waiver overhaul (commits `89fe28b`–`1dfe763`)**: condition-tier picker on `lead-form.html` (5 photo cards, real HNC job photos for 4 tiers, hover-zoom desktop-only); `agree.html` rewritten with hero/checklist/before-arrival/policies architecture and `?svc=` URL filtering; `book.html` step 2 ported to mirror `agree.html` (loads from `/api/get-policies` + `/api/get-checklists`, infers service from `LEAD.service`); new p5 policy "Quote accuracy & on-arrival adjustment" (legal hook for raising prices on under-described moveouts); move-out 6-item required block surfaces as ONE consolidated bulleted policy checkbox titled "Move-out preparation requirements"; all service cards collapsed by default; new `/api/get-checklists` endpoint with full DEFAULTS fallback; `supabase/add_service_checklists.sql` migration; service-aware waiver SMS routing in `api/lead-book.js` (uses `body.service`) and `api/run-policy-reminders.js` (uses upcoming appointment's `service` from join). |
| (this session, 2026-04-30) | `migrations/2026-04-30-backfill-cleaner-service-rates.sql` — backfill `rate_regular_cents` / `rate_deep_cents` / `rate_moveout_cents` on cleaners that pre-date these columns. Formula: regular = `hourly_rate`, deep = `hourly_rate + 5`, moveout = `hourly_rate + 5`. Run once in Supabase SQL editor. Also updated DEVELOPMENT_GUIDE Known Gotchas with a note explaining the per-service rate system already exists in `calcCleanerPay()` / `serviceRateKey()` and not to reinvent it. |
| (this session) | `DEVELOPMENT_GUIDE.md` — document activity log coverage, client profile modal, calendar→client link, browser-editor workflow, new gotchas |
| `53df3d6` | `index.html` — wire up client profile Stats (Lifetime, Total jobs, Avg, Monthly) from appointments |
| (in main) | `index.html` — Job History wired up + calendar appointment Client field clickable → opens client profile |
| `65dfffa` | `index.html` — add Automation log section to client profile modal + `loadClientActivityLog()` function |
| `62b5a21` | `api/tasks.js` — log VA-task email to activity_logs (direct Resend bypass case) |
| `41f30a0` | `api/send-sms.js` — log every successful SMS to activity_logs |
| `77e029f` | `api/send-email.js` — log every successful email send to activity_logs |

---


**2026-04-30 — Stripe security overhaul (response to dup-charge incident):**
- `2f731da` kill switch on stripe-invoice (ALLOW_STRIPE_CHARGES env var gate)
- `d157c77` → `46bdf26` /api/admin/revoke-user (paginated GoTrue lookup, ban + sign-out by email)
- `3815bf0` BLOCKED_EMAILS denylist in requireAuth
- `1d7abf3` Fix 1/5 — idempotency keys on all 8 Stripe .create calls
- `e67e340` Fix 2/5 — charge audit log + invoice backfill
- `5288320` Fix 3/5 — server-side duplicate guard
- `b8b12fb` Fix 4/5 — client-side fetch interceptor
- `0497b86` + `18a197d` + `3c70dba` + `7a13790` Fix 5/5 — requireAdmin gate + ADMIN_EMAILS + frontend Authorization header injection
- `ad18ddb` Unknown-action fix — action normalization + error_logs catch-all logging
- `1c55e4c` Null-safe destructure follow-up

## Activity Log Coverage

**Goal:** every non-broadcast outbound communication is automatically logged to `activity_logs`. No per-call wiring required when adding new automation features.

### What's covered automatically
- Any caller hitting `/api/send-email` — logged with action `email_sent_${type}` (e.g. `email_sent_invoice`, `email_sent_reschedule`, `email_sent_thankyou`, `email_sent_booking_confirmation`, `email_sent_generic`). Metadata: `to`, `subject`, `type`, `clientName`, `resend_id`.
- Any caller hitting `/api/send-sms` — logged with action `sms_sent`. Metadata: `to` (E.164), `message_length`, `openphone_id`.
- All `run-*.js` cron handlers route through these endpoints, so they inherit logging.

### Manual coverage (one-off)
- `api/tasks.js` — VA-task email uses Resend directly (not via `/api/send-email`), so it has its own logActivity call. Action: `email_sent_va_task`.

### Intentionally excluded
- `api/send-broadcast.js` — uses Resend directly with custom logic. Per Dane's spec, broadcast sends are NOT logged to activity_logs.

### When adding new send pathways
If you bypass `/api/send-email` and `/api/send-sms` (e.g. directly hitting Resend or OpenPhone APIs from a new endpoint), add a manual logActivity call following the pattern in `api/tasks.js`. Otherwise the send won't appear in client profile activity logs.

### Schema reminder
`activity_logs` columns: `id, created_at, action, description, user_email, entity_type, entity_id, metadata (jsonb)`. The recipient is stored in `metadata.to` — that's the field the client profile filters on.

---

## Client Profile Modal

The Clients page modal lives in `index.html` with fixed HTML structure. All fields use `cl-*` IDs. The modal is opened by `openClient(id)` (defined around line 4165 of `index.html`).

### Element ID inventory
- Header: `cl-title`, `cl-av`, `cl-name`, `cl-type`, `cl-status`
- Contact: `cl-phone`, `cl-email`, `cl-address`, `cl-payment`, `cl-since`, `cl-policies`
- Stats: `cl-ltv` (Lifetime value), `cl-mrr` (Monthly revenue, rolling 30 days), `cl-jobs` (Total jobs), `cl-avg` (Avg job value)
- Service details: `cl-service`, `cl-freq`, `cl-sqft`, `cl-bedbath`, `cl-cleaner`, `cl-lastjob`, `cl-nextjob`
- Sections: `cl-history` (Job History), `cl-ai-summary`, `cl-ai-thinking`, `cl-properties`, `cl-notif-prefs`, `cl-notif-toggles`, `cl-activity-log` (Automation log), `cl-notes`

### Loader functions called by openClient
- `loadNotifPrefs(id)` — populates notification toggles (defined twice in source — see Known Gotchas)
- `loadClientActivityLog(id)` — fills `#cl-activity-log` with rows from activity_logs filtered by client's email/phone
- `loadClientStats(id)` — fills the stat tiles
- `loadClientHistory(id)` — fills `#cl-history` with past completed/paid appointments

### Stats calculation rules (do not break)
- "Done jobs" = appointments with `status IN ('completed', 'paid')`. Note that `paid` is by far the most common done state (~855 rows) vs `completed` (~135). **Do NOT filter only on `status='completed'`** — you'll miss ~85% of data.
- `cancelled` is excluded.
- "Monthly revenue" = sum of `total_price` for done jobs in the last 30 calendar days (rolling, not calendar month).
- Some appointment rows have `total_price = 0` from data quality issues. They count toward "Total jobs" but contribute $0 to Lifetime value.

### Calendar appointment → client profile link
Both `#appt-title` (modal header) and `#ai-client` (Client field in JOB INFO) are made clickable when the appointment modal opens. Click handler:
1. Reads `currentAppt.client_id` (which is set when `_openApptInner` runs)
2. Calls `closeOverlay('appt-overlay')` to dismiss the appointment modal
3. Calls `openClient(client_id)` to open the client profile

The handler is set up via a one-shot IIFE near the end of the script. Uses dotted-underline styling to indicate clickability.

### Adding new fields to the modal
1. Add the HTML element with a `cl-*` ID inside the existing modal markup. The cleanest insertion anchor is between `id="cl-notif-toggles"></div>` and `<div class="panel-section">Notes</div>`.
2. If it's data-driven, add a loader function near the end of the script (just before the last `</script>` tag — use `text.lastIndexOf('</script>')` for a guaranteed-unique anchor).
3. Wire the loader call inside `openClient(id)` after `loadNotifPrefs(id);`.

---

## Browser-Editor Workflow (legacy fallback — rarely needed)

Only relevant if Claude is operating in an environment without bash/git access (e.g., a pure Claude in Chrome session with no filesystem tools). The default deploy path is now the **Deployment Workflow** section above. Patterns below are kept for the rare fallback case:

### The fetch → modify → clipboard → paste loop
1. Fetch raw file from `https://raw.githubusercontent.com/danekreisman/hnc-crm/main/<path>` via `fetch()` in browser JS.
2. Compute modified text in JS (string concatenation or `String.replace` with verified-unique anchors).
3. Verify the find anchor matches exactly once: `raw.split(anchor).length - 1 === 1`. If it doesn't, find a more specific anchor or use `lastIndexOf` + slice/concat instead.
4. Write modified text to clipboard: `await navigator.clipboard.writeText(modified)`. Requires document focus — if it throws "Document is not focused", click anywhere on the page first.
5. Navigate to `https://github.com/danekreisman/hnc-crm/edit/main/<path>`.
6. Click somewhere INSIDE the editor's content area (`(800-900, 500-600)` works), then `cmd+a` to select all, `cmd+v` to paste.
7. Click the green "Commit changes…" button (top right). Coordinates depend on scroll position: `y=149` if at top of page, `y=85` if scrolled. Take a screenshot first to be sure.
8. In the dialog: triple-click the commit message field at `(727, 246)`, type new message, click "Commit changes" at `(902, 656)`.
9. Vercel auto-deploys in ~60s.

### Common failure modes
- **Paste didn't take, commit button stays grey.** `cmd+a` selected something other than the editor (file path input, sidebar). Re-click inside editor at coordinates that show visible code, retry. A confirming sign that paste worked: page scrolls to show new content and Commit button becomes bright green.
- **Triple-click hit editor instead of dialog.** If the commit dialog didn't actually open (because the click missed the button), the next triple-click selects code in the editor — and typing OVERWRITES that code. Recovery: click in editor, `cmd+z` multiple times to undo, then re-paste.
- **Content filter blocks JS output.** The Chrome MCP filter strips output containing certain patterns: full URLs (`api.resend.com`), base64 data, certain keys/secrets. Workarounds: (a) return char codes via `Array.from(s).map(c => c.charCodeAt(0))` — guaranteed safe; (b) replace bracket-like chars with placeholders before returning; (c) avoid printing matched text — just print indices/counts.

---

## Updates to Known Gotchas (additions for the section above)

- **`index.html` has duplicate `loadNotifPrefs` definitions** at lines ~14331 and ~16551. JS hoisting means the last one wins. When adding new helper functions referenced from `openClient`, inject them at the very end of the script (using `text.lastIndexOf('</script>')`) — this avoids picking the wrong duplicate as your insertion anchor.
- **The appointment modal's `window.currentAppt` global** holds the parsed appointment data including `client_id`, `cleaner_id`, `dbId`, `service`, `totalPrice`, etc. It's populated when `_openApptInner` runs. Use this in any new appointment-modal-related features rather than re-parsing `data-appt` attributes.
- **Appointment status values are `paid` (~855), `completed` (~135), `cancelled` (~10)**. `paid` is by far the most common "done" state. Always filter `IN ('completed', 'paid')` when querying for done jobs — never only `status='completed'`.
- **Some appointments have `total_price = 0`** (data quality issues from imports). Stats include them in counts but they contribute $0 to Lifetime value. Not a bug.
- **The Chrome MCP JS sandbox blocks output** containing URLs, base64-encoded data, or certain key patterns. When inspecting source code, return char codes or replace bracket-like characters before returning.
- **Booking form's property dropdown loads via two triggers, not one.** `populatePropertySelector(name)` populates `#na-property-select` with the client's saved properties (from `clients.properties` JSON array) and auto-selects the first. It's called from (1) the autocomplete-suggestion click handler in `na-name`, AND (2) `na-name`'s `onblur`. If you ever wire a third path that fills the name programmatically (drag-and-drop, deep link, etc.), call `populatePropertySelector(name)` from there too — otherwise the user lands in "+ Create New Property" mode and beds/baths/sqft default in instead of carrying over from the saved property.
- **Properties are stored as a JSON array on `clients.properties`, not a separate `properties` table.** Each entry has `address`, `beds`, `baths`, `sqft`, `notes`, `price`, etc. (often empty strings on imported clients). There is no `public.properties` table — don't try to JOIN one.
- **Commercial/Janitorial booking field handling in `saveNewAppt` (~line 5330):** beds and baths are intentionally cleared for commercial (`isCommercialAppt?'':...`) since they don't apply, but `apptSqft` is read for ALL service types including commercial — pricing depends on it. Don't reintroduce a commercial guard on sqft.

---


- **Vercel env-var changes don't apply to running deployments.** After adding/changing an env var (e.g. `ALLOW_STRIPE_CHARGES`) the existing serverless functions keep using the old values until a new deployment runs. To force a fresh deploy, push an empty commit:
  ```
  git commit --allow-empty -m "Force redeploy" && git push origin main
  ```
- **The `/api/stripe-invoice` endpoint had no auth at all before 2026-04-30.** It was publicly callable. The kill switch was the only thing standing between the public internet and live Stripe charges. After Fix 5/5 it requires `requireAdmin`. If you ever see a 401 on a charge, it's because the frontend interceptor failed to inject the Authorization header (check that `window.__hncStripeFetchPatched` is true after page load).
- **Direct API tests don't exercise the server-side duplicate guard (Layer 3).** The guard checks for existing invoice rows; direct API tests don't write those rows the way the UI does. Test the guard by inserting a synthetic paid invoice row first, then firing `charge_card` — should return 409.

## Cleaner Portal

The cleaner-facing portal lives at `hnc-crm.vercel.app/portal` (file: `portal.html`). This was built April 18-19 with Google sign-in, schedule view, upcoming jobs list, and Google Calendar sync. **It is the canonical cleaner portal.** Don't recreate it.

### Auth + cleaner-record linking
- Cleaner clicks "Sign in with Google" → Supabase OAuth.
- After OAuth bounce-back, `portal.html` calls `/api/portal/link-or-create` which connects the user's Supabase `user.id` to the cleaner record by writing it to `cleaners.auth_user_id` (a UUID column).
- On subsequent loads, `findCleaner(user)` looks up the cleaner by `auth_user_id`. If no cleaner is linked, the portal shows "No cleaner record linked."
- This is admin-email matching, not email-based auth — `cleaners.email` is contact info, NOT used for portal auth.

**The portal is invite-only by UI design.** The "Need an account? Sign up" toggle was removed in commit ca74b4a — the portal frontend has no path to call `supa.auth.signUp()` anymore. `mode` is permanently `'signin'` and the dead signup branch is unreachable. Anyone who somehow creates a Supabase account from another entry point still hits "No cleaner record linked" because they have no row in `cleaners`.

### Inviting a cleaner
1. Admin opens a cleaner profile in the CRM and clicks **Invite Cleaner**.
2. The button calls `POST /api/portal/send-invite` with the cleaner's id.
3. The endpoint looks up the cleaner's `phone`, sends an SMS via Quo (OpenPhone API):
   > "Hi {name}, you've been invited to your Hawaii Natural Clean cleaner portal. Sign in here: https://hnc-crm.vercel.app/portal"
4. The cleaner taps the link, signs in with their Google account, and `link-or-create` matches them to their cleaner row (typically by phone or email).

There is **no invite token, no cleaner_invites table, no redeem RPC**. The whole flow is: SMS the URL, Google sign-in handles the rest.

### Files
| Path | Purpose |
|---|---|
| `portal.html` | Cleaner portal frontend (Google sign-in + schedule UI + GCal sync) |
| `api/portal/link-or-create.js` | Links a Supabase user to a cleaner record on first sign-in |
| `api/portal/notify-admin.js` | Notifies admin when a cleaner self-registers |
| `api/portal/send-invite.js` | Admin-gated SMS invite (added 2026-04-30 in commit fb4ef4e) |
| `api/portal/send-otp.js`, `verify-otp.js` | Legacy phone-OTP login (kept for fallback; primary is Google) |

### Deprecated and removed (2026-04-30)
A parallel session built a duplicate cleaner portal at `/cleaner-portal` with a different auth model (`cleaners.auth_email` + `redeem_cleaner_invite` RPC + `cleaner_invites` table). It was removed when the duplication was discovered. Do not rebuild it.

Removed from repo:
- `cleaner-portal.html`
- `api/cleaner-portal/send-invite.js`, `api/cleaner-portal/redeem-invite.js`
- `supabase/add_cleaner_invites.sql`, `supabase/add_redeem_cleaner_invite_rpc.sql`
- `/cleaner-portal` rewrite in `vercel.json`

### DB cleanup completed
The Supabase database objects from the deleted stack were dropped on 2026-04-30:
```sql
DROP FUNCTION IF EXISTS public.redeem_cleaner_invite(text, text);
DROP TABLE IF EXISTS public.cleaner_invites;
ALTER TABLE public.cleaners DROP COLUMN IF EXISTS auth_email;
NOTIFY pgrst, 'reload schema';
```

### Mobile UX

`portal.html` has a mobile CSS pass: inputs at 16px (no iOS zoom on focus), buttons ≥52px tall and full-width on phones, safe-area insets for notches, stacked `.row` content, and reduced padding on cards. Two breakpoints (720px and 480px). Tested on iPhone-class viewports.

### Stale invite-status UI

The CRM previously rendered a "pending invite" status badge per cleaner via `refreshInviteStatus()`, which queried the dropped `cleaner_invites` table. The function was stubbed to a no-op that hides the `#cp-portal-status` element so the UI stays clean. Don't restore the original — there are no tokens to track in the new flow.

### Encoding hazard (lessons from 2026-04-30)

When editing files via the GitHub Contents API in a browser, do NOT use the naive `atob(content)` → modify → `btoa(unescape(encodeURIComponent(str)))` pattern: it double-encodes any non-ASCII character (em-dashes, smart quotes, emojis, accented letters) into mojibake. Use proper UTF-8 helpers instead:

```js
const decode = b64 => new TextDecoder('utf-8').decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), c => c.charCodeAt(0)));
const encode = str => {
  const bytes = new TextEncoder().encode(str);
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
```

Always run a round-trip sanity check (`decode(encode(str)) === str`) before pushing.


## Pending / On the Horizon

Outstanding work tracked across sessions. In rough priority order:

### OpenPhone webhook setup for lost-intent detection (this session)

The lost-intent detection feature (`4d2a4d5`) won't fire until the OpenPhone webhook is registered. One-time setup:

1. **Log into OpenPhone admin** → Settings → Developer (or Webhooks).
2. **Register webhook URL:** `https://hnc-crm.vercel.app/api/openphone-webhook`
3. **Subscribe to events:** at minimum `message.received`. Already-handled events for completeness: `call.completed`, `call.summary.completed`, `call.transcript.completed`.
4. **Verify `ANTHROPIC_API_KEY`** env var is set in Vercel (almost certainly already there since AI follow-up + summary depend on it). No new env var needed.
5. **Test by texting one of your numbers** that's a lead in the CRM. Should see a Comms log entry + (if reply looks lost-intent) a new "review_lead_response" task in the Tasks view with Yes/No buttons.

**Why webhook is needed:** without it, the existing `/api/openphone-webhook` endpoint sits there unused. OpenPhone won't push events to it until you tell them where to push.

### Lead form public launch (this session)

The lead form (`/lead-form.html`) is feature-complete and ready to put on the public website. Pre-launch checklist:

1. **Confirm hardcoded owner contact in `api/lead-capture.js`:** `OWNER_PHONE = '+18084685356'` (HNC business line), `OWNER_EMAIL = 'dane@hawaiinaturalclean.net'`.
2. **Toggle ON in the Automations view** before any public traffic:
   - `new_lead_owner_sms_enabled` — SMS alert to business line on every new lead
   - `new_lead_owner_email_enabled` — email alert to dane@hawaiinaturalclean.net
   - `auto_quote_enabled` — auto-quote SMS+email back to the customer + advances stage to Quoted
   - `janitorial_enabled` — janitorial walkthrough flow
   - `policy_first_booking_sms_enabled` — waiver SMS after booking (depends on the service-aware waiver work)
3. **Submit one test lead through the form with Dane's personal info** before going public. Verify: owner SMS+email land, lead appears in CRM with stage=New inquiry / segment=initial_sequence, customer gets quote SMS+email within seconds, stage flips to Quoted.
4. **Pipeline stage advance** (Quoted → Follow-up after 3 days) runs automatically via the daily 18:00 UTC `run-task-automations.js` cron. No toggle — pure DB write.
5. **`TASK_AUTOMATIONS_TEST_MODE = true`** at the top of `api/run-task-automations.js` still limits Day-1/Day-5 VA task creation to Dane's personal number. Flip to `false` to roll out VA tasks for real leads. Stage-advance step ignores this flag.

**Public URL options for posting on the website:**

- **Quick (Vercel default):** `https://hnc-crm.vercel.app/lead-form.html` works as-is. Also `https://hnc-crm.vercel.app/contact` already redirects to it (rewrite in `vercel.json`). Works today, no DNS work.
- **Recommended (custom subdomain):** add `book.hawaiinaturalclean.com` (or `.net`, whichever Dane's website domain is on) as a custom domain on the `hnc-crm` Vercel project, then add a CNAME at the DNS provider pointing to `cname.vercel-dns.com`. Vercel auto-provisions SSL. Form URL becomes `https://book.hawaiinaturalclean.com/contact`. Reads as a real business URL on a phone screen instead of a tech subdomain.

The form page is self-contained (own header, branding, success view), so a direct link from the website's "Get a quote" CTA is cleaner than an iframe embed. Iframes complicate mobile rendering and CSS scope.

### Waiver service-routing — needs live end-to-end test (still pending)
The full waiver-routing plumbing shipped earlier but Dane was too tired to test before turning automations on. Before flipping the kill-switch, run these checks in order:

1. **Confirm DB migration ran.** In Supabase SQL editor:
   ```sql
   SELECT key, jsonb_pretty(value) FROM settings WHERE key IN ('policy_items', 'service_checklists');
   ```
   `policy_items` should have 6 items including `p5` "Quote accuracy & on-arrival adjustment". `service_checklists` should have 4 services (regular/deep/moveout/airbnb) with the move-out intro starting "Our most thorough service, designed to meet landlord and property manager move-out standards…" If either is wrong/missing, run `supabase/add_service_checklists.sql` in the SQL editor.

2. **Test agree.html visually on mobile** — 4 URLs using Dane's client UUID, no token needed:
   - `https://hnc-crm.vercel.app/agree.html?c=b0e79508-7583-49af-a15a-2b854e72e8b2&svc=moveout`
   - `https://hnc-crm.vercel.app/agree.html?c=b0e79508-7583-49af-a15a-2b854e72e8b2&svc=deep` (auto-pairs with Regular)
   - `https://hnc-crm.vercel.app/agree.html?c=b0e79508-7583-49af-a15a-2b854e72e8b2&svc=regular`
   - `https://hnc-crm.vercel.app/agree.html?c=b0e79508-7583-49af-a15a-2b854e72e8b2&svc=airbnb`
   Expected: cards collapsed by default, move-out shows the consolidated "Move-out preparation requirements" policy checkbox, "Before we arrive" prep card hidden for moveout-only.

3. **Test book.html step 2** — needs a real booking token. Get tokens from existing leads:
   ```sql
   SELECT name, service, booking_token, created_at
   FROM leads WHERE booking_token IS NOT NULL ORDER BY created_at DESC LIMIT 20;
   ```
   Visit `https://hnc-crm.vercel.app/book.html?token=THE_TOKEN`. If no token exists for a service type, submit a fresh test lead through `lead-form.html` for that service. Step 2 should auto-show the right service's checklist + correct policies based on `LEAD.service`.

4. **Test the full SMS pipeline.** Submit a test lead through `lead-form.html` (with Dane's own phone), book through book.html, verify the policy SMS arrives with the right `?svc=` in the link. Repeat for at least move-out + one other service. Assumes `policy_first_booking_sms_enabled` automation is ON.

5. **Pristine tier photo on lead-form.html** is still a Pexels CDN URL (4800179). Swap when Dane has a real after-photo from a deep clean.

### Resend SMTP for Supabase Auth (in progress)
Supabase project's default mailer is rate-limited. Magic links to the VA (Leo) weren't being delivered. Fix in progress: configure custom SMTP in Supabase project Auth settings using Resend (host: `smtp.resend.com`, port: 465, username: `resend`, password: Resend API key, sender: `noreply@hawaiinaturalclean.com`). All fields filled in the SMTP config form except password — Dane to paste the Resend API key himself.

### Client profile additions (next slice)
- **Upcoming appointments** — replace the "Next job: Not scheduled" line with a list of all future scheduled appointments (mirror of Job History but filtered `date >= today`).
- Optional polish: "paid" badge in Job History (logic added but doesn't appear visually — may need a CSS color tweak).
- Decide whether `cl-mrr` should mean "rolling 30 days" (current) or "current calendar month".

### VA login & security ✅ COMPLETED 2026-04-30
See **Stripe Charge Security (defense-in-depth)** above. The 5-layer defense + admin allowlist + email denylist + revoke-user endpoint together address the VA security concerns that were originally tracked here. Specifically:
- VAs can no longer hit `/api/stripe-invoice` (requireAdmin allowlist blocks them with 403)
- A compromised account can be locked out instantly via `BLOCKED_EMAILS` in `auth-check.js`
- `/api/admin/revoke-user` permanently bans a Supabase auth user and signs out all their sessions

Original notes preserved below for context.

- Flip `TEST_MODE_DANE_ONLY = true → false` in 3 places once Dane confirms ready: `run-task-automations.js`, `run-job-completions.js`, `saveApptEdit` in `index.html` (~line 3650).
- Consider a `VA_EMAILS` allowlist (currently only `ADMIN_EMAILS` exists; non-admin users get the `hnc-va-user` class).
- Reporting page is hidden for VA via CSS only — devtools could reveal it. Consider also hiding Automations + Broadcasts.
- Visible toggle button to open the login overlay.

### Other queued items
- **V2: Auto-attach cleaner-submitted photos to client profiles.** When a cleaner sends MMS via OpenPhone during a job, AI matches sender phone → cleaner record → today's appointment → client record, and saves the photos to that client's profile gallery. Requires: cleaner-to-client active-appointment lookup, photo storage policy (Supabase bucket per client?), gallery UI in client detail panel. Cool feature, not blocking — current manual workflow (cleaner texts office, office handles) is fine at current volume. Revisit when cleaner volume crosses ~5/day or when client-history-by-photos becomes useful for upsell/retention.
- Native Automations Builder UI inside the CRM (visual "When → If → Do", with toggleable rules and run logs).
- Google Calendar one-directional sync (CRM pushes to cleaner calendars).
- Custom website lead capture form triggering automations.
- 3 duplicate Dane Kreisman client records to clean up.
- AI Broadcast: 2 stuck broadcasts ("We Miss You", "Easter / Spring") were neutralized to status='sent' in a prior session.
- Stripe live mode: there was an "Unknown action" error during invoicing; reproduce when next encountered.

---

## 2026-05-03 Session — Legacy pricing, paired cleaners, color-drift fix, quick-assign, edit override fixes

### Legacy price lock-in (commits a9f7be9, d3b2909, 3ed894e)

Problem: 519 clients, 0 with `flat_rate` set, 34 with property records but no rate. The CRM has been through multiple pricing-formula changes; most existing clients have legacy prices that don't match what `calcPrice` would compute today. Existing infrastructure (calcPrice short-circuiting on `prop.flatRate` or `client.flat_rate`) was already in place but had nothing feeding values in.

Solution: yellow hint banner on both the booking form and the appt edit form, anchored to the price preview. When a known returning client is picked, queries the most recent paid/completed appointment and offers a "Use this price" button. Click → flips the price-override + hours-override checkboxes to the past appointment's values. On save, persists `flatRate` + `durationHours` into the property's JSONB record (creates a new property from the booking address if none exists, or falls back to `clients.flat_rate`).

Both `populateLegacyPriceHint` (booking) and `populateEditLegacyPriceHint` (edit) follow the same pattern; the edit-side also de-dupes by address before appending property records and skips the appointment currently being edited.

**Critical gotcha — double-tax:** The override input field is treated as **pre-tax base** by calcPrice, which adds Hawaii GET (4.712%) on top. First version stored `total_price` (post-tax) into the override → double-tax (e.g., $87.72 → $91.85). Fixed by querying both `base_price` and `total_price`, displaying the post-tax total in the hint label, but populating the override input with the pre-tax base. For legacy rows missing `base_price`, back it out: `base = total / 1.04712`. Same fix applied to `persistLegacyPriceLockIn` so `property.flatRate` saves the pre-tax value.

### Paired cleaners feature (commits b68b473, 0b359b8)

Up to 3 cleaners can be assigned to one appointment ("tag-team mode"): they all work in parallel, halving the wall-clock time. Each cleaner gets paid for the full wall-clock duration at THEIR own hourly rate.

Migration: `migrations/2026-05-03-pair-cleaners-on-appointment.sql` adds `cleaner_id_2` / `cleaner_pay_2` / `cleaner_id_3` / `cleaner_pay_3` (all nullable) + partial indices on `cleaner_id_2/3` + a `CHECK` constraint enforcing `cleaner_id_3 IS NOT NULL → cleaner_id_2 IS NOT NULL → cleaner_id IS NOT NULL`. Solo jobs leave all three pair columns null — zero schema cost for the common case.

UI: "+ Pair with another cleaner" link below the primary cleaner dropdown in BOTH the booking form (`na-pair-row-2/3`) and the edit form (`edit-pair-row-2/3`). Each row is just a cleaner dropdown + remove (×) button. **No pay input field** — pay is auto-computed at save time via `calcCleanerPay(duration, name, service)` using each cleaner's own hourly rate from cleanerDB.

Initial implementation had per-row pay inputs and force-flipped the primary's `cleaner-pay-override-chk` to half-split the displayed pay. Both were confusing. Removed in commit 0b359b8 — the user just picks names, system does the math.

Wire-up touches: `dbSaveAppointment` accepts `cleanerName2/cleanerPay2/cleanerName3/cleanerPay3`, `saveNewAppt` (one-time + recurring batch) and `saveApptEdit` (single + 'all' series + tail-regen + `seriesFields` + `updatedAppt`) all read paired data from the form and persist. `_rebuildAppointmentsFromDB` resolves `cleaner_id_2/3` to display names via cleanerDB. Calendar shows " +1" / " +2" badges on month/week/day views; appt overlay has dedicated rows for paired cleaners + their individual pay.

**Known gap shipping at end of session**: paired hours splitting. User specified the model: "a 4 hour job should be split 2 hours for one cleaner, 2 for the other." That's the intended behaviour. Initial implementation left wall-clock duration to the user (they manually halve hours when pairing). Fix in this session: when pairing changes, auto-divide the displayed wall-clock duration evenly across paired cleaners. Each cleaner's pay then computes from `(total_duration / N) × their_rate`, not full duration. Search comments for "_pairedHoursMode = split" if revisiting.

**Pending in a follow-up**: cleaner portal needs to surface jobs where the cleaner is `cleaner_id_2` or `cleaner_id_3` (currently only filters by `cleaner_id`). Payroll period-totals query needs to sum `cleaner_pay_2` where `cleaner_id_2 = X` and `cleaner_pay_3` where `cleaner_id_3 = X`. Both touch separate code paths and warrant their own commits.

### Calendar color-drift architectural fix (commit 0621503)

Symptom: appointments rendering red despite having a cleaner assigned. Hit three times in this session — May 12 (Jan Kunst), Diana Mahoney May 27 (different cause: actually unassigned in DB), and the 754-row backfill from earlier.

Root cause: calendar color was keyed off the `status` field via inline ternaries duplicated in month-view (line 3607) and week/day view (`calLayoutAppts` line 3734). Multiple code paths update `cleaner_id` and `status` independently — `saveApptEdit`, `dbSaveAppointment` insert, automation 'assign' action, bulk imports, direct SQL, the cleaner-portal accept-job flow. Any drift between the two fields, calendar lies.

Fix: extracted `_apptColorClass(appt)` (multi-char for month) and `_apptColorChar(appt)` (single-char for week/day colorMap) helpers above CAL_COLORS. Both implement the SAME rule, with `cleaner_id` as source of truth:

  status === 'paid'      → green (terminal)
  status === 'completed' → yellow (terminal)
  status === 'cancelled' → gray (terminal)
  cleaner_id is set       → blue (active assignment)
  cleaner name resolves
    to non-'Unassigned'   → blue (in-memory fallback for freshly loaded pages
                                   where cleaner_id hasn't been backfilled)
  else                    → red (truly unassigned)

Both renderers now call the helpers — no duplicated logic, no risk of one diverging later.

**Lesson codified**: status field is for terminal lifecycle states only (paid/completed/cancelled). Active assignment status is derived from `cleaner_id` presence, period. When adding new states or new code paths that touch appointments, never key UI off the status field for assignment indication — always derive from cleaner_id.

### Tail-regen cleaner-key bug (commit 21e64a6)

`saveApptEdit`'s tail-regen path (creates future occurrences when "Edit all in series" forces a NEW series) was calling `dbSaveAppointment({cleaner: cleanerVal, status: 'unassigned'})`. But `dbSaveAppointment` reads `data.cleanerName` for the cleaner_id lookup, not `data.cleaner`. Result: every generated row had `cleaner_id=NULL` and a hardcoded `status='unassigned'` → 754 future recurring rows accumulated this way. 

Fix: pass `cleanerName: cleanerVal` and let `dbSaveAppointment` derive status from cleaner presence.

Production data backfill: 434 of the 754 broken rows had high-confidence cleaner inference (≥80% agreement on ≥2 same-client + same-day-of-week past completed/paid rows in the last 90 days). Backfilled with `cleaner_id` + `status='assigned'` via direct DB update. The remaining 320 had insufficient or inconsistent past data — left for user to assign manually via Edit > Edit all in series.

### Automation-engine status drift (commit 6ac7867)

Found during the May 12 diagnostic: automation engine's "assign cleaner" action only updated `cleaner_id`, never `status`. Code was `update({cleaner_id: cid})` — which left rows with cleaner attached but `status='unassigned'`, hence red on calendar.

Fix: `update({cleaner_id: cid, status: 'assigned'})` matching the dbSaveAppointment INSERT logic. 59 stale rows in production were cleaned up (forward drift) along with 5 ghost rows (backward drift: cleaner_id NULL but status='assigned'/'scheduled'). The architectural fix above means future drift won't be visually misleading even if it occurs in fields elsewhere.

### Duplicate Kelley remap (one-shot DB op, no commit)

User had two Kelley records in DB: inactive `f2046882-...` (created 2026-04-19) and active `ba2f0f8f-...` (created 2026-05-03). 52 future appointments still referenced the inactive record. Remapped to the active record via single SQL update. Past completed/paid Kelley rows left alone (correct for payroll history).

User's tab also had stale `cleanerDB` (104 entries when DB had 109) because the active Kelley was created mid-session — live-patched the in-memory copy too.

### Quick-assign button on appt overlay (commit a7fc4a5)

User: "Can you make an assign button when I click on an unassigned appointment?"

Blue "Assign cleaner" button at the top of the action grid in the appt overlay. Hidden by default; shown by `_openApptInner` only when the row has no `cleaner_id` AND no resolved cleaner name. Opens a small overlay (modeled after appt-dup-overlay) with client/date/time/service info + active-cleaners-only dropdown. `confirmApptAssign` updates BOTH `cleaner_id` AND `status='assigned'` in one DB write (lesson from May 12), auto-computes `cleaner_pay` if missing. Mirrors the change into apptData so the calendar re-renders blue immediately.

Doesn't replace Edit — that's still the path for changing an existing assignment, since reassignment carries more implications (payroll attribution, SMS, etc.).

### Edit form hours-override pre-check (commit 56212f7)

User: "I created Jan kunsts appointment and I overrided hours from 8 to 2. If I tried to edit job, the screen would go back to defaulting to the 8 hours even though we had overrided it to 2 hours."

`_openApptInner` had a smart pre-check for the **price**-override checkbox: if `savedTotal` differs from `calcTotal` by > $0.01, auto-check the override box. Hours-override never got the same treatment — the checkbox was unconditionally forced unchecked, so the form rendered the auto-computed hours, and saving silently reverted the user's saved override.

Fix: mirror the price-override pre-check exactly. Diff `savedDuration` against `_lastEditCalcHrs` (the auto-computed hours that calcEditPrice landed on). If they differ by > 0.01, auto-check the override box and call `calcEditPrice()` again to apply.

Must run AFTER the first `calcEditPrice()` in `_openApptInner` so `_lastEditCalcHrs` holds the AUTO value, not the override value.

### Pattern reminders (codified this session)

1. **Calendar color is derived from cleaner_id, not status.** Don't reintroduce status-keyed color logic anywhere. Use `_apptColorClass(a)` / `_apptColorChar(a)`.

2. **Any DB write that sets cleaner_id must also set status='assigned'.** Pair them in one update statement. Don't trust that status will catch up later — multiple consumers read both fields independently.

3. **Override input fields and stored flatRate values are pre-tax base.** Hawaii GET (4.712%) gets added on top by calcPrice. Never store `total_price` (post-tax) into either.

4. **dbSaveAppointment expects `cleanerName`, not `cleaner`.** Same property-name trap exists for `cleanerName2` / `cleanerName3`. When wiring new save paths (recurring tails, automation-driven inserts), match the function's signature exactly — don't infer.

5. **Series bulk updates exclude per-instance fields.** `status`, `paid_at`, `invoice_sent` are per-instance, not per-series. Only `cleaner`, `time`, `service`, `pricing`, etc. should propagate via the bulk UPDATE; status drives lifecycle and stays specific to each occurrence.

6. **Edit-form pre-checks must run AFTER initial calcEditPrice().** That's the only way the auto-computed value (in `_lastEditCalcHrs`, etc.) is set so we can diff against the saved value to decide whether to auto-check the override.

7. **In-memory state can lag DB by minutes.** When new cleaners/clients are added in another tab or via direct SQL, the user's open tab still has the stale data. For diagnostics, always cross-check the DB directly, then patch in-memory if needed.

---

## 2026-05-03 Session — Tipping feature, phase 1 (commit 481799a)

### What shipped

A first slice of the cleaner-tipping feature: **manual tip entry on the appointment overlay + automatic flow into the payroll table**. Phase 2 (client-driven Stripe-hosted tip page + webhook) is intentionally not built yet — it has its own auth model and surface area, and stacking it onto this commit would have made the change unreviewable.

**Migration:** `migrations/2026-05-03-add-tip-amount.sql` adds `tip_amount` (numeric, default 0, `CHECK >= 0`) to `appointments`. Single column, not per-cleaner — paired-cleaner allocation is computed at payroll-aggregation time (split evenly across `cleaner_id` + `cleaner_id_2` + `cleaner_id_3` whenever they're set). Solo jobs (the 99% case) get the full tip going to one cleaner with no extra storage.

**Frontend wiring:**

- `dbSaveAppointment` and `dbUpdateAppointment` both have `tip_amount` in their column whitelists. Any future save path that bypasses these helpers (automation-driven inserts, RPCs) must add it explicitly — there's no hidden default behavior.
- The in-memory mapping in `dbLoadAppointments` reads `a.tip_amount` into `tipAmount` (camelCase per the existing convention). Defaults to 0 when null so arithmetic in the frontend doesn't need null guards.
- Appointment overlay: new `#ai-tip-row` row anchored after the third-cleaner-pay row, with an `Add tip` / `Edit` button calling `editApptTip()`. The button label flips based on whether a tip already exists.
- `editApptTip()` lives next to `confirmApptAssign()`. Uses native `prompt()` (mobile-friendly, zero new HTML overlay) → validates non-negative + finite → writes `tip_amount` directly via `db.from('appointments').update({...}).eq('id', dbId)` → mirrors into `currentAppt.tipAmount` and `apptData[currentApptKey][i].tipAmount` → re-renders the overlay row inline → calls `renderPayroll()` if open. Toast on success/failure. Logs via `logActivity('appointment_tip_updated', ...)`.

**Payroll integration (the part the user asked about explicitly):**

- New "Tips" column on the payroll table, sitting between Gross and Bonus. Auto-populates from the appointments in the period — no manual entry on the payroll page itself.
- `renderPayroll()` accumulates `totals[cname].tips` per cleaner. For each appointment, `tipShare = tipAmount / nCleaners` where `nCleaners = 1 + (cleaner2 ? 1 : 0) + (cleaner3 ? 1 : 0)`. So a $30 tip on a paired-2 job credits $15 to each cleaner.
- Row Total now equals `pay + tips + bonus`. Period summary metric at the top of the view shows `(+$X tips, +$Y bonus)` parenthetical when either is non-zero.
- `showCleanerApptDetail()` (per-cleaner breakdown) gets a Tip column showing the cleaner's share for each job.
- `exportPayrollCSV()` adds Tips and Total columns to the export so the CSV matches what's on screen.
- `colspan` on the empty/loading state rows bumped from 8 → 11 to match the new header column count.

### Important notes for the next session

- **Migration must be run in Supabase before this commit's frontend works.** `dbSaveAppointment` / `dbUpdateAppointment` will start writing `tip_amount` immediately on this deploy; if the column doesn't exist Supabase will reject every appointment save with "column tip_amount does not exist". The migration is idempotent (`IF NOT EXISTS` + DO block for the constraint) so re-running is safe.
- **Tip allocation for paired jobs is even-split.** This was the simplest defensible default, but it's not always what the customer means. If a customer specifies "this is for Maria specifically" and there were two cleaners, currently both get half. Override path doesn't exist yet — if it becomes a real friction point, the fix is per-cleaner tip columns (`tip_amount_2`, `tip_amount_3`) with even-split as the fallback, paralleling how `cleaner_pay_2/3` work.
- **Phase 2 (client-facing Stripe tipping):** must not piggyback on `/api/stripe-invoice` — that endpoint is admin-gated by `requireAdmin` (Layer 5 of the Stripe defense-in-depth), and clients aren't on `ADMIN_EMAILS`. Build a separate `/api/create-tip-checkout.js` with token-based auth (e.g., HMAC of `appointment_id + expires_at` using a new `TIP_TOKEN_SECRET` env var), uses Stripe Checkout Sessions (not direct PaymentIntents — Checkout handles the hosted UI and retries cleanly), and lets the existing `stripe-webhook.js` handle `checkout.session.completed` to write the tip back to the appointment via `tip_amount`. The webhook is the source of truth for "did the tip clear"; the success redirect is unreliable on mobile. Idempotency on the webhook side — guard against double-writes if Stripe re-sends the event.

### Pattern codified

**New columns on appointments need updates in three places.** Future devs adding columns: `dbSaveAppointment` row builder, `dbUpdateAppointment` payload builder, AND the in-memory mapping in the appointments-load loop (search for `cleanerPay:a.cleaner_pay`). Missing any one of these silently drops the field at one of the layers — same trap as the lead-form 5-layer whitelist, just smaller. The CHECK constraint on the column catches it server-side as a 400, so the error is at least loud.

---

*Last updated: May 3, 2026 — Tipping feature phase 1 shipped (commit 481799a): tip_amount column on appointments, manual entry on appointment overlay via prompt(), automatic payroll integration (Tips column between Gross and Bonus, even-split across paired cleaners). Migration must be run in Supabase. Phase 2 (client-driven Stripe-hosted tip page + webhook) deferred — needs token-based auth, can't reuse admin-gated /api/stripe-invoice. Previous session notes preserved below.*

*Previous: May 2, 2026 — Two long sessions, ~30 commits. Major: AI follow-up button shipped (manual lead nurture, generates personalized SMS/email per lead, two-step preview-before-send), then evolved across the day with brand voice tuning (Aloha opener, "— Dane from Hawaii Natural Clean" sign-off, banned-phrase list, brand voice paragraph). Bulk multi-select on pipeline added so 46+ leads can be handled in minutes via parallel generate + preview gallery + send. Per-lead Comms log panel with full DB-backed timeline (lead_comms_log table). Per-lead `do_not_contact` toggle (cron-only, doesn't gate manual sends). All 5 user-defined automations disabled — system is in fully manual mode for lead outreach. 64 leads bulk-imported from March/April spreadsheet. AI prompt tuned through 6 iterations to fix: CRM-bot tone (Aloha rewrite), missing prices (SMS history detection + server-side regex scan), JSON-with-postamble parser failure (brace-depth tracker), past dates (today-date injection + ban), fabricated estimates (hasStructuredQuote evidence flag), creepy street addresses (city-only extraction). Backend bugs fixed: VERCEL_URL → BASE_URL routing (Vercel deployment-protection HTML response), Supabase silent UPDATE failures (.update doesn't throw, must check res.error), temporal dead zone in derived flag ordering. Scheduling: day-of-week shift for recurring series (Bobby Nikkhoo Friday→Thursday), duplicate-delete bug (Susanna DeSantos), halt-series cross-contamination, Google Places stuck dropdown. UX wins: parallelized startup (4 DB fetches simultaneous, pipeline renders 1-2s sooner), calendar defaults to current month + Today button, new-appt form starts blank, task undo + reopen + daily 8am Hawaii deadline SMS digest, SMS counter wording clarified. Lead form launch checklist documented at top of Pending. **Patterns codified**: Supabase ops must check `res.error`; never use VERCEL_URL for inter-function calls; use brace-depth parser for LLM JSON; destructive ops on appointments end with `_refreshAppointmentsFromDB` for DB-source-of-truth.*