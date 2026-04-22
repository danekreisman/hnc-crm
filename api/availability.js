import { createClient } from '@supabase/supabase-js';
import { logError } from './utils/error-logger.js';

const TIME_SLOTS = [
  '8:00 AM','9:00 AM','10:00 AM','11:00 AM',
  '12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM'
];

// Normalise time strings to a comparable hour number (0-23)
function parseHour(t) {
  if (!t) return null;
  const s = String(t).trim().toLowerCase();
  // "8am" or "8:00 am" or "09:00"
  let m = s.match(/^(\d{1,2})\s*(am|pm)$/);
  if (m) {
    let h = parseInt(m[1]);
    if (m[2] === 'pm' && h !== 12) h += 12;
    if (m[2] === 'am' && h === 12) h = 0;
    return h;
  }
  m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (m) {
    let h = parseInt(m[1]);
    if (m[3] === 'pm' && h !== 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    return h;
  }
  m = s.match(/^(\d{1,2})$/);
  if (m) return parseInt(m[1]);
  return null;
}

function slotHour(slot) {
  // "8:00 AM" -> 8, "1:00 PM" -> 13
  const m = slot.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (!m) return null;
  let h = parseInt(m[1]);
  if (m[3] === 'PM' && h !== 12) h += 12;
  if (m[3] === 'AM' && h === 12) h = 0;
  return h;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const island = req.query.island || 'Oahu';
  const days   = parseInt(req.query.days || '60');

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  const today    = new Date();
  today.setHours(0, 0, 0, 0);
  const endDate  = new Date(today);
  endDate.setDate(today.getDate() + days);
  const todayStr = today.toISOString().slice(0, 10);
  const endStr   = endDate.toISOString().slice(0, 10);

  // ── 1. Active cleaners for this island ──────────────────────────────────
  try {
  const { data: cleaners } = await db
    .from('cleaners')
    .select('id, island')
    .eq('status', 'Active');

  const islandCleaners = (cleaners || []).filter(c =>
    !c.island || c.island === island || c.island === 'Both'
  );
  const cleanerIds     = islandCleaners.map(c => c.id);
  const totalCleaners  = cleanerIds.length;

  if (totalCleaners === 0) {
    // No cleaner data — return all dates available
    return res.status(200).json({ blocked_dates: [], busy_times: {}, total_cleaners: 0 });
  }

  // ── 2. Appointments in range for those cleaners ─────────────────────────
  const { data: appts } = await db
    .from('appointments')
    .select('date, time, duration_hours, cleaner_id')
    .in('cleaner_id', cleanerIds)
    .gte('date', todayStr)
    .lte('date', endStr)
    .not('status', 'in', '("cancelled","deleted","unassigned")');

  // ── 3. Build per-date structure ─────────────────────────────────────────
  // dateMap[date] = Set of cleaner_ids booked that day
  const dateMap = {};
  // slotMap[date][slot] = count of cleaners busy during that slot
  const slotMap = {};

  for (const a of (appts || [])) {
    const d = a.date;
    if (!dateMap[d]) dateMap[d] = new Set();
    dateMap[d].add(a.cleaner_id);

    // Mark which time slots this cleaner covers
    const startH  = parseHour(a.time);
    const durH    = parseFloat(a.duration_hours || 3); // default 3hr
    const endH    = startH !== null ? Math.ceil(startH + durH) : null;

    if (!slotMap[d]) slotMap[d] = {};
    for (const slot of TIME_SLOTS) {
      const slotH = slotHour(slot);
      if (slotH === null) continue;
      // Slot is busy if it overlaps with [startH, endH)
      const overlaps = startH !== null
        ? slotH >= startH && slotH < endH
        : false;
      if (overlaps) {
        if (!slotMap[d][slot]) slotMap[d][slot] = new Set();
        slotMap[d][slot].add(a.cleaner_id);
      }
    }
  }

  // ── 4. Determine blocked dates and unavailable slots ────────────────────
  const blocked_dates = [];
  const busy_times    = {}; // date -> array of fully-booked slot strings

  // Iterate every day in range
  const cur = new Date(today);
  while (cur <= endDate) {
    const ds = cur.toISOString().slice(0, 10);

    // Skip Sundays (day 0) — HNC doesn't work Sundays
    if (cur.getDay() === 0) {
      blocked_dates.push(ds);
      cur.setDate(cur.getDate() + 1);
      continue;
    }

    const bookedCleaners = dateMap[ds] ? dateMap[ds].size : 0;

    if (bookedCleaners >= totalCleaners) {
      // All cleaners booked — entire day is blocked
      blocked_dates.push(ds);
    } else if (slotMap[ds]) {
      // Partial — some slots unavailable
      const fullyBusy = TIME_SLOTS.filter(slot => {
        const busyForSlot = slotMap[ds][slot] ? slotMap[ds][slot].size : 0;
        return busyForSlot >= totalCleaners;
      });
      if (fullyBusy.length > 0) busy_times[ds] = fullyBusy;
    }

    cur.setDate(cur.getDate() + 1);
  }

  return res.status(200).json({
    blocked_dates,
    busy_times,
    total_cleaners: totalCleaners,
    island,
  });
  } catch (err) {
    await logError('availability', err, { island, days });
    return res.status(500).json({ error: 'Failed to fetch availability', detail: err.message });
  }
}
