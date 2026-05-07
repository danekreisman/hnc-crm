/**
 * Request Validation Utility
 * Lightweight schema validation — no external dependencies
 * Returns { valid: true } or { valid: false, errors: [...] }
 */

// ─── Validators ───────────────────────────────────────────────────────────────

export const is = {
  string:    (v) => typeof v === 'string',
  nonEmpty:  (v) => typeof v === 'string' && v.trim().length > 0,
  email:     (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()),
  phone:     (v) => typeof v === 'string' && v.replace(/\D/g, '').length >= 10,
  uuid:      (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  date:      (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)),
  number:    (v) => typeof v === 'number' && !isNaN(v),
  positiveNumber: (v) => typeof v === 'number' && !isNaN(v) && v > 0,
  array:     (v) => Array.isArray(v),
  nonEmptyArray: (v) => Array.isArray(v) && v.length > 0,
  boolean:   (v) => typeof v === 'boolean',
  oneOf:     (allowed) => (v) => allowed.includes(v),
  maxLength: (max) => (v) => typeof v === 'string' && v.length <= max,
  minLength: (min) => (v) => typeof v === 'string' && v.length >= min,
};

// ─── Core validator ───────────────────────────────────────────────────────────

/**
 * Validate a data object against a schema
 *
 * Schema format:
 * {
 *   fieldName: {
 *     required: true,                          // field must be present
 *     rules: [is.email, is.maxLength(200)],    // array of validator functions
 *     message: 'Must be a valid email'         // custom error message
 *   }
 * }
 *
 * @param {object} data  - The object to validate (e.g. req.body)
 * @param {object} schema - Validation schema
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validate(data, schema) {
  const errors = [];

  for (const [field, config] of Object.entries(schema)) {
    const value = data?.[field];
    const isEmpty = value === undefined || value === null || value === '';

    // Required check
    if (config.required && isEmpty) {
      errors.push(config.message || `${field} is required`);
      continue; // Skip further rules if missing
    }

    // Skip optional empty fields
    if (isEmpty) continue;

    // Run each rule
    for (const rule of (config.rules || [])) {
      if (!rule(value)) {
        errors.push(config.message || `${field} is invalid`);
        break; // One error per field
      }
    }
  }

  return {
    valid:  errors.length === 0,
    errors,
  };
}

/**
 * Quick helper: validate and return an error response if invalid
 * Usage: const invalid = validateOrFail(req.body, schema); if (invalid) return res.status(400).json(invalid);
 *
 * @param {object} data
 * @param {object} schema
 * @returns {object|null} - Error response object if invalid, null if valid
 */
