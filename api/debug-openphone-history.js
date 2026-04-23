/**
 * Temporary debug endpoint — DELETE after testing
 * POST /api/debug-openphone-history
 * Body: { phone: "+18082697636" }
 */
import { getOpenPhoneHistory } from './utils/openphone-history.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });

  try {
    const history = await getOpenPhoneHistory(phone, {
      apiKey: process.env.QUO_API_KEY,
      maxSms: 200,
      maxCalls: 25,
    });
    return res.status(200).json({ 
      success: true, 
      historyLength: history.length,
      preview: history.slice(0, 1000),
      hasSmS: history.includes('SMS history'),
      hasCalls: history.includes('Call history'),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
