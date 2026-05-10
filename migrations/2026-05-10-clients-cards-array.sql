-- 2026-05-10 — multi-card support for clients.
--
-- Stores the full list of payment methods Stripe has on file for the
-- customer, synced on demand via /api/sync-client-cards. Driven by
-- the per-client "Refresh card data" button (no bulk sync — Dane's
-- choice for caution around Stripe-touching ops).
--
-- Each entry shape: { id, brand, last4, exp_month, exp_year }
--   - id is the Stripe paymentMethod ID (pm_xxx) — used to charge
--     a specific card via charge_specific_card.
--   - brand/last4/exp_* are display + expiry warnings.
--
-- The cards array can be empty; cards_synced_at marks when we last
-- asked Stripe.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS cards           JSONB        DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS cards_synced_at TIMESTAMPTZ;

COMMENT ON COLUMN clients.cards           IS 'Array of payment methods from Stripe: [{id,brand,last4,exp_month,exp_year}]';
COMMENT ON COLUMN clients.cards_synced_at IS 'Last time we synced card data from Stripe for this client';
