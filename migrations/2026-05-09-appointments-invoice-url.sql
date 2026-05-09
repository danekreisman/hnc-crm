-- Migration: add invoice_url to appointments (denormalized for fast lookup).
-- Run in Supabase SQL editor.
--
-- Why: index.html's sendApptInvoice already writes invoice_url into the
-- canonical `invoices` table, AND tries to also stamp it onto the
-- corresponding appointment row so the appointment overlay can show the
-- invoice link without needing a join. Today that appointment-side write
-- fails silently because the column was never added. This migration fixes
-- that.
--
-- Surfaced by scripts/check-schema.js after the schema-enforcement gate
-- landed (2026-05-09).
--
-- Until this migration runs, the line in question (`db.from('appointments')
-- .update({invoice_sent: true, invoice_url: ...})`) returns an error from
-- Supabase, gets logged to console, and the appointment never gets
-- invoice_url stamped on it. The row in `invoices` is unaffected.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS invoice_url text;
