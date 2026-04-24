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

Every new API endpoint must use all four of these.

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

Test only by:
1. Passing `testClientId` or `testEmail` in the body
2. Creating an isolated test record, firing, immediately deleting
3. Letting the cron fire naturally in production

**Always test on Dane Kreisman only:**
- Email: dane.kreisman@gmail.com
- Phone: (808) 269-7636
- Client ID: `b0e79508-7583-49af-a15a-2b854e72e8b2`

---

## Cron Schedule (vercel.json)

| Endpoint | UTC Schedule | Hawaii Time |
|---|---|---|
| `/api/run-automations` | `0 */6 * * *` | Every 6 hrs |
| `/api/update-segments` | `0 5 * * *` | 7pm HST |
| `/api/run-broadcasts` | `0 */6 * * *` | Every 6 hrs |
| `/api/send-reminders` | `0 4 * * *` | 6pm HST |
| `/api/run-job-completions` | `0 * * * *` | Hourly |
| `/api/run-invoice-reminders` | `0 5 * * *` | 7pm HST |
| `/api/run-policy-reminders` | `0 19 * * *` | 9am HST ✓ |
| `/api/run-review-requests` | `0 19 * * *` | 9am HST ✓ |
| `/api/run-task-automations` | `0 18 * * *` | 8am HST |

---

## Features Built (v1 — All Live)

### Booking Flow
- `api/lead-book.js` — atomically creates client + appointment + closes lead via `book_lead_atomic` RPC
- `policiesAgreed: true` required in booking schema
- Duplicate booking guard (409 if already Closed Won)

### Day-Before Appointment Reminders (`api/send-reminders.js`)
- Cron: daily 6pm HST
- Finds appointments for tomorrow → SMS to customer + assigned cleaner
- Checks `notification_prefs.day_before_reminder` before sending

### Auto-Mark Jobs Complete (`api/run-job-completions.js`)
- Cron: hourly
- Flips scheduled/assigned appointments where date+time+duration has passed → `completed`
- After marking complete: sends post-clean thank-you email (checks `post_clean_email` pref)
- After marking complete: checks if first-ever clean → creates "Call [Name] — first clean complete" VA task

### Invoice Overdue Reminders (`api/run-invoice-reminders.js`)
- Cron: daily 7pm HST
- Unpaid invoices older than 7 days → SMS with Stripe `hosted_invoice_url`
- Throttled via `invoices.last_reminder_at` (3-day cooldown)
- Checks `notification_prefs.invoice_reminder` before sending

### Policy Agreement Reminders (`api/run-policy-reminders.js`)
- Cron: daily **9am HST** (`0 19 * * *`)
- One-time SMS per client — guarded by `clients.policy_reminder_sent_at`
- Checks `notification_prefs.policy_reminder` before sending

### AI Review Requests (`api/run-review-requests.js`)
- Cron: daily **9am HST** (`0 19 * * *`)
- Finds appointments completed in last 7 days with `review_requested_at IS NULL`
- Safety guard: manual calls require `{ testClientId }` in body
- Claude sentiment check → sends Google review SMS if satisfied (confidence ≥ 0.7)
- Google Review URL in `settings` table key `google_review_url`
- Checks `notification_prefs.review_request` before sending

### Broadcast System (`api/send-broadcast.js`, `api/run-broadcasts.js`)
- 11 branded templates across Holidays, Seasonal, Evergreen categories
- `testEmail` param overrides full audience for safe testing

### OpenPhone History Utility (`api/utils/openphone-history.js`)
- Fetches up to 200 SMS + 25 call summaries from OpenPhone API by phone
- Used by: `run-review-requests.js`, `ai-personalize.js`, `ai-summary.js`

### VA Tasks System (`api/tasks.js`)
- `loadTasks()` uses `db.from('tasks')` directly (no Vercel API — avoids cold start)
- AI brief auto-generated for call_lead/call_client tasks via Claude Haiku + OpenPhone history
- Optimistic UI: delete instant, check-off with 5-second Undo toast

### Task Automations (`api/run-task-automations.js`)
- Cron: daily 8am HST
- Quote sent yesterday + not yet booked → "Call [Name] — quote follow-up" (high, AI brief)
- Duplicate guard: skips if open call_lead task already exists for that lead

### Per-Client Notification Toggles
- `clients.notification_prefs` JSONB column stores 6 keys (all default `true`):
  - `booking_confirmation`, `day_before_reminder`, `invoice_reminder`
  - `policy_reminder`, `post_clean_email`, `review_request`
- UI: "Notifications" section in client profile panel (between Properties and Notes)
- 6 toggle rows, saves immediately on change via `saveNotifPref(clientId, key, value)`
- Loads automatically when client profile opens via `loadNotifPrefs(id)`
- All 6 notification endpoints check prefs via `isNotifEnabled(db, clientId, key)` before sending
- Use this to silence commercial clients from getting residential-style automated messages

### Post-Clean Feedback Gate (`feedback.html`, `api/feedback.js`)
- Route: `/feedback?c={clientId}&a={apptId}`
- "It was great!" → Google review opens in **new tab** → rebooking CTA shown
- "Could be better" → text box → saves to `client_feedback` + creates VA task + rebooking CTA
- Rebooking CTA links to `/book.html?bt={token}` or falls back to `/contact`
- `api/feedback.js` GET `?action=booking_token&clientId=` returns booking token
- db must be initialized before the GET handler (not inside the POST block)

