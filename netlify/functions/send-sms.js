const QUO_API_KEY = '40ad45ce1e1beb6196a5ab5568fb6e090ee14ad62c2b2d846fd47724af586bef';
const QUO_NUMBER = '+18084685356';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method not allowed' };
  try {
    const body = JSON.parse(event.body);
    if (body.statusOnly) {
      const res = await fetch('https://api.openphone.com/v1/phone-numbers', {
        headers: { 'Authorization': 'Bearer ' + QUO_API_KEY }
      });
      const text = await res.text();
      return { statusCode: 200, headers, body: JSON.stringify({ success: res.ok, status: res.status, response: text }) };
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
    return { statusCode: 200, headers, body: JSON.stringify({ success: response.ok, status: response.status, response: text }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
