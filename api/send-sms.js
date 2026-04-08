export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { to, message, statusOnly } = req.body;
    const QUO_API_KEY = process.env.QUO_API_KEY;
    const QUO_NUMBER = process.env.QUO_NUMBER;

    if (statusOnly) {
      const response = await fetch('https://api.openphone.com/v1/phone-numbers', {
        headers: { 'Authorization': QUO_API_KEY }
      });
      const data = await response.json();
      return res.status(200).json({ success: response.ok, status: response.status, data });
    }

    let phone = to.replace(/[^0-9+]/g, '');
    if (!phone.startsWith('+')) phone = '+1' + phone;

    const response = await fetch('https://api.openphone.com/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': QUO_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content: message,
        from: QUO_NUMBER,
        to: [phone]
      })
    });

    const data = await response.json();
    console.log('Send SMS response:', response.status, JSON.stringify(data));

    return res.status(200).json({ success: response.ok, status: response.status, data });
  } catch (err) {
    console.error('SMS error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
