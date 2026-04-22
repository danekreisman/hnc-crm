# Lead Automation System - Deployment Guide

## What's Been Built

### Backend Infrastructure ✅
1. **Database Migration** (`supabase/migrations/004_automation_segments.sql`)
   - Adds `segment`, `response_count`, `last_responded_at`, `booking_count_6m` to leads table
   - Creates `lead_automation_state` table for multi-step sequences
   - Creates `lead_responses` table for tracking responses

2. **Execution Engine** (`api/run-automations.js`)
   - Runs every 6 hours via Vercel cron
   - Supports triggers: form_submission, lead_created, days_since_response, scheduled, booking_completed
   - Executes actions: SMS, email, segment_move, internal_notification
   - Logs all executions in `lead_automation_runs` table

3. **Segment Detection** (`api/update-segments.js`)
   - Runs daily at 5 AM UTC
   - Auto-moves leads between segments based on behavior

4. **Cron Jobs** (`vercel.json`)
   - `/api/run-automations` every 6 hours
   - `/api/update-segments` daily at 5 AM

### API Endpoints ✅
- `/api/save-automation.js` - Save new automations to `lead_automations` table
- `/api/seed-automations.js` - Seed the 4 pre-built automations
- `/api/run-automations.js` - Execute automations (cron)
- `/api/update-segments.js` - Detect and move leads (cron)

### Frontend UI ✅
- Updated automation builder with lead-specific triggers
- New functions: `loadLeadAutomations()`, `renderLeadAutoList()`, `leadAutoSave()`
- Template variables for leads: {firstName}, {service}, {address}, etc.
- Actions UI with delay support

### Webhook Updates ✅
- OpenPhone webhook now tracks lead responses
- Increments `response_count` and sets `last_responded_at`

---

## Deployment Steps

### Step 1: Deploy to Vercel (GitHub)

1. Push the code to GitHub:
   ```bash
   git push origin main
   ```
   This will auto-deploy to Vercel

2. Verify deployment at: https://hnc-crm.vercel.app

### Step 2: Apply Database Migrations

1. Go to Supabase dashboard: https://supabase.com/dashboard
2. Navigate to your project (Hawaii Natural Clean)
3. Go to **SQL Editor**
4. Copy the SQL from `supabase/migrations/004_automation_segments.sql`
5. Paste and execute in the SQL editor

### Step 3: Seed Pre-built Automations

Once deployed to Vercel, trigger the seed endpoint:

```bash
curl -X POST https://hnc-crm.vercel.app/api/seed-automations
```

Or open in browser:
```
https://hnc-crm.vercel.app/api/seed-automations
```

This will create 4 pre-built automations:
- Initial 3-day follow-up
- Nurture 30-day check-in
- Post-booking re-engagement
- Canceled customer win-back

### Step 4: Test the System

1. **Navigate to Automations view** in the CRM
2. **Click "+ New automation"**
3. **Create a test automation:**
   - Name: "Test SMS"
   - Trigger: "Form submission (new lead from website)"
   - Action: SMS → "Hi {firstName}, thanks for reaching out!"
   - Enable: Yes
   - Save

4. **Check Supabase** (`lead_automations` table) to verify it was saved

5. **Trigger a lead** → Submit a form at https://hnc-crm.vercel.app/lead-form.html

6. **Monitor execution:**
   - Wait 6 hours for the cron job to run, OR
   - Manually trigger: `curl -X POST https://hnc-crm.vercel.app/api/run-automations`

7. **Check logs:**
   - Vercel function logs show execution details
   - `lead_automation_runs` table shows what executed

---

## How It Works

### Lead Journey

```
Form Submission
  ↓
Lead created, segment = "new_lead"
  ↓
Cron runs /api/run-automations every 6 hours
  ↓
Executes "Initial sequence" automation
  → Sends SMS (already done in lead-capture.js)
  → Sends Email (already done)
  → Sets next action for day 3
  ↓
Lead doesn't respond → segment = "initial_sequence"
  ↓
Day 3 cron runs
  → Sends follow-up SMS (via automation)
  → Moves to "nurture" segment if still no response
  ↓
Lead responds to SMS → Webhook fires
  → Updates response_count++
  → Sets last_responded_at = now
  ↓
Next cron detects response
  → Moves to "hot_lead" segment
  → Stops further automations (manual follow-up needed)
```

### Automation Trigger Types

