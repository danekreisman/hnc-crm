-- book_lead_atomic
-- Atomically: find/create client + create appointment + close lead
-- If ANY step fails, ALL changes are rolled back (PostgreSQL transaction)
-- Run this in Supabase → SQL Editor

CREATE OR REPLACE FUNCTION book_lead_atomic(
  p_lead_id          UUID,
  p_client_data      JSONB,
  p_appointment_data JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_client_id      UUID;
  v_appointment_id UUID;
BEGIN

  -- ── 1. Find existing client by email OR create new one ────────────────
  SELECT id INTO v_client_id
  FROM clients
  WHERE LOWER(TRIM(email)) = LOWER(TRIM(p_client_data->>'email'))
  LIMIT 1;

  IF v_client_id IS NULL THEN
    INSERT INTO clients (
      name, email, phone, address, type, service,
      frequency, beds, baths, sqft, status,
      policies_agreed_at, notes
    ) VALUES (
      p_client_data->>'name',
      LOWER(TRIM(p_client_data->>'email')),
      p_client_data->>'phone',
      p_client_data->>'address',
      COALESCE(p_client_data->>'type', 'Residential'),
      p_client_data->>'service',
      p_client_data->>'frequency',
      NULLIF(p_client_data->>'beds',  '')::NUMERIC,
      NULLIF(p_client_data->>'baths', '')::NUMERIC,
      NULLIF(p_client_data->>'sqft',  '')::INTEGER,
      COALESCE(p_client_data->>'status', 'New'),
      NOW(),
      COALESCE(p_client_data->>'notes', 'Created automatically from booking portal')
    )
    RETURNING id INTO v_client_id;
  END IF;

  -- ── 2. Create appointment ─────────────────────────────────────────────
  INSERT INTO appointments (
    client_id, service, frequency, date, time, address,
    beds, baths, sqft, status,
    base_price, discount, tax, total_price, duration_hours, notes
  ) VALUES (
    v_client_id,
    p_appointment_data->>'service',
    p_appointment_data->>'frequency',
    (p_appointment_data->>'date')::DATE,
    p_appointment_data->>'time',
    p_appointment_data->>'address',
    NULLIF(p_appointment_data->>'beds',           '')::NUMERIC,
    NULLIF(p_appointment_data->>'baths',          '')::NUMERIC,
    NULLIF(p_appointment_data->>'sqft',           '')::INTEGER,
    COALESCE(p_appointment_data->>'status', 'scheduled'),
    NULLIF(p_appointment_data->>'base_price',     '')::NUMERIC,
    NULLIF(p_appointment_data->>'discount',       '')::NUMERIC,
    NULLIF(p_appointment_data->>'tax',            '')::NUMERIC,
    NULLIF(p_appointment_data->>'total_price',    '')::NUMERIC,
    NULLIF(p_appointment_data->>'duration_hours', '')::NUMERIC,
    p_appointment_data->>'notes'
  )
  RETURNING id INTO v_appointment_id;

  -- ── 3. Close the lead ─────────────────────────────────────────────────
  UPDATE leads
  SET
    stage             = 'Closed won',
    segment           = 'booked',
    segment_moved_at  = NOW(),
    quote_sent_at     = NOW()
  WHERE id = p_lead_id;

  -- ── Return both IDs so the caller knows what was created ──────────────
  RETURN jsonb_build_object(
    'client_id',      v_client_id,
    'appointment_id', v_appointment_id
  );

END;
$$;
