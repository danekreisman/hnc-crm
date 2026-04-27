/**
 * Shared gate helper for system automations.
 *
 * Returns whether the given automation key is enabled in ai_booking_settings.
 * Defaults to FALSE if the row or column is missing — fail-closed: if we can't
 * confirm the user explicitly turned it on, we don't fire. This is the safe
 * posture given past incidents.
 *
 * Usage:
 *   import { isAutomationEnabled } from './utils/automation-gate.js';
 *   if (!(await isAutomationEnabled(db, 'review_sms_enabled'))) {
 *     return res.status(200).json({ skipped: 'automation_disabled' });
 *   }
 */

export async function isAutomationEnabled(db, key) {
  if (!db || !key) return false;
  try {
    const { data, error } = await db
      .from('ai_booking_settings')
      .select(key)
      .eq('id', 1)
      .maybeSingle();
    if (error) {
      console.warn('[automation-gate] read error for', key, error.message);
      return false; // fail-closed
    }
    if (!data) return false;
    return data[key] === true;
  } catch (err) {
    console.warn('[automation-gate] exception for', key, err.message);
    return false; // fail-closed
  }
}
