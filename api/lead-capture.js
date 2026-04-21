/**
 * api/lead-capture.js
 * 
 * Handles form submissions from the lead capture form:
 * 1. Validates incoming data
 * 2. Creates lead record in Supabase
 * 3. Triggers applicable automations (SMS, email, internal notifications)
 * 4. Returns confirmation to frontend
 * 
 * Deployed to: https://hnc-crm.vercel.app/api/lead-capture
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // Use service role for write access
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const OPENPHONE_API_KEY = process.env.OPENPHONE_API_KEY;

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// Input validation schema
const validateLead = (data) => {
  const errors = [];

  if (!data.name || data.name.trim().length < 2) {
    errors.push('Name must be at least 2 characters');
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!data.email || !emailRegex.test(data.email)) {
    errors.push('Invalid email address');
  }

  const phoneRegex = /^\d{10,}|^\([0-9]{3}\)\s?[0-9]{3}-?[0-9]{4}/;
  const phoneDigits = data.phone.replace(/\D/g, '');
  if (!data.phone || phoneDigits.length < 10) {
    errors.push('Invalid phone number');
  }

  if (!data.address || data.address.trim().length < 5) {
    errors.push('Please enter a valid address');
  }

  if (!data.serviceType) {
    errors.push('Please select at least one service type');
  }

  if (!data.frequency) {
    errors.push('Please select a frequency');
  }

  return { valid: errors.length === 0, errors };
};

// Send SMS via OpenPhone/Quo
const sendSMS = async (phoneNumber, message) => {
  try {
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    const response = await fetch('https://api.openphone.io/sms', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENPHONE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        phoneNumber: `+1${cleanPhone}`,
        message: message
      })
    });

    if (!response.ok) {
      console.error('[sendSMS] OpenPhone error:', await response.text());
      return false;
    }

    console.log('[sendSMS] Sent to', cleanPhone);
    return true;
  } catch (error) {
    console.error('[sendSMS] Error:', error);
    return false;
  }
};

// Send email via Resend
const sendEmail = async (to, subject, htmlContent) => {
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Hawaii Natural Clean <hello@hawaiinatural.clean>',
        to: to,
        subject: subject,
        html: htmlContent
      })
    });

    if (!response.ok) {
      console.error('[sendEmail] Resend error:', await response.text());
      return false;
    }

    console.log('[sendEmail] Sent to', to);
    return true;
  } catch (error) {
    console.error('[sendEmail] Error:', error);
    return false;
  }
};

// Execute automation actions
const executeAutomationActions = async (leadData, automation) => {
  const actions = automation.actions || [];
  const results = [];

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const delay = action.delay_minutes || 0;

    // Apply delay if specified
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay * 60 * 1000));
    }

    try {
      switch (action.type) {
        case 'sms':
          const smsSent = await sendSMS(leadData.phone, action.message);
          results.push({
            action_index: i,
            type: 'sms',
            status: smsSent ? 'success' : 'failed',
            timestamp: new Date().toISOString()
          });
          break;

        case 'email':
          const emailHtml = generateEmailTemplate(action.template, leadData);
          const emailSent = await sendEmail(
            leadData.email,
            action.subject || 'Hawaii Natural Clean — Quote Request',
            emailHtml
          );
          results.push({
            action_index: i,
            type: 'email',
            status: emailSent ? 'success' : 'failed',
            timestamp: new Date().toISOString()
          });
          break;

        case 'update_stage':
          // Stage update happens at lead creation, not in automation
          results.push({
            action_index: i,
            type: 'update_stage',
            status: 'skipped',
            reason: 'Stage set at lead creation',
            timestamp: new Date().toISOString()
          });
          break;

        case 'webhook':
          const webhookSuccess = await fetch(action.url, {
            method: action.method || 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lead: leadData, automation: automation.id })
          }).then(r => r.ok).catch(() => false);

          results.push({
            action_index: i,
            type: 'webhook',
            status: webhookSuccess ? 'success' : 'failed',
            url: action.url,
            timestamp: new Date().toISOString()
          });
          break;

        case 'internal_notification':
          // Log for dashboard notification system
          console.log(`[AUTOMATION] Internal notification: ${action.message}`);
          results.push({
            action_index: i,
            type: 'internal_notification',
            status: 'logged',
            timestamp: new Date().toISOString()
          });
          break;

        default:
          results.push({
            action_index: i,
            type: action.type,
            status: 'unknown_action',
            timestamp: new Date().toISOString()
          });
      }
    } catch (error) {
      console.error(`[executeAutomationActions] Action ${i} (${action.type}) failed:`, error);
      results.push({
        action_index: i,
        type: action.type,
        status: 'error',
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }

  return results;
};

// Email template generator
const generateEmailTemplate = (templateType, lead) => {
  const templates = {
    welcome: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2d5a3d;">Thanks for choosing Hawaii Natural Clean!</h2>
        <p>Hi ${lead.name},</p>
        <p>We received your quote request for <strong>${lead.address}</strong>.</p>
        <p>We'll be in touch within 24 hours with your personalized quote. Our team is ready to make your home shine!</p>
        <p style="margin-top: 30px;">
          Questions? Reach out anytime:<br>
          📞 (808) 555-0000<br>
          📧 hello@hawaiinatural.clean
        </p>
        <p style="color: #999; font-size: 12px; margin-top: 30px;">
          Hawaii Natural Clean • Honest, thorough, local.
        </p>
      </div>
    `,
    confirmation: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2d5a3d;">Quote Confirmation</h2>
        <p>Hi ${lead.name},</p>
        <p><strong>Service Details:</strong></p>
        <ul>
          <li>Address: ${lead.address}</li>
          <li>Service: ${lead.serviceType}</li>
          <li>Frequency: ${lead.frequency}</li>
          ${lead.beds ? `<li>Bedrooms: ${lead.beds}</li>` : ''}
          ${lead.baths ? `<li>Bathrooms: ${lead.baths}</li>` : ''}
        </ul>
        <p style="margin-top: 20px;">Thanks for your business!</p>
      </div>
    `
  };

  return templates[templateType] || templates.welcome;
};

// Main handler
module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const leadData = req.body;
    console.log('[lead-capture] Received submission:', leadData.email);

    // Validate input
    const validation = validateLead(leadData);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        errors: validation.errors
      });
    }

    // Check for duplicate leads (same email + phone within 24h)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: existingLeads } = await db
      .from('leads')
      .select('id')
      .eq('email', leadData.email)
      .eq('phone', leadData.phone.replace(/\D/g, ''))
      .gte('created_at', twentyFourHoursAgo)
      .limit(1);

    if (existingLeads && existingLeads.length > 0) {
      console.log('[lead-capture] Duplicate submission detected:', leadData.email);
      return res.status(400).json({
        success: false,
        message: 'We already have a recent submission from you. We\'ll be in touch soon!'
      });
    }

    // Get website_form source ID
    const { data: sourceData } = await db
      .from('lead_sources')
      .select('id')
      .eq('name', 'website_form')
      .single();

    const sourceId = sourceData?.id || null;

    // Create lead record
    const { data: newLead, error: leadError } = await db
      .from('leads')
      .insert([{
        name: leadData.name,
        email: leadData.email,
        phone: leadData.phone.replace(/\D/g, ''),
        address: leadData.address,
        beds: leadData.beds ? parseInt(leadData.beds) : null,
        baths: leadData.baths ? parseFloat(leadData.baths) : null,
        stage: 'New inquiry',
        source: leadData.referralSource || 'Website form',
        source_id: sourceId,
        property_details: leadData.serviceType,
        frequency: leadData.frequency,
        notes: leadData.notes || null,
        custom_fields: {
          serviceType: leadData.serviceType,
          island: leadData.island || 'Oahu',
          referralSource: leadData.referralSource || null,
          source_name: 'website_form',
          submittedAt: leadData.submittedAt
        }
      }])
      .select();

    if (leadError) {
      console.error('[lead-capture] Supabase insert error:', leadError);
      return res.status(500).json({
        success: false,
        message: 'Error saving lead. Please try again.'
      });
    }

    const createdLead = newLead[0];
    console.log('[lead-capture] Lead created:', createdLead.id);

    // Fetch applicable automations
    const { data: automations, error: autoError } = await db
      .from('lead_automations')
      .select('*')
      .eq('is_enabled', true)
      .eq('trigger_type', 'form_submission');

    if (autoError) {
      console.error('[lead-capture] Automation fetch error:', autoError);
    }

    // Execute applicable automations
    if (automations && automations.length > 0) {
      for (const automation of automations) {
        // Check if automation applies to this form submission
        const triggerConfig = automation.trigger_config || {};
        if (triggerConfig.source_id && triggerConfig.source_id !== sourceId) {
          continue; // Skip if source doesn't match
        }

        try {
          console.log('[lead-capture] Executing automation:', automation.id);
          const actionResults = await executeAutomationActions(
            {
              id: createdLead.id,
              ...leadData
            },
            automation
          );

          // Log automation run
          await db.from('lead_automation_runs').insert([{
            automation_id: automation.id,
            lead_id: createdLead.id,
            trigger_data: { source_id: sourceId, stage: 'New' },
            actions_executed: actionResults,
            status: actionResults.some(r => r.status === 'error') ? 'failed' : 'success'
          }]);
        } catch (autoExecError) {
          console.error('[lead-capture] Automation execution error:', autoExecError);
        }
      }
    }

    // If no automations configured, send default welcome email
    if (!automations || automations.length === 0) {
      console.log('[lead-capture] No automations; sending default welcome email');
      await sendEmail(
        leadData.email,
        'Thanks for contacting Hawaii Natural Clean!',
        generateEmailTemplate('welcome', leadData)
      );
    }

    return res.status(200).json({
      success: true,
      message: 'Lead captured successfully',
      leadId: createdLead.id
    });

  } catch (error) {
    console.error('[lead-capture] Unexpected error:', error);
    return res.status(500).json({
      success: false,
      message: 'An unexpected error occurred. Please try again.'
    });
  }
};
