# HNC CRM — Development Guide

This document is the source of truth for how to build new features without breaking what's already working.
Read it at the start of every session before touching any code.

---

## Current Architecture

**Hosting:** Vercel (auto-deploys from GitHub `danekreisman/hnc-crm`)
**Database:** Supabase (PostgreSQL)
**Frontend:** Single HTML file (`index.html`) with inline JS and CSS
**Backend:** Vercel serverless functions in `/api/`
**Live URL:** https://hnc-crm.vercel.app

**Active integrations:**
- Supabase — core database (all data lives here)
- Stripe — invoicing and card charging (`/api/stripe-invoice.js`)
- OpenPhone/Quo — SMS sending and webhook receiver (`/api/send-sms.js`, `/api/openphone-webhook.js`)
- Resend — transactional email (`/api/send-email.js`)
- Anthropic — AI summaries, personalization, sentiment (`/api/ai-summary.js`, `/api/ai-personalize.js`)
- Google Places — address autocomplete via proxy (`/api/places-autocomplete.js`)

---

## The Foundation (DO NOT SKIP THESE)

These four things were built specifically so new features don't corrupt data or fail silently.
Every new API endpoint must use them.

### 1. Validation — `api/utils/validate.js`
```js
import { validateOrFail, SCHEMAS } from './utils/validate.js';
const invalid = validateOrFail(req.body, SCHEMAS.leadCapture);
if (invalid) return res.status(400).json(invalid);
```

### 2. Error Logging — `api/utils/error-logger.js`
```js
import { logError } from './utils/error-logger.js';
await logError('your-filename', err, { any: 'context' });
```

### 3. Timeouts — `api/utils/with-timeout.js`
```js
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
const response = await fetchWithTimeout(url, options, TIMEOUTS.RESEND);
```

| Service | Constant | Duration |
|---|---|---|
| Supabase | `TIMEOUTS.SUPABASE` | 5s |
| Anthropic | `TIMEOUTS.ANTHROPIC` | 15s |
| Stripe | `TIMEOUTS.STRIPE` | 10s |
| OpenPhone | `TIMEOUTS.OPENPHONE` | 8s |
| Resend | `TIMEOUTS.RESEND` | 8s |

### 4. Atomic DB Operations
Multi-table writes must use Supabase RPC. See `supabase/book_lead_atomic.sql`.
Webhook handlers must use `api/utils/webhook-idempotency.js`.

---

## New Endpoint Template

```js
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
import { logError } from './utils/error-logger.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    // your work here
    return res.status(200).json({ success: true });
  } catch (err) {
    await logError('your-endpoint', err, { ...req.body });
    return res.status(500).json({ error: err.message });
  }
}
```

---

## Testing Rules — NEVER Break These

**NEVER run bulk-action endpoints against production data during testing.**

Endpoints that loop over real clients/appointments must ONLY be tested by:
1. Passing `testClientId` or `testEmail` in the body — restricts to that one record
2. Creating an isolated test record, firing the endpoint, immediately deleting it
3. Letting the cron fire naturally in production

**Endpoints with test mode guards:**
- `run-review-requests.js` — requires `{ testClientId }` for manual calls
- `send-broadcast.js` — requires `{ testEmail }` for manual calls

**Always test on Dane Kreisman only:**
- Name: Dane Kreisman
- Email: dane.kreisman@gmail.com
- Phone: (808) 269-7636
- Client ID: `b0e79508-7583-49af-a15a-2b854e72e8b2`

---

## Cron Schedule (vercel.json)

| Endpoint | Schedule | Hawaii Time |
|---|---|---|
| `/api/run-automations` | `0 */6 * * *` | Every 6 hours |
| `/api/update-segments` | `0 5 * * *` | 7pm HST daily |
| `/api/run-broadcasts` | `0 */6 * * *` | Every 6 hours |
| `/api/send-reminders` | `0 4 * * *` | 6pm HST daily |
| `/api/run-job-completions` | `0 * * * *` | Hourly |
| `/api/run-invoice-reminders` | `0 5 * * *` | 7pm HST daily |
| `/api/run-policy-reminders` | `0 6 * * *` | 8pm HST daily |
| `/api/run-review-requests` | `0 7 * * *` | 9pm HST daily |
| `/api/run-task-automations` | `0 18 * * *` | 8am HST daily |

