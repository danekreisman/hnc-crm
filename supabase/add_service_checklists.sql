-- Migration: Add quote-adjustment policy + seed service checklists
-- Run once in the Supabase SQL editor.

-- 1. Update policy_items to include the new quote-accuracy policy.
--    Replaces the existing row entirely; if the row doesn't exist yet,
--    api/get-policies.js falls back to DEFAULT_POLICIES which already has these.
INSERT INTO settings (key, value)
VALUES (
  'policy_items',
  '{"policies":[
    {"id":"p1","title":"Cancellation policy","detail":"Please provide at least 24 hours notice to cancel or reschedule. Late cancellations may incur a fee."},
    {"id":"p2","title":"Home preparation","detail":"Please tidy clutter from surfaces, do dishes or put them away, and secure any pets before our team arrives."},
    {"id":"p3","title":"Property access","detail":"Please ensure we have access to your property at the scheduled time. You will be asked to provide entry instructions when booking."},
    {"id":"p4","title":"Payment terms","detail":"Payment is due on the day of service. We accept ACH bank transfer (free) and credit/debit card (3% processing fee)."},
    {"id":"p5","title":"Quote accuracy & on-arrival adjustment","detail":"Your quote was based on the property condition you described. If our team arrives and finds the condition is materially worse than described — heavier soil, mold, biohazard, hoarding, post-construction debris, or pet damage — we may adjust the price to reflect the actual scope of work. We will always show you photos and confirm the new quote with you before starting. You may then proceed at the revised price or cancel the appointment (a trip fee may apply). Customers who lock their quote in advance by sending photos of the space are exempt from this adjustment."},
    {"id":"p6","title":"I agree to the terms of service","detail":"By proceeding I authorise Hawaii Natural Clean to perform cleaning services and agree to all policies above."}
  ]}'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- 2. Seed service_checklists row.
--    api/get-checklists.js has the same content as DEFAULTS, but seeding the
--    row lets you edit checklist content from Supabase later without code change.
INSERT INTO settings (key, value)
VALUES (
  'service_checklists',
  '{
    "services": [
      {
        "id": "regular",
        "label": "Regular Cleaning",
        "sections": [
          {"heading":"Kitchen","items":["Counters, sinks, and stovetop wiped down","Exterior of appliances (fridge, oven, microwave, dishwasher)","Cabinet fronts spot-cleaned","Floors swept and mopped","Trash and recycling emptied"]},
          {"heading":"Bathrooms","items":["Toilets cleaned and sanitized inside and out (including behind toilet and base)","Showers, tubs, and sinks scrubbed","Mirrors and fixtures polished","Counters wiped","Floors swept and mopped"]},
          {"heading":"Bedrooms & Living Areas","items":["All accessible surfaces dusted","Floors vacuumed (carpet) and mopped (hard surfaces)","Beds made (sheets must be laid out — laundry not included; surcharge may apply if requested)","Trash emptied","General tidying of visible surfaces"]},
          {"heading":"Throughout","items":["Light switches and door handles wiped","Visible cobwebs removed","Mirrors and glass surfaces cleaned"]}
        ]
      },
      {
        "id": "deep",
        "label": "Deep Cleaning",
        "intro": "Includes everything in Regular Cleaning, plus:",
        "sections": [
          {"heading":"Kitchen","items":["Inside of microwave","Inside of oven (if accessible)","Inside of fridge (if requested and emptied)","Cabinet exteriors detailed","Backsplash scrubbed","Range hood and filter degreased"]},
          {"heading":"Bathrooms","items":["Tile grout scrubbed","Shower door tracks cleaned","Exhaust fan covers wiped"]},
          {"heading":"Throughout","items":["Baseboards hand-wiped","Door frames and trim wiped","Window sills and tracks cleaned","Interior windows (glass, sills, tracks)","Ceiling fans dusted","Vents and registers dusted","Light fixtures dusted (accessible)","Behind and under accessible furniture"]}
        ]
      },
      {
        "id": "moveout",
        "label": "Move-out Cleaning",
        "intro": "Designed to meet landlord and property manager standards. Includes everything in Deep Cleaning, plus:",
        "sections": [
          {"heading":"Kitchen","items":["Inside all cabinets and drawers","Inside oven (full degrease)","Inside fridge and freezer","Inside dishwasher","Behind and under fridge and stove (if movable)"]},
          {"heading":"Bathrooms","items":["Inside all cabinets and drawers","Inside medicine cabinets","Soap scum and mineral deposits removed","Caulk lines detailed"]},
          {"heading":"Throughout","items":["Inside all closets (empty)","All baseboards, doors, and door frames","Interior windows: sills, tracks, glass","Exterior windows (only if reachable from ground without a ladder)","Window screens removed and cleaned","Exterior window frames where reachable","Sliding door tracks","Walls spot-cleaned for marks and scuffs","Light fixtures detailed","Floors deep-cleaned"]}
        ],
        "footnote": "Property must be fully empty for move-out service. Any remaining items will need to be removed before cleaning begins."
      },
      {
        "id": "airbnb",
        "label": "Airbnb Turnover",
        "sections": [
          {"heading":"Kitchen","items":["Counters, sinks, stovetop, and exterior appliances wiped","Dishes washed and put away","Coffee maker and kettle reset","Trash and recycling emptied and replaced"]},
          {"heading":"Bathrooms","items":["Toilets, showers, tubs, sinks cleaned and sanitized","Mirrors and fixtures polished","Fresh towels set out","Toiletries restocked (if supplied)"]},
          {"heading":"Bedrooms","items":["Linens stripped and replaced with fresh set","Beds made hotel-style","Surfaces dusted and tidied","Floors vacuumed/mopped"]},
          {"heading":"Living Areas","items":["Surfaces dusted, floors cleaned","Pillows and throws arranged","Remote controls and high-touch items sanitized"]},
          {"heading":"Final walkthrough","items":["Lights and AC reset","Welcome items in place (if supplied)","Photos sent if requested"]}
        ]
      }
    ],
    "beforeArrival": [
      "Tidy personal items off surfaces we will be cleaning",
      "Do dishes or place them in the sink for us",
      "Secure pets in a safe area",
      "Confirm entry method (lockbox code, key location, in-person)",
      "Let us know about any fragile or special-care items"
    ]
  }'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
