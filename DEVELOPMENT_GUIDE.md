# HNC CRM — Development Guide

This document is the source of truth for how to build new features without breaking what's already working.
Read it at the start of every session before touching any code.

---

## Current Architecture

**Hosting:** Vercel (auto-deploys from GitHub `danekreisman/hnc-crm`)
**Database:** Supabase (PostgreSQL)
**Frontend:** Single HTML file (`index.html`) with inline JS and CSS (~717KB, 9 script blocks)
**Backend:** Vercel serverless functions in `/api/`

**Active integrations:**
- Supabase — core database (all data lives here)
- Stripe — invoicing and card charging (`/api/stripe-invoice.js`)
- OpenPhone/Quo — SMS sending and webhook receiver (`/api/send-sms.js`, `/api/openphone-webhook.js`)
- Resend — transactional email (`/api/send-email.js`)
- Anthropic — AI summaries (`/api/ai-summary.js`)

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

### 2. Error Logging — `api/utils/error-logger.js`
**All errors must be logged to Supabase, not just console.error.**

```js
import { logError } from './utils/error-logger.js';

try {
  // your code
} catch (err) {
  await logError('your-filename', err, { any: 'context' });
  return res.status(500).json({ error: err.message });
}
```

### 3. Timeouts — `api/utils/with-timeout.js`
**Every call to an external API must have a timeout.**

```js
import { fetchWithTimeout, TIMEOUTS } from './utils/with-timeout.js';
const response = await fetchWithTimeout(url, options, TIMEOUTS.RESEND);
```