---

## Features Built (v1 — All Live)

### Booking Flow
- `api/lead-book.js` — atomically creates client + appointment + closes lead via `book_lead_atomic` RPC
- `api/utils/validate.js` — `policiesAgreed: true` required in booking schema
- `book.html` — passes `policiesAgreed: true` in POST body
- Duplicate booking guard (409 if already Closed Won)
- ⚠️ **Manual step**: Re-run `supabase/book_lead_atomic.sql` in Supabase SQL Editor to apply segment fix

### Day-Before Appointment Reminders (`api/send-reminders.js`)
- Cron: daily 6pm HST
- Finds appointments for tomorrow (scheduled/assigned) → SMS to customer + assigned cleaner
- FK disambiguation: use `cleaners!cleaner_id`

### Auto-Mark Jobs Complete (`api/run-job-completions.js`)
- Cron: hourly
- Finds scheduled/assigned appointments where date+time+duration_hours has passed → flips to `completed`
- After marking complete: sends post-clean thank-you email with feedback gate
- After marking complete: checks if first-ever clean → creates "Call [Name] — first clean complete" VA task (high, due today)

### Invoice Overdue Reminders (`api/run-invoice-reminders.js`)
- Cron: daily 7pm HST
- Unpaid invoices older than 7 days → SMS with Stripe `hosted_invoice_url`
- Throttled via `invoices.last_reminder_at` (3-day cooldown)

### Policy Agreement Reminders (`api/run-policy-reminders.js`)
- Cron: daily 8pm HST
- Clients with `policies_agreed_at = NULL` + upcoming appointment → one-time SMS
- Guard: `clients.policy_reminder_sent_at` — never re-sends

### AI Review Requests (`api/run-review-requests.js`)
- Cron: daily 9pm HST
- Finds appointments completed in last 7 days with `review_requested_at IS NULL`
- **Safety guard**: manual calls require `{ testClientId }` — cron bypasses via `x-vercel-cron` header
- Pulls OpenPhone history → Claude sentiment check → sends Google review SMS if satisfied (confidence ≥ 0.7)
- Google Review URL stored in `settings` table key `google_review_url` (editable in Settings → Business)

### Broadcast System (`api/send-broadcast.js`, `api/run-broadcasts.js`)
- 11 branded templates across Holidays, Seasonal, Evergreen categories
- `testEmail` param overrides full audience for safe testing
- Cron: every 6 hours fires scheduled broadcasts

### OpenPhone History Utility (`api/utils/openphone-history.js`)
- Fetches up to 200 SMS + 25 call summaries from OpenPhone API by phone number
- Caches `phoneNumberId` per cold start
- Used by: `run-review-requests.js`, `ai-personalize.js`, `ai-summary.js`
- AI summary prompt: "factual only, no speculation about causes"
- `ai-summary.js`: max_tokens 600, accepts `clientPhone`, fetches OpenPhone history server-side

### VA Tasks System (`api/tasks.js`)
- GET `?status=open|completed` — list tasks (queries Supabase directly — no cold start)
- POST `action=create` — create task, auto-generates AI brief for call_lead/call_client tasks
- POST `action=complete` — marks done with timestamp
- POST `action=delete` — removes task
- AI brief pulls OpenPhone SMS + call history for lead/client via Claude Haiku
- Frontend: optimistic UI — delete instant, check-off instant with 5-second Undo toast
- `+ Add task` button wired via `handleTopCta()`
- `loadTasks()` uses `db.from('tasks')` directly (not Vercel API — avoids cold start)

### Task Automations (`api/run-task-automations.js`)
- Cron: daily 8am HST
- Quote sent yesterday + not yet booked → creates "Call [Name] — quote follow-up" (high, due today, AI brief)
- Duplicate guard: skips if open call_lead task already exists for that lead

