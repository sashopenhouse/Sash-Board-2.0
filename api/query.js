export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ error: 'Missing Supabase env vars' });
    return;
  }

  const table = Array.isArray(req.query.table) ? req.query.table[0] : req.query.table;
  const params = Array.isArray(req.query.params) ? req.query.params[0] : req.query.params;

  const allowedTables = new Set([
    'events',
    'v_daily_summary',
    'v_campaign_funnel',
    'v_geo_summary'
  ]);

  if (!table || !allowedTables.has(table)) {
    res.status(400).json({ error: 'Invalid table' });
    return;
  }

  const url = `${supabaseUrl}/rest/v1/${table}?${params || ''}`;

  try {
    const upstream = await fetch(url, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      }
    });

    const text = await upstream.text();
    res.status(upstream.status).send(text);
  } catch (err) {
    res.status(500).json({ error: 'Upstream request failed' });
  }
}
