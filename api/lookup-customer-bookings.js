// /api/lookup-customer-bookings
//
// Public endpoint used by book.html when no token is present. Takes
// {email, phone}, looks up:
//   - Open active leads with quotes for this contact (by email OR phone)
//   - Existing client (by email OR phone) + their saved properties + most
//     recent paid appointment price for the price-lock-in
//
// Returns a normalized response that book.html turns into selectable cards.
// The actual booking submit happens through /api/submit-public-booking.

import { createClient } from '@supabase/supabase-js';
import { validateOrFail, SCHEMAS } from './utils/validate.js';
import { logError } from './utils/error-logger.js';

const db = () => createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Last-10-digits normalization — matches the openphone-webhook.js pattern
// for resilient phone matching across formats (with country code, hyphens,
// parens, spaces all map to the same key).
function last10(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

// Pull a value out of the freeform `notes` field (e.g. "Frequency: Weekly").
function parseNote(notes, pattern) {
  if (!notes) return null;
  const m = pattern.exec(notes);
  return m ? m[1].trim() : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const invalid = validateOrFail(req.body, SCHEMAS.publicBookingLookup);
  if (invalid) return res.status(400).json(invalid);

  const email = String(req.body.email || '').trim().toLowerCase();
  const phone10 = last10(req.body.phone);

  if (!email || !phone10) {
    return res.status(400).json({ error: 'Email and phone are both required' });
  }

  const supabase = db();

  try {
    // ── 1. Look up active leads with quotes ────────────────────────────────
    // Match by email OR phone (last 10). Filter out closed-won/closed-lost
    // and DNC. Keep ones with a quote_total set so the user has something
    // to pick. Limit small — we only need a handful for cards.
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: leadsByEmail } = await supabase
      .from('leads')
      .select('id,name,email,phone,address,service,sqft,quote_total,quote_data,notes,booking_token,stage,do_not_contact,created_at')
      .ilike('email', email)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(10);

    const { data: leadsByPhone } = await supabase
      .from('leads')
      .select('id,name,email,phone,address,service,sqft,quote_total,quote_data,notes,booking_token,stage,do_not_contact,created_at')
      .ilike('phone', '%' + phone10)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(10);

    // Merge + dedupe by id, then filter
    const seen = new Set();
    const allLeads = [...(leadsByEmail || []), ...(leadsByPhone || [])].filter((l) => {
      if (seen.has(l.id)) return false;
      seen.add(l.id);
      return true;
    });

    const activeQuotedLeads = allLeads
      .filter((l) => !l.do_not_contact)
      .filter((l) => l.stage !== 'Closed lost' && l.stage !== 'Closed won')
      .filter((l) => l.booking_token && Number(l.quote_total) > 0)
      .filter((l) => last10(l.phone) === phone10 || (l.email || '').toLowerCase() === email)
      .map((l) => {
        const q = l.quote_data || {};
        return {
          leadId:       l.id,
          bookingToken: l.booking_token,
          name:         l.name,
          email:        l.email,
          phone:        l.phone,
          address:      l.address,
          service:      l.service,
          sqft:         l.sqft,
          frequency:    parseNote(l.notes, /Frequency:\s*([^\n]+)/),
          beds:         parseNote(l.notes, /Beds:\s*(\S+)/),
          baths:        parseNote(l.notes, /Baths:\s*(\S+)/),
          condition:    parseNote(l.notes, /Condition:\s*(\d+)/),
          quoteTotal:   l.quote_total,
          quoteData:    q,
          createdAt:    l.created_at,
        };
      });

    // ── 2. Look up existing client ─────────────────────────────────────────
    const { data: clientsByEmail } = await supabase
      .from('clients')
      .select('id,name,email,phone,address,service,frequency,beds,baths,sqft,properties,created_at')
      .ilike('email', email)
      .limit(5);

    const { data: clientsByPhone } = await supabase
      .from('clients')
      .select('id,name,email,phone,address,service,frequency,beds,baths,sqft,properties,created_at')
      .ilike('phone', '%' + phone10)
      .limit(5);

    const cseen = new Set();
    const matchedClients = [...(clientsByEmail || []), ...(clientsByPhone || [])].filter((c) => {
      if (cseen.has(c.id)) return false;
      cseen.add(c.id);
      return last10(c.phone) === phone10 || (c.email || '').toLowerCase() === email;
    });

    // Pick the most recent matched client — there shouldn't typically be
    // multiple, but if there are we go with the freshest record.
    const client = matchedClients.length
      ? matchedClients.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
      : null;

    // ── 3. For matched client, fetch most recent paid/completed appt for
    //       the price-lock-in (returning customers see their normal price). ─
    let lastAppt = null;
    if (client) {
      const { data: appts } = await supabase
        .from('appointments')
        .select('id,date,service,frequency,address,beds,baths,sqft,base_price,discount,total_price,duration_hours,status')
        .eq('client_id', client.id)
        .in('status', ['paid', 'completed'])
        .order('date', { ascending: false })
        .limit(1);
      if (appts && appts.length) lastAppt = appts[0];
    }

    // ── 4. Build response ──────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      existingQuotes: activeQuotedLeads, // each card → redirect to /book.html?bt=<bookingToken>
      existingClient: client ? {
        id:        client.id,
        name:      client.name,
        email:     client.email,
        phone:     client.phone,
        address:   client.address,
        service:   client.service,
        frequency: client.frequency,
        beds:      client.beds,
        baths:     client.baths,
        sqft:      client.sqft,
        properties: Array.isArray(client.properties) ? client.properties : [],
        lastAppt: lastAppt ? {
          date:           lastAppt.date,
          service:        lastAppt.service,
          frequency:      lastAppt.frequency,
          address:        lastAppt.address,
          beds:           lastAppt.beds,
          baths:          lastAppt.baths,
          sqft:           lastAppt.sqft,
          basePrice:      lastAppt.base_price,
          discount:       lastAppt.discount,
          totalPrice:     lastAppt.total_price,
          durationHours:  lastAppt.duration_hours,
        } : null,
      } : null,
    });

  } catch (err) {
    await logError('lookup-customer-bookings', err, { email, phone10 });
    return res.status(500).json({ error: 'Lookup failed', detail: err.message });
  }
}
