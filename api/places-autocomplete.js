// Vercel serverless proxy for Google Places Autocomplete
// Bypasses browser HTTP referrer restrictions on the API key
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { input } = req.query;
  if (!input || input.trim().length < 2) {
    return res.status(200).json({ predictions: [] });
  }

  const key = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyCkn8UeVuv5iek_Rm3jqdozF1HGMhSuGNk';
  const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&components=country:us&types=address&key=${key}`;

  try {
    const r = await fetch(url);
    const data = await r.json();
    const predictions = (data.predictions || []).map(p => ({
      description: p.description,
      place_id: p.place_id
    }));
    res.status(200).json({ predictions });
  } catch (e) {
    console.error('[places-autocomplete] error:', e);
    res.status(200).json({ predictions: [] });
  }
};