### Email Templates (`api/send-email.js`)
All emails use `renderBrandedEmail()`. Types:
- `booking_confirmation` — fires on every booking
- `thankyou` — post-clean with two feedback gate buttons
- `invoice` — invoice with Stripe pay link
- `reminder` — appointment reminder
- `receipt` — payment received
- `quote` — full quote breakdown with book CTA
- `lead_followup`, `invoice_reminder`, `reactivation`, `generic`

### Lead Form (`lead-form.html`, `/contact` route)
- Service address field in step 1 with Google Places autocomplete
- Uses `/api/places-autocomplete` proxy — NOT direct browser-side Maps JS
- Custom dropdown with keyboard nav (arrows, Enter, Escape)

### Google Places Proxy (`api/places-autocomplete.js`)
- Uses CommonJS (`module.exports`) — do NOT convert to ES Modules
- API key must have Application Restrictions = **None** in Google Cloud Console
- Website restrictions block Vercel serverless functions

### Settings (`api/settings.js`)
- GET `/api/settings?key=google_review_url`

---

## Vercel Routes (`vercel.json`)

```
/contact  → lead-form.html
/book     → book.html
/portal   → portal.html
/agree    → agree.html
/feedback → feedback.html
```

---

## Supabase Tables

| Table | Purpose |
|---|---|
| `webhook_events` | Tracks processed webhooks |
| `error_logs` | Central log of all API errors |
| `tasks` | VA tasks with type, priority, due_date, ai_brief, related_lead_id, related_client_id |
| `client_feedback` | Post-clean feedback: rating (positive/negative), message, appointment_id, client_id |
| `broadcasts` | Scheduled broadcast campaigns |
| `broadcast_sends` | Individual sends per broadcast |
| `messages` | Inbound SMS from OpenPhone webhooks |
| `call_transcripts` | Call summaries from OpenPhone webhooks |
| `settings` | Key-value config (google_review_url, etc.) |

### Key columns added to existing tables
```sql
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS policy_reminder_sent_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS notification_prefs JSONB DEFAULT '{}'::jsonb;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS review_requested_at TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
```

### SQL migrations in `/supabase/`
- `book_lead_atomic.sql` — ✅ run
- `add_client_feedback.sql` — ✅ run
- `add_notification_prefs.sql` — ✅ run

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

- **`db` vs `window.supabase`** — `db` is the initialized client in `index.html`. Never use `window.supabase`.
- **Bulk endpoints** must NEVER be called without a scoped test param. Test on Dane Kreisman only.
- **`places-autocomplete.js`** uses CommonJS. All other API files use ES Modules. Don't mix.
- **Google Places API key** must have Application Restrictions = None for server-side calls. Website restrictions block Vercel serverless.
- **`loading=async`** in Maps JS URL conflicts with callback pattern — do not use.
- **`feedback.js`** — db must be initialized before the GET handler, not inside POST block.
- **Task loading** — `loadNotifPrefs` and `loadTasks` must use `db.from()` directly, not Vercel API, to avoid cold start delay.
- **Notification toggles** — the `cl-notif-prefs` section must be inside `client-view` div (line ~1580+), not `appt-view`. Easy to accidentally insert in the wrong panel.
- **Toggle CSS** — using `position:absolute` children inside a flex label collapses parent to 0 height. Use `min-height` on row divs and `inline-flex` on labels.
- **Cron times** — policy reminders and review requests were previously set to 8pm/9pm HST by mistake. Both now correctly set to 9am HST (`0 19 * * *` UTC).
- **Policy reminders are one-time** — the cron runs daily but `policy_reminder_sent_at` prevents re-sending.
- **`run-automations.js`** — doesn't use `logError` yet, errors go to console only.
- **`lead-capture.js`** — lacks atomic transaction, partial failures possible.
- **Python heredoc `\'`** → bare `'` in output JS — use double quotes for strings with apostrophes.

---

## Pending Manual Steps

1. **Wayne Johnson unsubscribe cleanup:**
   ```sql
   UPDATE leads SET unsubscribed_at = NULL WHERE id = 'dad0671b-c992-47a7-bb52-100c019dcf63';
   ```
2. **Test client cleanup** — Dane Kreisman (test@gmail.com, id: `30a1cdce-a315-40bb-80fb-4ed5642c6559`) can be deleted

---

## V2 Roadmap

- **Email history in AI summaries** — Zoho Mail API (same pattern as `openphone-history.js`)
- **AI automations visual builder** — "When → If → Do" interface with run logs
- **Client portal rebooking** — `/portal` is cleaner-only today; add client-facing view with rebooking
- **Post-job photos** — cleaners upload photos after marking job complete
- **Feedback analytics** — `client_feedback` table is collecting data; build Reporting view
- **Moving season broadcast templates** — move-in/out cleans (May–July peak)
- **Client portal notification toggles** — let clients self-manage their own preferences

---

## Utilities Reference

| File | What it does |
|---|---|
| `api/utils/validate.js` | Schema-based request validation |
| `api/utils/error-logger.js` | Log errors to Supabase `error_logs` |
| `api/utils/with-timeout.js` | Wrap fetch() with timeouts |
| `api/utils/webhook-idempotency.js` | Prevent duplicate webhook processing |
| `api/utils/openphone-history.js` | Fetch SMS + call history from OpenPhone by phone number |

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
- [ ] Did you test on Dane Kreisman only — not real clients?

---

*Last updated: April 23, 2026 — v1 complete + notification toggles.*
