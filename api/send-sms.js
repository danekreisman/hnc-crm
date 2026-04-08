const QUO_API_KEY = process.env.QUO_API_KEY;
const QUO_NUMBER = process.env.QUO_NUMBER;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;
    if (body.statusOnly) {
      const apiRes = await fetch('https://api.openphone.com/v1/phone-numbers', {
        headers: { 'Authorization': 'Bearer ' + QUO_API_KEY }
      });
      const text = await apiRes.text();
      return res.status(200).json({ success: apiRes.ok, status: apiRes.status, response: text });
    }
    const { to, message } = body;
    let phone = to.replace(/[^0-9+]/g, '');
    if (!phone.startsWith('+')) phone = '+1' + phone;
    const response = await fetch('https://api.openphone.com/v1/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + QUO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message, from: QUO_NUMBER, to: [phone] })
    });
    const text = await response.text();
    return res.status(200).json({ success: response.ok, status: response.status, response: text });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
