# HNC CRM — Development Guide

This document is the source of truth for how to build new features without breaking what's already working.
Read it at the start of every session before touching any code.

---

## CRITICAL: Preventing Regressions in index.html

index.html is a single-file ~738KB app. Any tool (Claude Code or otherwise) MUST follow this sequence every time:

```bash
# 1. ALWAYS pull latest before any edit — non-negotiable
git -C ~/Documents/hnc-crm pull origin main

# 2. Make the surgical, scoped edit

# 3. Syntax check embedded scripts
node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');const re=/<script[^>]*>([\s\S]*?)<\/script>/gi;let m;while((m=re.exec(h))!==null){try{new Function(m[1]);}catch(e){console.error('SYNTAX ERROR:',e.message);process.exit(1);}}" index.html

# 4. Commit and push
cd ~/Documents/hnc-crm && git add index.html && git commit -m "description" && git push origin main
```

**Never edit from a stale local copy. Never push without pulling first. Never use git push --force.**

---

## Current Architecture

**Hosting:** Vercel (auto-deploys from GitHub `danekreisman/hnc-crm`)
**Database:** Supabase (PostgreSQL) — project ID: `hehfecnjmgsthxjxlvpz`
**Frontend:** Single HTML file (`index.html` ~738KB) with inline JS and CSS
**Backend:** Vercel serverless functions in `/api/`
**Live URL:** https://hnc-crm.vercel.app

**Active integrations:**
- Supabase — core database (all data lives here)
- Stripe — invoicing and card charging (`/api/stripe-invoice.js`)
- OpenPhone/Quo — SMS sending and webhook receiver (`/api/send-sms.js`, `/api/openphone-webhook.js`)
- Resend — transactional email (`/api/send-email.js`)
- Anthropic — AI summaries (`/api/ai-summary.js`)

---

## Index.html — Key Functions & Sections

### Pipeline
- `renderLeadsPipeline()` — renders pipeline cards. Price display uses `l.quoteTotal` if set, else `'$'+l.value`. Both correctly prefixed with `$`.
- `openLead()` — opens lead detail panel. Price display uses `d.quoteTotal` if set, else `'$'+d.value`.

### New Lead Form (overlay id="new-lead-overlay")
Fields: name, contact, phone, email, address, service type, est. monthly value (nl-value), property size (nl-sqft), bedrooms (nl-beds), bathrooms (nl-baths), condition (nl-condition), est. price (nl-est), lead source, stage, assigned to, next action, due date, notes.

- `nlCalcPrice()` — live pricing calculator. Fires on service/beds/baths/sqft/condition change.
  - Standard clean / Airbnb: beds + baths → hours = 0.75 + (beds×0.75) + (baths×0.5) → price = hours × $65 × 1.04712
  - Deep clean / Move-out: sqft + condition → hours = max(2, sqft/500 × condMult) → same rate
  - Janitorial / Commercial / Government: shows "Custom - based on walkthrough"
  - Condition multipliers: ≥9=1.0, ≥7=1.2, ≥5=1.4, else 1.8
- `nlServiceChange()` — resets nl-value and calls nlCalcPrice()
- `saveNewLead()` — reads nl-beds, nl-baths, nl-condition and saves to leads table

**KNOWN BUG (not fixed yet):** Pricing formula incorrect for deep clean. 1200sqft + condition 10 shows ~$163 but should be ~$513. Formula needs revisiting.
**KNOWN ISSUE:** Service type list has too many options. Should only be: Regular Cleaning, Deep Cleaning, Move Out Cleaning.

### Automations Section

#### System Automation Cards (renderAutoList)
8 hardcoded system automation cards defined as JS variables: systemCard, janitorialCard, reminderCard, cancelEmailCard, cancelClientSmsCard, cancelCleanerSmsCard, reviewSmsCard, bookingConfirmCard.

After renderAutoList runs, `patchSystemAutoCards()` (in patch script near </body>) restructures each card's DOM to match lead auto layout: **Toggle → ▶Test → Edit templates → Delete + AI personalization badge**.

Key config: `_SYSAUTO_MAP` object maps toggle IDs to edit/test/delete functions.

**If you touch renderAutoList, you MUST preserve the patchSystemAutoCards wrapper:**
```js
var _origRenderAutoList = renderAutoList;
renderAutoList = function() {
  var result = _origRenderAutoList.apply(this, arguments);
  setTimeout(patchSystemAutoCards, 50);
  return result;
};
```

#### System Automation Functions (in main script)
- `openSystemAutoEdit(type)` — opens the system-auto-edit-overlay with fields loaded from settings table. Types: ce, cs, cc, rs, bc, db
- `saveSystemAutoTemplate()` — saves template fields + AI personalization setting to settings table
- `testSystemAutoTemplate()` — sends test ONLY to Dane Kreisman (8082697636 / dane.kreisman@gmail.com). NEVER to real clients.
- `resetSystemAutoTemplate()` — clears custom template, restores default
- `openQuoteAutoEdit()`, `openJanitorialAutoEdit()` — separate overlays for auto quote and janitorial
- `openDayBeforeAutoEdit()`, `openCancelEmailAutoEdit()`, etc. — wrapper functions calling openSystemAutoEdit

#### System Automation Overlay
Element ID: `system-auto-edit-overlay` — generic panel used for all system automation template edits. Contains: sae-title, sae-fields, sae-ai-personalize, Save changes, Test (Dane only), Reset to default.