### 4. Atomic DB Operations — `api/utils/webhook-idempotency.js` + Supabase RPC
Multi-step DB writes must use a Supabase stored procedure (RPC). See `supabase/book_lead_atomic.sql`.

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

  const invalid = validateOrFail(req.body, SCHEMAS.yourSchema);
  if (invalid) return res.status(400).json(invalid);

  try {
    return res.status(200).json({ success: true });
  } catch (err) {
    await logError('your-endpoint', err, { ...req.body });
    return res.status(500).json({ error: err.message });
  }
}
```

---

## Frontend Logging (Activity Logs)

Appointment and client actions are logged to `activity_logs` via a post-load patch script injected before `</body>` in index.html. It wraps `cancelAppointment`, `saveApptEdit`, and `confirmCancelClient` with logActivity calls after a 1500ms DOMContentLoaded delay.

**CRITICAL: Never inject a logActivity helper block into API files.**
This caused `FUNCTION_INVOCATION_FAILED` crashes on lead-capture.js. The unicode box-drawing separator characters in the comment block corrupted the file. If you need activity logging in an API file, write an inline fetch to Supabase `/rest/v1/activity_logs` directly inside the handler — no helper block.

---

## Stripe Invoice Rules

- `stripe-invoice.js` uses `collection_method: 'send_invoice'` — it emails a link, never auto-charges
- `us_bank_account` was removed from `payment_method_types` (commit `3230f8d`) — ACH has a $1 minimum that breaks test invoices; card-only is safer
- Invoices are saved to the `invoices` table by the frontend success handler (not the API) after a successful `send_invoice` action returns `{ success: true, invoiceId }`
- The Sent—Unpaid tab only shows invoices with a non-null `stripe_invoice_id`

---

## Known Gotchas

- **Never inject logActivity helper blocks into API files** — causes FUNCTION_INVOCATION_FAILED. Use inline Supabase fetch instead.
- **`lead-capture.js` was restored from commit `cc9701e`** after a logActivity injection broke it. Current clean version is commit `9b5e80b`.
- **`send-email.js` clean version is commit `855b2b1`** (bb774fc in current). Has unicode dashes in original comments — these are fine; only injected ones crash.
- **React-controlled inputs in modals** (like the custom invoice amount field) don't respond to direct value assignment — must use `nativeInputValueSetter` or physical click+type. Automation tool bypasses React state; human typing works correctly.
- **`cancelAppointment` and `saveApptEdit`** are overridden at runtime by the post-load patch script. The HTML source has logActivity in both functions, but a runtime wrapper also wraps them — the wrapper is what actually fires.
- **stripe-invoice.js `send_invoice` action**: `finalized` variable holds the Stripe invoice object post-finalization. The DB save was removed from the API and moved to the frontend to avoid server-side failures.
- **Google Places autocomplete** was added and removed — broke address input. Don't reintroduce without careful testing.
- **`run-automations.js`** is not yet using `logError` — errors only go to console.
- **`lead-capture.js`** does not have an atomic transaction — if it fails midway you can get a lead with no SMS/email.
- **Context drift** between sessions is recurring. Always reference this document at the start.

---

## Fully Tested Features (April 2026)

| Feature | Status | Notes |
|---|---|---|
| Lead form (all 3 steps) | ✅ Working | Auto-quote fires on submit |
| Pipeline display | ✅ Working | Kanban + All leads views |
| Client portal | ✅ Working | Login, Upcoming, Invoices, Profile tabs |
| Appointment cancel logging | ✅ Working | Post-load patch on cancelAppointment |
| Appointment edit logging | ✅ Working | Post-load patch on saveApptEdit |
| Stripe invoice send | ✅ Working | send_invoice action, emails client link |
| Sent—Unpaid display | ✅ Working | Requires stripe_invoice_id in invoices table |
| Reminders toggle | ✅ Working | reminders_enabled in ai_booking_settings |
| Quo/OpenPhone connected | ✅ Working | Green status in CRM header |
| book.html | ✅ Working | Requires token from quote email (by design) |
| Activity logs page | ✅ Working | invoice_sent, appointment_cancelled, appointment_updated |

---

## Supabase Tables

| Table | Purpose |
|---|---|
| `webhook_events` | Tracks processed webhooks to prevent duplicates |
| `error_logs` | Central log of all API errors |
| `activity_logs` | Frontend activity log (invoice_sent, appointment_cancelled, etc.) |
| `leads` | Pipeline leads from lead form |
| `clients` | Active clients |
| `appointments` | All scheduled and completed appointments |
| `invoices` | Invoice records (linked to Stripe) |
| `ai_booking_settings` | Reminders toggle + other automation settings (id=1) |

## Supabase Functions

| Function | Purpose |
|---|---|
| `book_lead_atomic` | Atomically creates client + appointment + closes lead |

---

## Utilities Reference

| File | What it does |
|---|---|
| `api/utils/validate.js` | Schema-based request validation |
| `api/utils/error-logger.js` | Log errors to Supabase `error_logs` table |
| `api/utils/with-timeout.js` | Wrap fetch() calls with timeouts |
| `api/utils/webhook-idempotency.js` | Prevent duplicate webhook processing |

---

*Last updated: April 2026 — after full testing session (lead form, client portal, invoice flow, activity logging).*

---

## Automation Inventory (updated April 2026)

### System Automations (fire immediately on trigger)
| Automation | Trigger | What it does |
|---|---|---|
| New Lead — Auto Quote | lead.created | Email + SMS with quote price to client |
| Janitorial Lead — Walkthrough Request | lead.created (Janitorial) | Email + SMS requesting walkthrough |
| Appointment Cancelled — Client Email | appointment cancelled (frontend) | Branded cancellation email via send-email.js |
| Appointment Cancelled — Client SMS | appointment cancelled (frontend) | SMS to client confirming cancellation |
| Appointment Cancelled — Cleaner SMS | appointment cancelled (frontend) | SMS to assigned cleaner notifying of cancel |
| Booking Confirmation | lead books via book.html | Email confirmation via lead-book.js |

### Cron Automations (run on schedule)
| Automation | Schedule | What it does |
|---|---|---|
| Day-Before Reminders | Daily 6pm HST | SMS to client + assigned cleaner |
| Post-Clean Review Request | Via run-automations.js | SMS to client after appointment completed; sets review_requested_at |
| Lead Follow-up Sequences | Via run-automations.js | Day 3, Day 7, Month 1/3/6 nurture |
| Cancelled Win-back | Via run-automations.js | Day 14 gracious, Day 60 offer |

### Automation Logging
Every automation fired by run-automations.js now logs `action: 'automation_fired'` to `activity_logs` with the automation name and lead name. Visible in Logs → Activity tab.

### Post-clean review SMS
- Triggered by: run-automations.js cron check
- Finds: appointments with status='completed', date=today or yesterday, review_requested_at IS NULL
- Sends: SMS to client phone with Google review link
- Marks: sets review_requested_at on the appointment to prevent duplicates
- Google review URL used: https://g.page/r/hawaiinaturalclean (update if changed)

### Known gaps (not yet built)
- Welcome email to new active client
- Manual invoice overdue reminders are in run-invoice-reminders.js but not shown in Automations UI
