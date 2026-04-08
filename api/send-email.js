export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const FROM_EMAIL = 'Hawaii Natural Clean <dane@hawaiinaturalclean.com>';

    const {
      to,
      subject,
      type,
      clientName,
      amount,
      service,
      date,
      time,
      cleaner,
      invoiceUrl,
      terms,
      notes
    } = req.body;

    if (!to || !subject) {
      return res.status(400).json({ success: false, error: 'to and subject are required' });
    }

    // Build HTML based on email type
    let html = '';

    if (type === 'invoice') {
      html = `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1a1a;">
          <img src="https://hawaiinaturalclean.com/logo.png" alt="Hawaii Natural Clean" style="height:48px;margin-bottom:24px;" onerror="this.style.display='none'">
          <h2 style="font-size:22px;font-weight:700;margin-bottom:8px;">Invoice from Hawaii Natural Clean</h2>
          <p style="color:#666;margin-bottom:24px;">Hi ${clientName}, here is your invoice for recent cleaning services.</p>
          
          <div style="background:#f9f9f7;border-radius:12px;padding:20px;margin-bottom:24px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
              <span style="color:#666;">Service</span><span style="font-weight:600;">${service || 'Cleaning service'}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
              <span style="color:#666;">Date</span><span>${date || ''}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
              <span style="color:#666;">Terms</span><span>${terms || 'Due now'}</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding-top:12px;border-top:1px solid #e0e0dd;margin-top:8px;">
              <span style="font-weight:700;font-size:16px;">Total</span>
              <span style="font-weight:700;font-size:16px;color:#1D9E75;">${amount}</span>
            </div>
          </div>

          <div style="background:#f0faf6;border:1px solid #9ae6b4;border-radius:10px;padding:16px;margin-bottom:24px;">
            <p style="font-weight:600;color:#276749;margin:0 0 8px;">Payment options:</p>
            <p style="color:#276749;margin:0;font-size:14px;">✓ ACH bank transfer — <strong>FREE</strong> (3-5 business days)<br>✓ Credit/debit card — <strong>3% processing fee added</strong></p>
          </div>

          ${invoiceUrl ? `<a href="${invoiceUrl}" style="display:block;background:#1D9E75;color:#fff;text-align:center;padding:14px 24px;border-radius:10px;text-decoration:none;font-weight:600;font-size:16px;margin-bottom:24px;">View & Pay Invoice →</a>` : ''}
          
          ${notes ? `<p style="color:#666;font-size:14px;">${notes}</p>` : ''}
          
          <p style="color:#999;font-size:12px;margin-top:32px;padding-top:16px;border-top:1px solid #e8e8e5;">Hawaii Natural Clean · Oahu & Maui, Hawaii · hawaiinaturalclean.com</p>
        </div>
      `;
    } else if (type === 'reminder') {
      html = `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1a1a;">
          <h2 style="font-size:22px;font-weight:700;margin-bottom:8px;">Appointment Reminder</h2>
          <p style="color:#666;margin-bottom:24px;">Hi ${clientName}, just a friendly reminder about your upcoming cleaning!</p>
          
          <div style="background:#f9f9f7;border-radius:12px;padding:20px;margin-bottom:24px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
              <span style="color:#666;">Service</span><span style="font-weight:600;">${service || 'Cleaning service'}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
              <span style="color:#666;">Date</span><span style="font-weight:600;">${date || ''}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
              <span style="color:#666;">Time</span><span style="font-weight:600;">${time || ''}</span>
            </div>
            <div style="display:flex;justify-content:space-between;">
              <span style="color:#666;">Cleaner</span><span>${cleaner || 'Your Hawaii Natural Clean team'}</span>
            </div>
          </div>

          <p style="color:#666;font-size:14px;">Questions? Reply to this email or text us at (808) 468-5356.</p>
          <p style="color:#999;font-size:12px;margin-top:32px;padding-top:16px;border-top:1px solid #e8e8e5;">Hawaii Natural Clean · Oahu & Maui, Hawaii · hawaiinaturalclean.com</p>
        </div>
      `;
    } else if (type === 'thankyou') {
      html = `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1a1a;">
          <h2 style="font-size:22px;font-weight:700;margin-bottom:8px;">Thank you, ${clientName}! 🌺</h2>
          <p style="color:#666;margin-bottom:24px;">Your home has been cleaned and we hope everything looks great!</p>
          <p style="color:#666;margin-bottom:24px;">If you have a moment, we would really appreciate a Google review — it helps us grow and serve more families in Hawaii.</p>
          <a href="https://g.page/r/hawaiinaturalclean/review" style="display:block;background:#1D9E75;color:#fff;text-align:center;padding:14px 24px;border-radius:10px;text-decoration:none;font-weight:600;font-size:16px;margin-bottom:24px;">Leave a Google Review →</a>
          <p style="color:#666;font-size:14px;">See you next time! — The Hawaii Natural Clean Team</p>
          <p style="color:#999;font-size:12px;margin-top:32px;padding-top:16px;border-top:1px solid #e8e8e5;">Hawaii Natural Clean · Oahu & Maui, Hawaii · hawaiinaturalclean.com</p>
        </div>
      `;
    } else if (type === 'reactivation') {
      html = `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1a1a;">
          <h2 style="font-size:22px;font-weight:700;margin-bottom:8px;">We miss you, ${clientName}! 🌺</h2>
          <p style="color:#666;margin-bottom:24px;">It has been a while since your last cleaning. We would love to have you back!</p>
          <div style="background:#f5f0ff;border-radius:12px;padding:20px;margin-bottom:24px;text-align:center;">
            <p style="font-size:18px;font-weight:700;color:#553c9a;margin:0;">10% off your next booking</p>
            <p style="color:#666;font-size:14px;margin:8px 0 0;">This month only — reply to book</p>
          </div>
          <p style="color:#666;font-size:14px;">Reply to this email or text us at (808) 468-5356 to schedule.</p>
          <p style="color:#999;font-size:12px;margin-top:32px;padding-top:16px;border-top:1px solid #e8e8e5;">Hawaii Natural Clean · Oahu & Maui, Hawaii · hawaiinaturalclean.com</p>
        </div>
      `;
    } else {
      // Generic email
      html = `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1a1a;">
          <h2 style="font-size:22px;font-weight:700;margin-bottom:16px;">${subject}</h2>
          <p style="color:#666;">${notes || ''}</p>
          <p style="color:#999;font-size:12px;margin-top:32px;padding-top:16px;border-top:1px solid #e8e8e5;">Hawaii Natural Clean · Oahu & Maui, Hawaii · hawaiinaturalclean.com</p>
        </div>
      `;
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [to],
        subject: subject,
        html: html
      })
    });

    const data = await response.json();
    console.log('Resend response:', response.status, JSON.stringify(data));

    if (response.ok) {
      return res.status(200).json({ success: true, id: data.id });
    } else {
      return res.status(400).json({ success: false, error: data });
    }
  } catch (err) {
    console.error('Email error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