#### Lead Automations (renderLeadAutoList)
Loaded from `lead_automations` table. Each card has: Toggle → ▶Test → Edit → Delete + AI-personalized badge. Functions: `editLeadAuto(id)`, `deleteLeadAuto(id)`, `openAutoTest(id)`, `toggleLeadAuto(id, enabled)`.

#### Full Automation Inventory

**System (fire on event):**
| Automation | Trigger | Functions used |
|---|---|---|
| New Lead Auto Quote | lead.created | openQuoteAutoEdit, send-email + send-sms |
| Janitorial Walkthrough Request | lead.created (Janitorial) | openJanitorialAutoEdit, send-email + send-sms |
| Day-Before Reminders | Cron 6pm HST | openDayBeforeAutoEdit, send-sms client + cleaner |
| Appointment Cancelled — Client Email | appt cancelled | openCancelEmailAutoEdit, send-email |
| Appointment Cancelled — Client SMS | appt cancelled | openCancelClientSmsAutoEdit, send-sms |
| Appointment Cancelled — Cleaner SMS | appt cancelled | openCancelCleanerSmsAutoEdit, send-sms |
| Post-Clean Review Request | Cron daily (run-automations.js) | openReviewSmsAutoEdit, send-sms |
| Booking Confirmation Email | client books (lead-book.js) | openBookingConfirmAutoEdit, send-email |

**Lead (run-automations.js cron):**
Day 3 follow-up, Day 7 final, Nurture Month 1/3/6, One-time Day 30/60, Cancelled Day 14/60.

---

## API Files

### send-email.js
- Accepts `type` OR `subject` (not both required). Type-based emails set their own subject.
- Types: `booking_confirmation`, `cancellation`, plus custom subject/body.
- Validation: `if (!to || (!subject && !type))` — requires to + either subject or type.

### run-automations.js
- Runs lead automation sequences (follow-ups, nurture, win-back).
- Post-clean review SMS runs BEFORE the early return (so it always fires even with no lead automations).
- Logs `automation_fired` to activity_logs after each execution via `logActivity()`.
- Post-clean review: finds completed appointments from today/yesterday with review_requested_at IS NULL, sends SMS, sets review_requested_at.

### lead-capture.js
- Captures inbound leads from website form. Sends auto-quote SMS + email.
- Does NOT have atomic transaction (unlike lead-book.js). If it fails midway, lead exists but no SMS/email sent.

### lead-book.js
- Client booking confirmation. Uses `book_lead_atomic` RPC for atomic client + appointment creation.
- Sends booking confirmation email via send-email.js (type: booking_confirmation).

---

## The Foundation Utilities (use on every new API endpoint)

| File | What it does | When to use |
|---|---|---|
| `api/utils/validate.js` | Schema-based request validation | All endpoints — validate before touching DB |
| `api/utils/error-logger.js` | Log errors to Supabase error_logs | All catch blocks |
| `api/utils/with-timeout.js` | fetchWithTimeout() wrapper | All external API calls |
| `api/utils/webhook-idempotency.js` | Prevent duplicate webhook processing | All webhook handlers |

**Never use raw fetch() for external services. Always use fetchWithTimeout().**

---

## Supabase Tables

| Table | Key columns | Notes |
|---|---|---|
| leads | id, name, email, phone, service, beds, baths, sqft, condition, quote_total, stage, segment | beds/baths/condition added for pricing calculator |
| clients | id, name, email, phone | |
| appointments | id, client_id, date, status, review_requested_at | review_requested_at prevents duplicate review SMS |
| lead_automations | id, name, is_enabled, trigger_config, actions (JSONB) | actions[].ai_personalize = true for AI personalization |
| settings | key, value | Stores system auto templates, AI flags, hidden autos |
| activity_logs | action, description, metadata, created_at | automation_fired, appointment_cancelled, invoice_sent, etc. |
| error_logs | source, message, context | All API errors |
| webhook_events | | Idempotency for webhooks |

---

## Known Gotchas

- **Non-ASCII chars in JS** (unicode dashes ─, em dashes) crash Vercel serverless functions with FUNCTION_INVOCATION_FAILED. ASCII only in JS strings.
- **No ES module imports in Vercel functions** — use require() style or the existing import pattern already in each file.
- **nl-sqft field** appears multiple times in index.html (in form HTML and in JS strings). Replacements must target the correct occurrence.
- **renderAutoList is wrapped** by patchSystemAutoCards — preserve the wrapper on any edit.
- **Test only on Dane Kreisman** (phone: 8082697636, email: dane.kreisman@gmail.com). Never trigger sends to real clients during testing.
- **Google Places autocomplete** was added and removed — broke address input. Don't reintroduce.

---

## Known Bugs (do not fix yet — just be aware)

1. **Pricing calculator formula wrong** — Deep clean 1200sqft + condition 10 shows ~$163, should be ~$513 with tax. Formula needs rework.
2. **Service type list too long** — new lead form has 8 options, should only have: Regular Cleaning, Deep Cleaning, Move Out Cleaning.
3. **Pipeline raw JS in deal-val** — one card renders `'+(lead.value||'TBD')+'` as literal text (likely a TBD lead with no value set).

---

*Last updated: April 2026 — after automations UI consistency rebuild, pricing calculator, and pipeline $ fix.*
