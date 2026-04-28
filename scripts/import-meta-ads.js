
// import-meta-ads.js
// Fetches Meta Ads data and imports to Supabase meta_ads_daily
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// === CONFIG ===
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN; // Facebook API token
const FB_AD_ACCOUNT_ID = process.env.FB_AD_ACCOUNT_ID; // e.g. 'act_1234567890'

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !FB_ACCESS_TOKEN || !FB_AD_ACCOUNT_ID) {
  console.error('Missing env vars. Set SUPABASE_URL, SUPABASE_SERVICE_KEY, FB_ACCESS_TOKEN, FB_AD_ACCOUNT_ID');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function fetchMetaAdsInsights(since, until) {
  const fields = [
    'date_start', 'account_id', 'account_name',
    'campaign_id', 'campaign_name',
    'adset_id', 'adset_name', 'ad_id', 'ad_name',
    'spend', 'impressions', 'clicks', 'actions', 'purchase', 'leads', 'purchase_value'
  ];
  const url = `https://graph.facebook.com/v18.0/${FB_AD_ACCOUNT_ID}/insights` +
    `?fields=account_id,account_name,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,actions,date_start` +
    `&level=ad` +
    `&time_increment=1` +
    `&time_range={"since":"${since}","until":"${until}"}` +
    `&access_token=${FB_ACCESS_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Meta API error: ' + res.status);
  const data = await res.json();
  return data.data || [];
}

function parseActions(actions, type) {
  if (!Array.isArray(actions)) return 0;
  const found = actions.find(a => a.action_type === type);
  return found ? Number(found.value) : 0;
}

async function upsertToSupabase(rows) {
  if (!rows.length) return;
  const { error } = await supabase.from('meta_ads_daily').upsert(rows, { onConflict: ['date', 'ad_id'] });
  if (error) throw error;
}

async function main() {
  // Default: fetch last 2 days
  const today = new Date();
  const since = new Date(today); since.setDate(today.getDate() - 2);
  const sinceStr = since.toISOString().slice(0, 10);
  const untilStr = today.toISOString().slice(0, 10);

  console.log(`Fetching Meta Ads data from ${sinceStr} to ${untilStr}`);
  const insights = await fetchMetaAdsInsights(sinceStr, untilStr);
  if (!insights.length) { console.log('No data returned.'); return; }

  const rows = insights.map(row => ({
    date: row.date_start,
    account_id: row.account_id,
    account_name: row.account_name,
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    adset_id: row.adset_id,
    adset_name: row.adset_name,
    ad_id: row.ad_id,
    ad_name: row.ad_name,
    spend: Number(row.spend || 0),
    impressions: Number(row.impressions || 0),
    clicks: Number(row.clicks || 0),
    leads: parseActions(row.actions, 'lead'),
    purchase_value: parseActions(row.actions, 'offsite_conversion.purchase'),
    created_at: new Date().toISOString()
  }));

  await upsertToSupabase(rows);
  console.log(`Upserted ${rows.length} rows to meta_ads_daily.`);
}

main().catch(e => { console.error(e); process.exit(1); });
