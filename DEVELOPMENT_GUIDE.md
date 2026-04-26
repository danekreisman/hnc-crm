# HNC CRM — Development Guide

This document is the source of truth for how to build new features without breaking what's already working.
Read it at the start of every session before touching any code.

---

## Token-Efficient Editing Rules

### Do the work, don't write Claude Code prompts.

Dane uses Claude in two modes: chat (Claude in Chrome) and Claude Code (terminal). When Dane asks for a fix, default to executing it yourself via the Chrome extension — fetch index.html via the GitHub blob API, do surgical `str_replace`-style edits, sanity-check syntax, push via the Contents API, then test against the live site after the ~60s Vercel deploy. Loop until it works.

Only write a Claude Code prompt when Dane explicitly asks for one (because he wants to run it in his terminal). Don't generate prompts as a substitute for doing the work.

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

*Last updated: April 2026 — added token-efficient editing rules to prevent resume cycles.*