### Post-Clean Feedback Gate (`feedback.html`, `api/feedback.js`)
- Route: `/feedback?c={clientId}&a={apptId}`
- Step 1: "How was your clean?" — two buttons
  - "It was great!" → Google review opens in **new tab** → "You're amazing!" screen + "Book your next clean" CTA
  - "Could be better" → text box → "Got it, mahalo!" screen + "Book your next clean" CTA
- Negative feedback: saves to `client_feedback` table + auto-creates high-priority `call_client` VA task with message in description
- Positive feedback: saves to `client_feedback` table
- Rebooking CTA: fetches `booking_token` from client record → links to `/book.html?bt={token}` or falls back to `/contact`
- `api/feedback.js` GET `?action=booking_token&clientId=` returns booking token
- db must be initialized before the GET handler (not inside POST block)

### Email Templates (`api/send-email.js`)
All emails use `renderBrandedEmail()` shell. Available types:
- `booking_confirmation` — fires on every booking: date, time, service, frequency, address, total, rush note
- `thankyou` — post-clean with two feedback gate buttons (fires from `run-job-completions.js`)
- `invoice` — invoice with Stripe pay link
- `reminder` — appointment reminder
- `receipt` — payment received
- `quote` — full quote breakdown with book CTA
- `lead_followup` — lead follow-up
- `invoice_reminder` — unpaid invoice nudge
- `reactivation` — win-back with offer
- `generic` — ad-hoc sends

### Lead Form (`lead-form.html`, `/contact` route)
- 3-step: contact info → property → details
- Service address field in step 1 with Google Places autocomplete
- Uses `/api/places-autocomplete` proxy (NOT direct Google Maps JS browser-side)
- Custom dropdown in vanilla JS — keyboard nav (arrows, Enter, Escape)
- Required field with validation

### Google Places Proxy (`api/places-autocomplete.js`)
- **Uses CommonJS (`module.exports`)** — not ES Modules. Don't convert.
- API key must have Application Restrictions = **None** in Google Cloud Console
  (website restrictions block Vercel serverless — server sends no Referer header)
- Passes `Referer` header in request as fallback

### Settings (`api/settings.js`)
- Simple GET: `/api/settings?key=google_review_url`
- Used by `feedback.html` to load current review URL dynamically

---

## Vercel Routes (`vercel.json`)

```json
{ "source": "/contact",  "destination": "/lead-form.html" }
{ "source": "/book",     "destination": "/book.html" }
{ "source": "/portal",   "destination": "/portal.html" }
{ "source": "/agree",    "destination": "/agree.html" }
{ "source": "/feedback", "destination": "/feedback.html" }
```

---

## Supabase Tables

| Table | Purpose |
|---|---|
| `webhook_events` | Tracks processed webhooks to prevent duplicates |
| `error_logs` | Central log of all API errors |
| `tasks` | VA tasks with type, priority, due_date, ai_brief, related_lead_id, related_client_id |
| `client_feedback` | Post-clean feedback: rating (positive/negative), message, appointment_id, client_id |
| `broadcasts` | Scheduled broadcast campaigns |
| `broadcast_sends` | Individual sends per broadcast |
| `messages` | Inbound SMS from OpenPhone webhooks (outbound not stored) |
| `call_transcripts` | Call summaries and transcripts from OpenPhone webhooks |
| `settings` | Key-value store for CRM config (google_review_url, etc.) |

### Key columns added to existing tables
```sql
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS policy_reminder_sent_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS review_requested_at TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
```

### SQL migrations in `/supabase/`
- `book_lead_atomic.sql` — ⚠️ re-run to apply segment fix (sets segment='booked' on close)
- `add_broadcasts.sql` — broadcasts + broadcast_sends tables
- `add_tasks.sql` — tasks table
- `add_review_requested.sql` — review_requested_at + updated_at on appointments
- `add_client_feedback.sql` — client_feedback table

---

## Supabase RPC Functions

| Function | Purpose |
|---|---|
| `book_lead_atomic` | Atomically creates client + appointment + closes lead, sets segment='booked' |

---

## Business Rules

- Client rate: $65/hr
- Cleaners: contractors paid weekly, ~$16–18/hr
- Hawaii GET tax: 4.712%
- Frequency discounts: Weekly=20%, Biweekly=15%, Monthly=10%
- OpenPhone env var: `QUO_API_KEY`