export function validateOrFail(data, schema) {
  const result = validate(data, schema);
  if (!result.valid) {
    return { success: false, error: 'Validation failed', details: result.errors };
  }
  return null;
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const SCHEMAS = {

  leadCapture: {
    name:    { required: true,  rules: [is.nonEmpty, is.maxLength(100)], message: 'Name is required (max 100 chars)' },
    email:   { required: true,  rules: [is.email,    is.maxLength(200)], message: 'A valid email address is required' },
    phone:   { required: true,  rules: [is.phone],                       message: 'A valid phone number is required (10+ digits)' },
    address: { required: true,  rules: [is.nonEmpty, is.maxLength(300)], message: 'Address is required (max 300 chars)' },
    notes:   { required: false, rules: [is.maxLength(2000)],             message: 'Notes must be under 2000 characters' },
    sqft:    { required: false, rules: [(v) => is.number(Number(v)) && Number(v) > 0 && Number(v) < 50000], message: 'Square footage must be a positive number under 50,000' },
  },

  sendSms: {
    to:      { required: true,  rules: [is.phone,    is.maxLength(20)],   message: 'A valid phone number is required' },
    message: { required: true,  rules: [is.nonEmpty, is.maxLength(1600)], message: 'Message is required (max 1600 chars — SMS limit)' },
  },

  openphoneContact: {
    name:    { required: true,  rules: [is.nonEmpty, is.maxLength(200)], message: 'Name is required (max 200 chars)' },
    phone:   { required: true,  rules: [is.phone, is.maxLength(20)],     message: 'A valid phone number is required (10+ digits)' },
    email:   { required: false, rules: [is.email,    is.maxLength(200)], message: 'Email must be valid if provided' },
    leadId:  { required: false, rules: [is.maxLength(100)],              message: 'leadId must be a string under 100 chars' },
    company: { required: false, rules: [is.maxLength(300)],              message: 'Company must be under 300 chars' },
  },

  acceptCallLead: {
    taskId:  { required: true,  rules: [is.uuid],                        message: 'taskId must be a valid UUID' },
    name:    { required: true,  rules: [is.nonEmpty, is.maxLength(200)], message: 'Name is required (max 200 chars)' },
    phone:   { required: true,  rules: [is.phone, is.maxLength(20)],     message: 'A valid phone number is required (10+ digits)' },
    email:   { required: false, rules: [is.email,    is.maxLength(200)], message: 'Email must be valid if provided' },
    address: { required: false, rules: [is.maxLength(300)],              message: 'Address must be under 300 chars' },
    service: { required: false, rules: [is.maxLength(100)],              message: 'Service must be under 100 chars' },
    sqft:    { required: false, rules: [is.maxLength(20)],               message: 'Sqft must be under 20 chars' },
    beds:    { required: false, rules: [is.maxLength(20)],               message: 'Beds must be under 20 chars' },
    baths:   { required: false, rules: [is.maxLength(20)],               message: 'Baths must be under 20 chars' },
    condition: { required: false, rules: [is.maxLength(20)],             message: 'Condition must be under 20 chars' },
    frequency: { required: false, rules: [is.maxLength(50)],             message: 'Frequency must be under 50 chars' },
    notes:   { required: false, rules: [is.maxLength(2000)],             message: 'Notes must be under 2000 chars' },
    quote_amount: { required: false, rules: [(v) => v == null || (is.positiveNumber(Number(v)) && Number(v) < 100000)], message: 'Quote amount must be a positive number under 100000' },
  },

  confirmQuoteSent: {
    taskId: { required: true, rules: [is.uuid], message: 'taskId must be a valid UUID' },
    leadId: { required: true, rules: [is.uuid], message: 'leadId must be a valid UUID' },
    amount: { required: true, rules: [(v) => is.positiveNumber(Number(v)) && Number(v) < 100000], message: 'Amount must be a positive number under 100000' },
  },

  aiSummary: {
    prompt: { required: false, rules: [is.nonEmpty, is.maxLength(8000)], message: 'Prompt must be a non-empty string (max 8000 chars)' },
    leadId: { required: false, rules: [is.uuid], message: 'leadId must be a valid UUID' },
  },

  saveAutomation: {
    name:         { required: true, rules: [is.nonEmpty, is.maxLength(100)],  message: 'Automation name is required (max 100 chars)' },
    trigger_type: {
      required: true,
      rules: [is.oneOf(['lead_created', 'form_submission', 'scheduled', 'days_since_response', 'booking_completed', 'days_in_segment', 'stage_entered'])],
      message: 'trigger_type must be one of: lead_created, form_submission, scheduled, days_since_response, booking_completed, days_in_segment, stage_entered'
    },
    actions: { required: true, rules: [is.nonEmptyArray], message: 'At least one action is required' },
  },

  booking: {
    token:          { required: true,  rules: [is.nonEmpty, is.maxLength(200)],          message: 'Booking token is required' },
    date:           { required: true,  rules: [is.date],                                   message: 'Date must be a valid date (YYYY-MM-DD)' },
    time:           { required: true,  rules: [is.nonEmpty, is.maxLength(20)],             message: 'Time is required' },
    policiesAgreed: { required: true,  rules: [(v) => v === true],                        message: 'You must agree to all policies to complete your booking' },
  },

  cleanerInvite: {
    cleaner_id: { required: true, rules: [is.uuid], message: 'cleaner_id must be a valid UUID' },
  },

  cleanerInviteRedeem: {
    token: { required: true, rules: [is.nonEmpty, is.maxLength(64)], message: 'Invite token is required' },
  },

  publicBookingLookup: {
    email: { required: true, rules: [is.email,    is.maxLength(200)], message: 'A valid email address is required' },
    phone: { required: true, rules: [is.phone,    is.maxLength(20)],  message: 'A valid phone number is required (10+ digits)' },
  },

  publicBookingSubmit: {
    // Customer
    name:    { required: true,  rules: [is.nonEmpty, is.maxLength(100)], message: 'Name is required (max 100 chars)' },
    email:   { required: true,  rules: [is.email,    is.maxLength(200)], message: 'A valid email address is required' },
    phone:   { required: true,  rules: [is.phone,    is.maxLength(20)],  message: 'A valid phone number is required (10+ digits)' },
    address: { required: true,  rules: [is.nonEmpty, is.maxLength(300)], message: 'Address is required (max 300 chars)' },

    // Service + property details (used for new-quote path)
    service:    { required: true, rules: [is.nonEmpty, is.maxLength(60)], message: 'Service type is required' },
    frequency:  { required: false, rules: [is.maxLength(50)],              message: 'Frequency must be under 50 chars' },
    beds:       { required: false, rules: [is.maxLength(20)],              message: 'Beds must be under 20 chars' },
    baths:      { required: false, rules: [is.maxLength(20)],              message: 'Baths must be under 20 chars' },
    sqft:       { required: false, rules: [is.maxLength(20)],              message: 'Sqft must be under 20 chars' },
    condition:  { required: false, rules: [is.maxLength(20)],              message: 'Condition must be under 20 chars' },

    // Path discriminator: 'new_quote' (cold lead) | 'existing_property' (returning client)
    path:       { required: true,  rules: [is.oneOf(['new_quote', 'existing_property'])], message: 'path must be new_quote or existing_property' },

    // Booking choices
    date:           { required: true,  rules: [is.date],                                   message: 'Date must be a valid date (YYYY-MM-DD)' },
    time:           { required: true,  rules: [is.nonEmpty, is.maxLength(20)],             message: 'Time is required' },
    notes:          { required: false, rules: [is.maxLength(2000)],                        message: 'Notes must be under 2000 characters' },
    policiesAgreed: { required: true,  rules: [(v) => v === true],                         message: 'You must agree to all policies to complete your booking' },

    // Existing-property path: client_id of the matched returning customer
    clientId:        { required: false, rules: [is.uuid],                                  message: 'clientId must be a valid UUID if provided' },
    propertyAddress: { required: false, rules: [is.maxLength(300)],                        message: 'propertyAddress must be under 300 chars' },
    priceTotal:      { required: false, rules: [(v) => v == null || (is.number(Number(v)) && Number(v) >= 0 && Number(v) < 100000)], message: 'priceTotal must be a non-negative number under 100000 if provided' },
  },

};

/**
 * Validate automation actions array
 * Each action must have a valid type and required fields for that type
 */
export function validateActions(actions) {
  const errors = [];
  const validTypes = ['sms', 'email', 'segment_move', 'internal_notification', 'create_va_task'];

  if (!Array.isArray(actions)) {
    return ['actions must be an array'];
  }

  actions.forEach((action, i) => {
    const label = `Action ${i + 1}`;
    if (!action.type || !validTypes.includes(action.type)) {
      errors.push(`${label}: type must be one of: ${validTypes.join(', ')}`);
      return;
    }
    if ((action.type === 'sms' || action.type === 'email') && !action.message?.trim()) {
      errors.push(`${label} (${action.type}): message is required`);
    }
    if (action.type === 'email' && action.message && action.message.length > 5000) {
      errors.push(`${label} (email): message must be under 5000 characters`);
    }
    if (action.type === 'sms' && action.message && action.message.length > 1600) {
      errors.push(`${label} (sms): message must be under 1600 characters`);
    }
    if (action.type === 'segment_move' && !action.new_segment?.trim()) {
      errors.push(`${label} (segment_move): new_segment is required`);
    }
    if (action.type === 'create_va_task' && !action.title?.trim()) {
      errors.push(`${label} (create_va_task): title is required`);
    }
    if (action.type === 'create_va_task' && action.title && action.title.length > 200) {
      errors.push(`${label} (create_va_task): title must be under 200 characters`);
    }
    if (action.delay_minutes !== undefined && (typeof action.delay_minutes !== 'number' || action.delay_minutes < 0)) {
      errors.push(`${label}: delay_minutes must be a non-negative number`);
    }
  });

  return errors;
}