| Trigger | When | Config |
|---------|------|--------|
| `form_submission` | Lead submits web form | None |
| `lead_created` | Any new lead enters system | None |
| `days_since_response` | Lead hasn't responded for N days | `{days: 7}` |
| `scheduled` | Every day at specific time | `{time_of_day: "09:00"}` |
| `booking_completed` | After appointment finishes | `{hours_after: 24}` |

### Action Types

| Action | What It Does | Config |
|--------|-------------|--------|
| `sms` | Send text message | `{message: "...", delay_minutes: 0}` |
| `email` | Send email | `{subject: "...", message: "..."}` |
| `segment_move` | Move lead to new segment | `{new_segment: "nurture"}` |
| `internal_notification` | Alert team | `{message: "..."}` |

---

## Segments

- **new_lead** - Just created, automation pending
- **initial_sequence** - In 7-day follow-up sequence
- **hot_lead** - Responded or engaged, awaiting manual follow-up
- **converted** - Became a customer (booked)
- **lost** - Explicitly rejected
- **one_time** - Booked once, not rebooked in 90 days
- **reengagement** - In re-engagement sequence
- **winback** - Canceled customer, slow win-back sequence
- **blacklist** - Do not contact

---

## The 4 Pre-built Automations

### 1. Initial 3-day Follow-up
- **Trigger:** Lead hasn't responded for 3 days
- **Action:** Send SMS: "Hi {firstName}, still interested in {service}?"

### 2. Nurture 30-day Check-in
- **Trigger:** Scheduled, every Monday at 9 AM
- **Action:** Send SMS to leads in "nurture" segment

### 3. Post-booking Re-engagement
- **Trigger:** Booking completed
- **Action:** Send SMS after 72 hours, move to "one_time" segment

### 4. Canceled Customer Win-back
- **Trigger:** Scheduled, every Monday at 10 AM
- **Action:** Send SMS to canceled customers (disabled by default)

---

## Testing Checklist

- [ ] Code deployed to Vercel
- [ ] Database migrations applied in Supabase
- [ ] Seed automations created via `/api/seed-automations`
- [ ] Automations view loads and shows 4 pre-built automations
- [ ] Create new automation via UI
- [ ] Submit test lead form
- [ ] Verify lead record created with `segment="new_lead"`
- [ ] Manually trigger `/api/run-automations`
- [ ] Verify SMS/email sent (check logs)
- [ ] Verify `lead_automation_runs` table has records
- [ ] Test lead response tracking (SMS reply)
- [ ] Verify `response_count` incremented and `last_responded_at` updated
- [ ] Verify segment moved to "hot_lead"

---

## Monitoring

### Vercel Function Logs
1. Go to https://vercel.com/dashboard
2. Select "HNC-CRM" project
3. Click "Functions" tab
4. View logs for each API endpoint

### Supabase Tables
- `lead_automations` - all defined automations
- `lead_automation_runs` - execution history with status, errors, results
- `lead_responses` - when leads respond to automations
- `leads` - segment, response_count, last_responded_at tracking

### Database Queries

**Check automation executions:**
```sql
SELECT * FROM lead_automation_runs 
ORDER BY started_at DESC 
LIMIT 20;
```

**Check lead segments:**
```sql
SELECT id, name, phone, segment, response_count, last_responded_at 
FROM leads 
ORDER BY created_at DESC;
```

**Check active automations:**
```sql
SELECT id, name, trigger_type, is_enabled, created_at 
FROM lead_automations 
WHERE is_enabled = true;
```

---

## Troubleshooting

**Automations not running:**
- Check Vercel cron job status (vercel.json must be deployed)
- Check function logs for errors
- Verify `lead_automations` table has enabled automations
- Verify leads exist with correct segments

**SMS/Email not sending:**
- Check OpenPhone and Resend API keys are set
- Review `/api/send-sms` and `/api/send-email` logs
- Verify phone/email fields populated in lead record

**Response tracking not working:**
- Verify OpenPhone webhook is configured correctly
- Check `lead_responses` table for entries
- Verify `response_count` field exists in leads table

**Segments not updating:**
- Check `/api/update-segments` cron is running (daily at 5 AM UTC)
- Verify migration applied and `segment` field exists
- Check Supabase function logs

---

## Next Steps

1. **Deploy & Test** (see Deployment Steps above)
2. **Monitor** automations running and leads responding
3. **Iterate** - adjust message templates, timing, segments based on results
4. **Scale** - expand with more sophisticated conditions and actions
5. **Integrate** - connect to more channels (email, Slack, Google Calendar)

Good luck! 🚀
