# OpenPhone webhook setup

The CRM has a webhook endpoint at:

```
https://hnc-crm.vercel.app/api/openphone-webhook
```

This needs to be registered with OpenPhone so they ping it whenever you receive an SMS or finish a call. Without this registration, none of the inbound features work — the AI lost-detection tasks, the Comms-log inbound rows, the call summaries, none of it.

## What the webhook does

When OpenPhone pings the URL above:

- **Inbound SMS (`message.received`)** → writes to `messages` table, updates the lead's response counters, sends the SMS to Claude Haiku for intent classification. If Haiku says the lead is "lost" with medium or high confidence, a VA task is auto-created on the Tasks page that says *"<Lead> responded — mark as lost?"* with **Mark as lost** / **Not lost** buttons.
- **Call completed (`call.completed`)** → writes a row to `call_transcripts`.
- **Call summary ready (`call.summary.completed`)** → updates that row with the AI-generated summary.
- **Call transcript ready (`call.transcript.completed`)** → updates that row with the full dialogue.

Idempotency is handled — if OpenPhone retries a webhook delivery, the second hit is detected and skipped.

## One-time setup steps

### 1. Confirm the `ANTHROPIC_API_KEY` env var is set in Vercel

Without this, lost-intent classification is silently skipped (the rest of the webhook still works).

- Go to https://vercel.com/dashboard
- Open the `hnc-crm` project
- Settings → Environment Variables
- Confirm `ANTHROPIC_API_KEY` exists. If not, paste your Anthropic API key and save.

### 2. Register the webhook URL in OpenPhone

OpenPhone admin steps may have shifted slightly since these were written, but the gist is:

- Log in to OpenPhone admin (https://my.openphone.com or whichever subdomain you use)
- Go to **Settings** → **Integrations** → **Webhooks** (sometimes under "Developer")
- Click **Add webhook** (or similar)
- **URL**: `https://hnc-crm.vercel.app/api/openphone-webhook`
- **Events to subscribe to** — check ALL of these:
  - `message.received`
  - `call.completed`
  - `call.summary.completed`
  - `call.transcript.completed`
- Save

OpenPhone usually sends a test ping after registration. Watch for a `200 OK` response. If you see `404`, the URL has a typo. If you see `500`, check Vercel function logs.

### 3. Verify it's working

The simplest way to verify: text yourself or have someone text your OpenPhone number something like *"we ended up going with another company"*.

Within ~10 seconds you should see:

1. A new task on the Tasks page titled *"<Your name> responded — mark as lost?"* with the SMS quoted in the description.
2. The lead's `response_count` incremented and `last_responded_at` updated.

If nothing happens:

- Check Vercel function logs for `/api/openphone-webhook` to see if the ping arrived
- Confirm the inbound number matches a lead's `phone` (last 10 digits matched, country code stripped)
- Confirm `ANTHROPIC_API_KEY` is set and valid

## Where the lost-detection logic lives

- **Webhook handler** — `api/openphone-webhook.js`
- **Classifier function** — `classifyLeadResponse()` inside the same file. Calls Claude Haiku 4.5, 200 max tokens, costs about $0.001 per inbound SMS.
- **Task UI buttons** — `renderTaskCard()` in `index.html` checks for `t.type === 'review_lead_response'` and renders inline action buttons.
- **Click handlers** — `reviewTaskMarkLost(taskId, leadId)` and `reviewTaskNotLost(taskId)` near the top of the tasks JavaScript section in `index.html`.

## Tuning the classifier

If it's too aggressive (too many false-positive lost tasks):

- Open `api/openphone-webhook.js`
- Change `verdict.confidence !== 'low'` to `verdict.confidence === 'high'` — only acts on high-confidence lost detections.

If it's too conservative (missing obvious lost replies):

- Refine the prompt's "lost" example phrases inside `classifyLeadResponse()`.
- Check what reasoning Haiku is producing — that's logged at `console.log('[openphone-webhook] AI verdict for lead', lead.id, ':', JSON.stringify(verdict))`. Find the entry in Vercel logs and see what the model thought.

## Cost reference

At today's pricing, classification costs about $0.001 per inbound SMS. Even at 100 inbound replies per day that's $0.10/day. Not worth worrying about.
