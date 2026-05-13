import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { serviceType, beds, baths, sqft, condition, frequency } = req.body;

  if (serviceType === 'Janitorial Cleaning' || serviceType === 'Airbnb Turnover') {
    return res.status(200).json({
      custom_quote: true,
      total: null,
      message: 'Custom quote required — contact for pricing'
    });
  }

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    if (serviceType === 'Regular Cleaning') {
      if (!beds || !baths) {
        return res.status(400).json({ error: 'Beds and baths required for Regular Cleaning' });
      }
      const bedsInt = parseInt(beds);
      const bathsNum = parseFloat(baths);

      const { data: bedRows } = await db.from('pricing_regular_bedrooms').select('*');
      const bedTier = bedRows.find(r => bedsInt >= r.bedroom_min && bedsInt <= r.bedroom_max);
      if (!bedTier) return res.status(400).json({ error: 'No bedroom tier for ' + beds + ' bedrooms' });

      const { data: bathRows } = await db.from('pricing_regular_bathrooms').select('*');
      const bathTier = bathRows.find(r => parseFloat(r.bathroom_count) === bathsNum);
      if (!bathTier) return res.status(400).json({ error: 'No bathroom tier for ' + baths + ' baths' });

      const subtotal = Number(bedTier.price) + Number(bathTier.price);
      const duration = bedTier.duration_minutes + bathTier.duration_minutes;

      let discount_pct = 0;
      if (frequency) {
        // Case-insensitive match — frequency strings can come from a select
        // ('Biweekly') or a free-text field on a returning customer's record
        // ('biweekly', 'Bi-Weekly', etc.). ilike handles all of those.
        // Also: capture .error and log it. The previous version only
        // destructured `data` and would silently fall through to 0% discount
        // on any transient Supabase error, which is the bug that hid 15% off
        // a Biweekly Regular Cleaning booking on May 7.
        const { data: freqRow, error: freqErr } = await db
          .from('pricing_frequency_discount')
          .select('*')
          .ilike('frequency', frequency.trim())
          .maybeSingle();
        if (freqErr) {
          console.error('[calculate-quote] frequency lookup failed:', freqErr.message, '— frequency was:', frequency);
        } else if (freqRow) {
          discount_pct = Number(freqRow.discount_pct);
        } else {
          console.warn('[calculate-quote] no pricing row for frequency=' + JSON.stringify(frequency));
        }
      }

      const discount = +(subtotal * (discount_pct / 100)).toFixed(2);
      const total = +(subtotal - discount).toFixed(2);

      return res.status(200).json({
        custom_quote: false,
        service: serviceType,
        subtotal: +subtotal.toFixed(2),
        discount,
        discount_pct,
        total,
        duration_minutes: duration,
        breakdown: {
          bedrooms: { tier: bedTier.label, price: +bedTier.price },
          bathrooms: { tier: bathTier.label, price: +bathTier.price },
          frequency: frequency || null
        }
      });
    }

    if (serviceType === 'Deep Cleaning' || serviceType === 'Move-out Cleaning') {
      if (!sqft) {
        return res.status(400).json({ error: 'Square footage required for Deep Clean / Move-out' });
      }
      const sqftInt = parseInt(sqft);
      const cond = condition ? parseInt(condition) : 5;

      const { data: sqftRows } = await db.from('pricing_sqft').select('*');
      const sqftTier = sqftRows.find(r => sqftInt >= r.sqft_min && sqftInt <= r.sqft_max);
      if (!sqftTier) return res.status(400).json({ error: 'No sqft tier for ' + sqft + ' sq ft' });

      const { data: condRows } = await db.from('pricing_condition').select('*');
      const condTier = condRows.find(r => cond >= r.score_min && cond <= r.score_max);
      if (!condTier) return res.status(400).json({ error: 'No condition tier for score ' + cond });

      const subtotal = Number(sqftTier.price) + Number(condTier.surcharge);
      const duration = sqftTier.duration_minutes + condTier.duration_minutes;
      const total = +subtotal.toFixed(2);

      // Hourly-range pricing for Deep + Move-out (2026-05-13):
      // Low end = current flat-rate implicit hours (total ÷ $70/hr, rounded).
      // High end = ceil(raw × multiplier). Default multiplier 1.6 (Dane: "5 → 5-8").
      // Both clamped to a minimum (default 3 hrs). Multiplier and min are tunable
      // via settings rows; defaults kick in if those rows don't exist.
      let multiplier = 1.6;
      let minHours = 3;
      try {
        const [mRow, hRow] = await Promise.all([
          db.from('settings').select('value').eq('key','hourly_range_multiplier').maybeSingle(),
          db.from('settings').select('value').eq('key','hourly_range_min_hours').maybeSingle(),
        ]);
        if (mRow.data?.value != null) {
          const v = parseFloat(mRow.data.value);
          if (Number.isFinite(v) && v > 1) multiplier = v;
        }
        if (hRow.data?.value != null) {
          const v = parseInt(hRow.data.value);
          if (Number.isFinite(v) && v > 0) minHours = v;
        }
      } catch (e) { console.warn('[calculate-quote] hourly-range settings load failed:', e.message); }

      const HOURLY_RATE = 70;
      const rawHours = total / HOURLY_RATE;
      const rangeLowHours  = Math.max(minHours, Math.round(rawHours));
      const rangeHighHours = Math.max(rangeLowHours, Math.ceil(rawHours * multiplier));

      return res.status(200).json({
        custom_quote: false,
        is_hourly_range: true,
        service: serviceType,
        subtotal: +subtotal.toFixed(2),
        discount: 0,
        discount_pct: 0,
        total,
        duration_minutes: duration,
        hourly_rate: HOURLY_RATE,
        range_low_hours:   rangeLowHours,
        range_high_hours:  rangeHighHours,
        range_low_dollar:  rangeLowHours  * HOURLY_RATE,
        range_high_dollar: rangeHighHours * HOURLY_RATE,
        breakdown: {
          sqft: { tier: sqftTier.label, price: +sqftTier.price },
          condition: { tier: condTier.label, surcharge: +condTier.surcharge, score: cond }
        }
      });
    }

    return res.status(400).json({ error: 'Unknown service type: ' + serviceType });
  } catch (err) {
    console.error('[calculate-quote]', err);
    return res.status(500).json({ error: 'Failed to calculate quote', detail: err.message });
  }
}
