// import-tiktok-ads.js
// Fetches TikTok Ads data and imports to Supabase tiktok_ads_daily
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TIKTOK_ACCESS_TOKEN = process.env.TIKTOK_ACCESS_TOKEN;
const TIKTOK_ADVERTISER_ID = process.env.TIKTOK_ADVERTISER_ID;
const TIKTOK_API_BASE = process.env.TIKTOK_API_BASE || 'https://business-api.tiktok.com/open_api/v1.3';

const DEFAULT_DAYS_BACK = Number(process.env.TIKTOK_DAYS_BACK || 2);

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TIKTOK_ACCESS_TOKEN || !TIKTOK_ADVERTISER_ID) {
  console.error('Missing env vars. Set SUPABASE_URL, SUPABASE_SERVICE_KEY, TIKTOK_ACCESS_TOKEN, TIKTOK_ADVERTISER_ID');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

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

function toNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function getFirstNumeric(metricMap, keys) {
  for (const key of keys) {
    if (metricMap[key] !== undefined && metricMap[key] !== null && metricMap[key] !== '') {
      return toNumber(metricMap[key]);
    }
  }
  return 0;
}

async function fetchTikTokReport(since, until) {
  const endpoint = `${TIKTOK_API_BASE.replace(/\/$/, '')}/report/integrated/get/`;
  const body = {
    advertiser_id: TIKTOK_ADVERTISER_ID,
    report_type: 'BASIC',
    data_level: 'AUCTION_AD',
    dimensions: ['stat_time_day', 'campaign_id', 'campaign_name', 'adgroup_id', 'adgroup_name', 'ad_id', 'ad_name'],
    metrics: [
      'spend',
      'impressions',
      'clicks',
      'conversion',
      'total_complete_payment_rate',
      'total_complete_payment',
      'value_per_complete_payment',
      'cost_per_conversion',
      'real_time_conversion',
      'complete_payment'
    ],
    start_date: since,
    end_date: until,
    page: 1,
    page_size: 1000,
  };

  const all = [];
  let page = 1;
  let totalPage = 1;

  do {
    body.page = page;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Access-Token': TIKTOK_ACCESS_TOKEN,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`TikTok API HTTP ${res.status}`);
    }

    const payload = await res.json();
    if (payload.code !== 0) {
      throw new Error(`TikTok API error ${payload.code}: ${payload.message || 'Unknown error'}`);
    }

    const list = payload.data?.list || [];
    all.push(...list);

    const pageInfo = payload.data?.page_info || {};
    totalPage = Number(pageInfo.total_page || 1);
    page += 1;
  } while (page <= totalPage);

  console.log(`Fetched ${all.length} TikTok insight rows across ${Math.max(totalPage, 1)} page(s).`);
  return all;
}

function normalizeRows(rows) {
  return rows.map((row) => {
    const dimensions = row.dimensions || {};
    const metrics = row.metrics || {};

    const leads = getFirstNumeric(metrics, [
      'conversion',
      'real_time_conversion',
      'lead',
      'leads',
    ]);

    const conversionValue = getFirstNumeric(metrics, [
      'total_complete_payment',
      'complete_payment',
      'purchase_value',
      'value',
    ]);

    return {
      date: dimensions.stat_time_day,
      account_id: String(TIKTOK_ADVERTISER_ID),
      account_name: process.env.TIKTOK_ADVERTISER_NAME || `TikTok ${TIKTOK_ADVERTISER_ID}`,
      campaign_id: dimensions.campaign_id || null,
      campaign_name: dimensions.campaign_name || null,
      adset_id: dimensions.adgroup_id || null,
      adset_name: dimensions.adgroup_name || null,
      ad_id: dimensions.ad_id || null,
      ad_name: dimensions.ad_name || null,
      spend: toNumber(metrics.spend),
      impressions: Math.round(toNumber(metrics.impressions)),
      clicks: Math.round(toNumber(metrics.clicks)),
      leads: Math.round(leads),
      purchase_value: toNumber(conversionValue),
      created_at: new Date().toISOString(),
    };
  }).filter((r) => !!r.date && !!r.ad_id);
}

async function upsertToSupabase(rows) {
  if (!rows.length) return;
  const { error } = await supabase.from('tiktok_ads_daily').upsert(rows, { onConflict: 'date,ad_id' });
  if (error) throw error;
}

async function main() {
  const { sinceStr, untilStr } = parseDateArgs();
  console.log(`Fetching TikTok Ads data from ${sinceStr} to ${untilStr}`);

  const insights = await fetchTikTokReport(sinceStr, untilStr);
  if (!insights.length) {
    console.log('No data returned.');
    return;
  }

  const rows = normalizeRows(insights);
  if (!rows.length) {
    console.log('No usable rows to import (missing date/ad_id).');
    return;
  }

  await upsertToSupabase(rows);
  console.log(`Upserted ${rows.length} rows to tiktok_ads_daily.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
