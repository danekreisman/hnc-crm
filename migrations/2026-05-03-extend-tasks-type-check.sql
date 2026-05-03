-- Update tasks_type_check constraint to include task types added since
-- the original schema was created.
--
-- Background: the original CHECK constraint allowed only:
--   ('invoice','call_lead','call_client','project','other')
--
-- New types added since then that need to be allowed:
--   - call_lead_reengagement: used by /api/run-task-automations.js for Day-5
--     re-engagement call tasks. Has been silently failing CHECK constraint
--     and being rejected at insert time. Webhook didn't check insert errors
--     so the failures were invisible.
--   - review_lead_response: used by /api/openphone-webhook.js when AI
--     classifies an inbound SMS as lost-intent. Same silent-failure pattern.
--
-- Run this in the Supabase SQL Editor.

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_type_check;

ALTER TABLE tasks ADD CONSTRAINT tasks_type_check
  CHECK (type IN (
    'invoice',
    'call_lead',
    'call_client',
    'call_lead_reengagement',
    'review_lead_response',
    'project',
    'other'
  ));
