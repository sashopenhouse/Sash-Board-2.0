import crypto from 'node:crypto';

const EVENT_MAP = {
  page_view: 'PageView',
  form_submit: 'Lead',
  quote_confirmed: 'Lead',
  bath_quiz_lead: 'Lead',
  phone_click: 'Contact',
  chat_click: 'Contact',
  prize_wheel_claim: 'CompleteRegistration'
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function hashValue(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

function normalizeEventTime(tsValue) {
  if (!tsValue) return Math.floor(Date.now() / 1000);
  const parsed = Date.parse(tsValue);
  return Number.isNaN(parsed) ? Math.floor(Date.now() / 1000) : Math.floor(parsed / 1000);
}

function safeJsonParse(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function parseClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (Array.isArray(forwarded) && forwarded.length) return String(forwarded[0]).split(',')[0].trim();
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || undefined;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  const testEventCode = process.env.META_CAPI_TEST_EVENT_CODE;

  if (!pixelId || !accessToken) {
    res.status(500).json({ error: 'Missing META_PIXEL_ID or META_CAPI_ACCESS_TOKEN' });
    return;
  }

  const body = safeJsonParse(req.body);
  const incomingType = body.event_type;
  const eventName = EVENT_MAP[incomingType];

  if (!eventName) {
    res.status(400).json({ error: 'Unsupported event_type' });
    return;
  }

  const userData = {
    client_ip_address: parseClientIp(req),
    client_user_agent: body.user_agent || req.headers['user-agent'] || undefined,
    fbp: body.fbp || undefined,
    fbc: body.fbc || undefined,
    external_id: hashValue(`${body.site_id || ''}:${body.visitor_id || ''}:${body.session_id || ''}`)
  };

  const customData = {
    event_type: incomingType,
    site_id: body.site_id || undefined,
    page_path: body.page_path || undefined,
    utm_source: body.utm_source || undefined,
    utm_medium: body.utm_medium || undefined,
    utm_campaign: body.utm_campaign || undefined
  };

  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: normalizeEventTime(body.event_time || body.ts),
        event_id: body.event_id || crypto.randomUUID(),
        action_source: 'website',
        event_source_url: body.page_url || undefined,
        user_data: userData,
        custom_data: customData
      }
    ]
  };

  if (testEventCode) {
    payload.test_event_code = testEventCode;
  }

  const url = `https://graph.facebook.com/v20.0/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`;

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await upstream.text();
    res.status(upstream.status).send(text);
  } catch (error) {
    res.status(500).json({ error: 'Meta CAPI request failed' });
  }
}