---

## Known Gotchas

- **Python heredoc `\'`** → bare `'` in output JS — breaks single-quoted strings. Use double quotes for strings containing apostrophes.
- **`window.supabase`** is the library; **`db`** is the initialized Supabase client in `index.html`.
- **Bulk endpoints** (run-review-requests, run-automations, etc.) must NEVER be called without a scoped test param. Always test on Dane Kreisman (`b0e79508-7583-49af-a15a-2b854e72e8b2`) only.
- **`places-autocomplete.js`** uses CommonJS (`module.exports`) — all other API files use ES Modules (`export default`). Don't mix.
- **Google Places API key** must have Application Restrictions = None for server-side proxy calls. Website restrictions block Vercel serverless functions which send no Referer header.
- **`loading=async`** in Maps JS URL conflicts with the callback pattern — do not use.
- **`feedback.js`** — db must be initialized before the GET handler check, not inside the POST try block.
- **Automation typing** (browser extension) doesn't trigger Google Places autocomplete listeners. Use the proxy approach for all address lookups.
- **`run-automations.js`** doesn't use `logError` yet — errors go to console only.
- **`lead-capture.js`** lacks atomic transaction — partial failures possible.
- **Task loading** — `loadTasks()` must use `db.from('tasks')` directly (not `/api/tasks`) to avoid Vercel cold start delay.
- **`display:none` + `display:flex`** in same style attr — flex wins, element always visible. Never combine them.
- **`confirm()` dialogs** block browser automation — avoid using them anywhere.

---

## Pending Manual Steps

1. **Re-run `book_lead_atomic.sql`** in Supabase SQL Editor (segment fix)
2. **Wayne Johnson unsubscribe cleanup:**
   ```sql
   UPDATE leads SET unsubscribed_at = NULL WHERE id = 'dad0671b-c992-47a7-bb52-100c019dcf63';
   ```
3. **Test client cleanup** — Dane Kreisman (test@gmail.com, id: `30a1cdce-a315-40bb-80fb-4ed5642c6559`) can be deleted

---

## V2 Roadmap

- **Email history in AI summaries** — Zoho Mail API (Dane uses Zoho, no Gmail switch needed). Same pattern as `openphone-history.js` — fetch by email address, format for Claude prompt.
- **AI automations visual builder** — "When → If → Do" interface with toggleable automations and run logs. Key SaaS differentiator.
- **Client portal rebooking** — `/portal` is currently cleaner-only. Add client-facing view with upcoming appointments, invoice history, "Request next clean" button.
- **Post-job photos (cleaner portal)** — cleaners upload photos + notes after marking job complete. Saves to appointment record, visible on client profile.
- **Feedback analytics** — `client_feedback` table is collecting data. Build a Reporting view for satisfaction rate, common complaints, trends.
- **Moving season / real estate broadcast templates** — move-in/move-out cleans (May–July peak), open house staging cleans.

---

## Utilities Reference

| File | What it does |
|---|---|
| `api/utils/validate.js` | Schema-based request validation |
| `api/utils/error-logger.js` | Log errors to Supabase `error_logs` table |
| `api/utils/with-timeout.js` | Wrap fetch() calls with timeouts |
| `api/utils/webhook-idempotency.js` | Prevent duplicate webhook processing |
| `api/utils/openphone-history.js` | Fetch SMS + call history from OpenPhone API by phone number |

---

## Before Pushing Any Code

- [ ] Does the new endpoint validate its inputs?
- [ ] Are all external API calls using `fetchWithTimeout()`?
- [ ] Are all errors caught and logged with `logError()`?
- [ ] If it writes to multiple tables, is it wrapped in a transaction?
- [ ] If it processes webhooks, is it checking for duplicates?
- [ ] Did you syntax-check JS with `node --check`?
- [ ] Did you test the happy path?
- [ ] Did you test the failure path?
- [ ] Did you test on Dane Kreisman only (not real clients)?

---

*Last updated: April 23, 2026 — after completing v1.*
