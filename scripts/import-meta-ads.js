
// import-meta-ads.js
// Fetches Meta Ads data and imports to Supabase meta_ads_daily
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// === CONFIG ===
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN; // Facebook API token
const FB_AD_ACCOUNT_ID = process.env.FB_AD_ACCOUNT_ID; // e.g. 'act_1234567890'

// Defaults can be overridden with env vars.
const DEFAULT_DAYS_BACK = Number(process.env.META_DAYS_BACK || 2);
const PRIMARY_CONVERSION_ACTIONS = (process.env.META_PRIMARY_CONVERSION_ACTIONS ||
  'lead,onsite_conversion.lead_grouped,offsite_conversion.fb_pixel_lead,offsite_conversion.custom.qualified_lead,submit_application,call_confirm_grouped,click_to_call_call_confirm,click_to_call_native_call_placed')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const PURCHASE_VALUE_ACTIONS = (process.env.META_PURCHASE_VALUE_ACTIONS ||
  'offsite_conversion.purchase,omni_purchase,purchase')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !FB_ACCESS_TOKEN || !FB_AD_ACCOUNT_ID) {
  console.error('Missing env vars. Set SUPABASE_URL, SUPABASE_SERVICE_KEY, FB_ACCESS_TOKEN, FB_AD_ACCOUNT_ID');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function fetchMetaAdsInsights(since, until) {
  let url = `https://graph.facebook.com/v18.0/${FB_AD_ACCOUNT_ID}/insights` +
    `?fields=account_id,account_name,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,objective,spend,impressions,clicks,actions,action_values,date_start` +
    `&level=ad` +
    `&time_increment=1` +
    `&limit=500` +
    `&time_range={"since":"${since}","until":"${until}"}` +
    `&access_token=${FB_ACCESS_TOKEN}`;

  const allRows = [];
  let page = 0;

  while (url) {
    page += 1;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Meta API error: ' + res.status);
    const payload = await res.json();
    allRows.push(...(payload.data || []));
    url = payload.paging?.next || null;
  }

  console.log(`Fetched ${allRows.length} insight rows across ${page} page(s).`);
  return allRows;
}

function parseActions(actions, type) {
  if (!Array.isArray(actions)) return 0;
  const found = actions.find(a => a.action_type === type);
  return found ? Number(found.value) : 0;
}

function parseActionTotal(actions, actionTypes) {
  if (!Array.isArray(actions)) return 0;
  return actions.reduce((sum, action) => {
    if (!action || !action.action_type) return sum;
    if (!actionTypes.includes(action.action_type)) return sum;
    return sum + Number(action.value || 0);
  }, 0);
}

function parseDateArgs() {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };

  const sinceArg = getArg('--since');
  const untilArg = getArg('--until');
  const daysArg = Number(getArg('--days') || DEFAULT_DAYS_BACK);

  const today = new Date();
  const until = untilArg ? new Date(untilArg) : today;
  const since = sinceArg ? new Date(sinceArg) : new Date(until);

  if (!sinceArg) {
    since.setDate(until.getDate() - daysArg);
  }

  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
    throw new Error('Invalid date args. Use --since YYYY-MM-DD --until YYYY-MM-DD or --days N');
  }

  return {
    sinceStr: since.toISOString().slice(0, 10),
    untilStr: until.toISOString().slice(0, 10),
  };
}

async function upsertToSupabase(rows) {
  if (!rows.length) return;
  const { error } = await supabase.from('meta_ads_daily').upsert(rows, { onConflict: ['date', 'ad_id'] });
  if (error) throw error;
}

async function main() {
  const { sinceStr, untilStr } = parseDateArgs();

  console.log(`Fetching Meta Ads data from ${sinceStr} to ${untilStr}`);
  console.log(`Primary conversion actions: ${PRIMARY_CONVERSION_ACTIONS.join(', ')}`);
  const insights = await fetchMetaAdsInsights(sinceStr, untilStr);
  if (!insights.length) { console.log('No data returned.'); return; }

  const actionTypeCounts = {};
  insights.forEach(row => {
    (row.actions || []).forEach(action => {
      actionTypeCounts[action.action_type] = (actionTypeCounts[action.action_type] || 0) + Number(action.value || 0);
    });
  });
  const topActionTypes = Object.entries(actionTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');
  console.log(`Top action types in window: ${topActionTypes || 'none'}`);

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
    leads: parseActionTotal(row.actions, PRIMARY_CONVERSION_ACTIONS),
    purchase_value: parseActionTotal(row.action_values, PURCHASE_VALUE_ACTIONS),
    created_at: new Date().toISOString()
  }));

  await upsertToSupabase(rows);
  console.log(`Upserted ${rows.length} rows to meta_ads_daily.`);
}

main().catch(e => { console.error(e); process.exit(1); });
