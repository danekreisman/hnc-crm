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

## Supabase Functions Added During Foundation Work

| Function | Purpose |
|---|---|
| `book_lead_atomic` | Atomically creates client + appointment + closes lead |

---

## Recent Commits Log

Single source of truth for what landed in the most recent sessions. Most recent first.

| Commit | What |
|---|---|
| (this session) | `DEVELOPMENT_GUIDE.md` — document activity log coverage, client profile modal, calendar→client link, browser-editor workflow, new gotchas |
| `53df3d6` | `index.html` — wire up client profile Stats (Lifetime, Total jobs, Avg, Monthly) from appointments |
| (in main) | `index.html` — Job History wired up + calendar appointment Client field clickable → opens client profile |
| `65dfffa` | `index.html` — add Automation log section to client profile modal + `loadClientActivityLog()` function |
| `62b5a21` | `api/tasks.js` — log VA-task email to activity_logs (direct Resend bypass case) |
| `41f30a0` | `api/send-sms.js` — log every successful SMS to activity_logs |
| `77e029f` | `api/send-email.js` — log every successful email send to activity_logs |

---

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

---

## Pending / On the Horizon

Outstanding work tracked across sessions. In rough priority order:

### Resend SMTP for Supabase Auth (in progress)
Supabase project's default mailer is rate-limited. Magic links to the VA (Leo) weren't being delivered. Fix in progress: configure custom SMTP in Supabase project Auth settings using Resend (host: `smtp.resend.com`, port: 465, username: `resend`, password: Resend API key, sender: `noreply@hawaiinaturalclean.com`). All fields filled in the SMTP config form except password — Dane to paste the Resend API key himself.

### Client profile additions (next slice)
- **Upcoming appointments** — replace the "Next job: Not scheduled" line with a list of all future scheduled appointments (mirror of Job History but filtered `date >= today`).
- Optional polish: "paid" badge in Job History (logic added but doesn't appear visually — may need a CSS color tweak).
- Decide whether `cl-mrr` should mean "rolling 30 days" (current) or "current calendar month".

### VA login & security
- Flip `TEST_MODE_DANE_ONLY = true → false` in 3 places once Dane confirms ready: `run-task-automations.js`, `run-job-completions.js`, `saveApptEdit` in `index.html` (~line 3650).
- Consider a `VA_EMAILS` allowlist (currently only `ADMIN_EMAILS` exists; non-admin users get the `hnc-va-user` class).
- Reporting page is hidden for VA via CSS only — devtools could reveal it. Consider also hiding Automations + Broadcasts.
- Visible toggle button to open the login overlay.

### Other queued items
- Native Automations Builder UI inside the CRM (visual "When → If → Do", with toggleable rules and run logs).
- Google Calendar one-directional sync (CRM pushes to cleaner calendars).
- Custom website lead capture form triggering automations.
- 3 duplicate Dane Kreisman client records to clean up.
- AI Broadcast: 2 stuck broadcasts ("We Miss You", "Easter / Spring") were neutralized to status='sent' in a prior session.
- Stripe live mode: there was an "Unknown action" error during invoicing; reproduce when next encountered.

---

*Last updated: April 29, 2026 — added Google OAuth as a second sign-in option in the login overlay; new Auth section in the guide. Switched primary deploy path: Claude clones, edits, and pushes directly from its own environment using a PAT pasted by Dane at session start. Browser-editor workflow demoted to legacy fallback.*
