/**
 * GET /api/get-checklists
 * Returns service checklists + before-arrival prep for the agree.html page.
 * Loads from settings.service_checklists; falls back to defaults if not configured.
 */

import { createClient } from '@supabase/supabase-js';
import { logError } from './utils/error-logger.js';

const DEFAULTS = {
  services: [
    {
      id: 'regular',
      label: 'Regular Cleaning',
      sections: [
        { heading: 'Kitchen', items: [
          'Counters, sinks, and stovetop wiped down',
          'Exterior of appliances (fridge, oven, microwave, dishwasher)',
          'Cabinet fronts spot-cleaned',
          'Floors swept and mopped',
          'Trash and recycling emptied'
        ]},
        { heading: 'Bathrooms', items: [
          'Toilets cleaned and sanitized inside and out (including behind toilet and base)',
          'Showers, tubs, and sinks scrubbed',
          'Mirrors and fixtures polished',
          'Counters wiped',
          'Floors swept and mopped'
        ]},
        { heading: 'Bedrooms & Living Areas', items: [
          'All accessible surfaces dusted',
          'Floors vacuumed (carpet) and mopped (hard surfaces)',
          'Beds made (sheets must be laid out — laundry not included; surcharge may apply if requested)',
          'Trash emptied',
          'General tidying of visible surfaces'
        ]},
        { heading: 'Throughout', items: [
          'Light switches and door handles wiped',
          'Visible cobwebs removed',
          'Mirrors and glass surfaces cleaned'
        ]}
      ],
      notIncluded: [
        'Inside oven, fridge, or cabinets (these are Deep Clean items)',
        'Carpet shampooing or steam cleaning',
        'Window interiors or exteriors',
        'Wall washing or repair (nail holes, scuffs)',
        'Biohazard cleanup (vomit, blood, feces, pet accidents)'
      ]
    },
    {
      id: 'deep',
      label: 'Deep Cleaning',
      intro: 'Includes everything in Regular Cleaning, plus:',
      sections: [
        { heading: 'Kitchen', items: [
          'Inside of microwave',
          'Inside of oven (if accessible)',
          'Inside of fridge (if requested and emptied)',
          'Cabinet exteriors detailed',
          'Backsplash scrubbed',
          'Range hood and filter degreased'
        ]},
        { heading: 'Bathrooms', items: [
          'Tile grout scrubbed',
          'Shower door tracks cleaned',
          'Exhaust fan covers wiped'
        ]},
        { heading: 'Throughout', items: [
          'Baseboards hand-wiped',
          'Door frames and trim wiped',
          'Window sills and tracks cleaned',
          'Interior windows (glass, sills, tracks)',
          'Ceiling fans dusted',
          'Vents and registers dusted',
          'Light fixtures dusted (accessible)',
          'Behind and under accessible furniture'
        ]}
      ],
      notIncluded: [
        'Carpet shampooing or steam cleaning (separate service)',
        'Exterior windows',
        'Post-construction cleanup (drywall dust, grout haze)',
        'Wall repair, painting, or hole patching',
        'Biohazard cleanup',
        'Pest treatment'
      ]
    },
    {
      id: 'moveout',
      label: 'Move-out Cleaning',
      intro: 'Designed to meet landlord and property manager standards. Includes everything in Deep Cleaning, plus:',
      required: [
        'All personal possessions must be removed from the property — including garage, lanai, storage closets, and outdoor areas. The unit must be completely empty.',
        'All trash and debris removed from the premises before our arrival (we are not a junk-haul service)',
        'Fridge and freezer fully defrosted and emptied (frozen-shut freezers cannot be cleaned)',
        'Utilities (water and electricity) must remain ON during the cleaning',
        'Oven and stovetop must be operational',
        'Any active pest infestations disclosed in advance'
      ],
      sections: [
        { heading: 'Kitchen', items: [
          'Inside all cabinets and drawers',
          'Inside oven (full degrease)',
          'Inside fridge and freezer',
          'Inside dishwasher',
          'Behind and under fridge and stove (if movable)'
        ]},
        { heading: 'Bathrooms', items: [
          'Inside all cabinets and drawers',
          'Inside medicine cabinets',
          'Soap scum and mineral deposits removed',
          'Caulk lines detailed'
        ]},
        { heading: 'Throughout', items: [
          'Inside all closets (empty)',
          'All baseboards, doors, and door frames',
          'Interior windows: sills, tracks, glass',
          'Exterior windows (only if reachable from ground without a ladder)',
          'Window screens removed and cleaned',
          'Exterior window frames where reachable',
          'Sliding door tracks',
          'Walls spot-cleaned for marks and scuffs',
          'Light fixtures detailed',
          'Floors deep-cleaned'
        ]}
      ],
      notIncluded: [
        'Wall hole patching, paint touch-ups, or any repair work',
        'Carpet shampooing or steam cleaning (separate service)',
        'Exterior pressure washing',
        'Post-construction debris cleanup',
        'Hazardous material disposal (paint, chemicals, sharps)',
        'Junk removal or hauling'
      ],
      footnote: 'If conditions on arrival do not meet the requirements above, we may need to reschedule and a trip fee will apply.'
    },
    {
      id: 'airbnb',
      label: 'Airbnb Turnover',
      sections: [
        { heading: 'Kitchen', items: [
          'Counters, sinks, stovetop, and exterior appliances wiped',
          'Dishes washed and put away',
          'Coffee maker and kettle reset',
          'Trash and recycling emptied and replaced'
        ]},
        { heading: 'Bathrooms', items: [
          'Toilets, showers, tubs, sinks cleaned and sanitized',
          'Mirrors and fixtures polished',
          'Fresh towels set out',
          'Toiletries restocked (if supplied)'
        ]},
        { heading: 'Bedrooms', items: [
          'Linens stripped and replaced with fresh set',
          'Beds made hotel-style',
          'Surfaces dusted and tidied',
          'Floors vacuumed/mopped'
        ]},
        { heading: 'Living Areas', items: [
          'Surfaces dusted, floors cleaned',
          'Pillows and throws arranged',
          'Remote controls and high-touch items sanitized'
        ]},
        { heading: 'Final walkthrough', items: [
          'Lights and AC reset',
          'Welcome items in place (if supplied)',
          'Photos sent if requested'
        ]}
      ],
      notIncluded: [
        'Inventory shopping (toilet paper, soap, etc — host must stock supplies on-site)',
        'Off-site linen laundering (we strip and replace with provided fresh sets)',
        'Property damage repairs (we photo-document and report only)',
        'Deep oven, fridge, or appliance cleaning between turnovers (recommend scheduled Deep Clean)'
      ]
    }
  ],
  beforeArrival: [
    'Tidy personal items off surfaces we\'ll be cleaning',
    'Do dishes or place them in the sink for us',
    'Secure pets in a safe area',
    'Confirm entry method (lockbox code, key location, in-person)',
    'Let us know about any fragile or special-care items'
  ]
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const db = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );

    const { data, error } = await db
      .from('settings')
      .select('value')
      .eq('key', 'service_checklists')
      .maybeSingle();

    if (error) {
      await logError('get-checklists', error, {});
      return res.status(200).json(DEFAULTS);
    }

    if (data && data.value) {
      return res.status(200).json(data.value);
    }
    return res.status(200).json(DEFAULTS);
  } catch (err) {
    await logError('get-checklists', err, {});
    return res.status(200).json(DEFAULTS);
  }
}
