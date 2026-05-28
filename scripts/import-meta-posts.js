// import-meta-posts.js
// Fetches Meta Page post metrics and imports daily snapshots to Supabase social_posts_daily
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;
const FB_PAGE_ID = process.env.FB_PAGE_ID;
const FB_PAGE_NAME = process.env.FB_PAGE_NAME || process.env.FACEBOOK_PAGE_NAME || null;

const DEFAULT_DAYS_BACK = Number(process.env.META_POSTS_DAYS_BACK || 30);

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !FB_ACCESS_TOKEN || !FB_PAGE_ID) {
  console.error('Missing env vars. Set SUPABASE_URL, SUPABASE_SERVICE_KEY, FB_ACCESS_TOKEN, FB_PAGE_ID');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function toNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
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
    since,
    until,
    sinceStr: since.toISOString().slice(0, 10),
    untilStr: until.toISOString().slice(0, 10),
  };
}

async function fetchPagePosts() {
  let url = `https://graph.facebook.com/v18.0/${FB_PAGE_ID}/posts` +
    `?fields=id,created_time,message,permalink_url,type,shares,reactions.summary(total_count),comments.summary(total_count),insights.metric(post_impressions,post_impressions_unique,post_engaged_users,post_clicks,post_video_views)` +
    `&limit=100` +
    `&access_token=${FB_ACCESS_TOKEN}`;

  const all = [];
  let page = 0;

  while (url) {
    page += 1;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Meta posts API error: ${res.status} ${body}`);
    }
    const payload = await res.json();
    all.push(...(payload.data || []));
    url = payload.paging?.next || null;
  }

  console.log(`Fetched ${all.length} posts across ${page} page(s).`);
  return all;
}

function getInsightValue(post, metricName) {
  const metrics = post.insights?.data || [];
  const entry = metrics.find((m) => m.name === metricName);
  if (!entry) return 0;
  const first = Array.isArray(entry.values) && entry.values.length ? entry.values[0] : null;
  if (!first) return 0;
  return toNumber(first.value);
}

function normalizeRows(posts, since, until) {
  const snapshotDay = new Date().toISOString().slice(0, 10);

  return posts
    .filter((post) => {
      const created = new Date(post.created_time || 0);
      if (Number.isNaN(created.getTime())) return false;
      return created >= since && created <= until;
    })
    .map((post) => {
      const likes = toNumber(post.reactions?.summary?.total_count);
      const comments = toNumber(post.comments?.summary?.total_count);
      const shares = toNumber(post.shares?.count);
      const engagements = getInsightValue(post, 'post_engaged_users');
      return {
        day: snapshotDay,
        platform: 'meta',
        account_id: FB_PAGE_ID,
        account_name: FB_PAGE_NAME || `Meta Page ${FB_PAGE_ID}`,
        post_id: post.id,
        post_url: post.permalink_url || null,
        post_text: post.message || null,
        post_type: post.type || null,
        published_at: post.created_time || null,
        impressions: Math.round(getInsightValue(post, 'post_impressions')),
        reach: Math.round(getInsightValue(post, 'post_impressions_unique')),
        video_views: Math.round(getInsightValue(post, 'post_video_views')),
        clicks: Math.round(getInsightValue(post, 'post_clicks')),
        likes: Math.round(likes),
        comments: Math.round(comments),
        shares: Math.round(shares),
        saves: 0,
        engagements: Math.round(engagements || likes + comments + shares),
        created_at: new Date().toISOString(),
      };
    });
}

async function upsertRows(rows) {
  if (!rows.length) return;
  const { error } = await supabase
    .from('social_posts_daily')
    .upsert(rows, { onConflict: 'day,platform,post_id' });

  if (error) throw error;
}

async function main() {
  const { since, until, sinceStr, untilStr } = parseDateArgs();
  console.log(`Fetching Meta posts published from ${sinceStr} to ${untilStr}`);

  const posts = await fetchPagePosts();
  if (!posts.length) {
    console.log('No posts returned.');
    return;
  }

  const rows = normalizeRows(posts, since, until);
  if (!rows.length) {
    console.log('No posts matched the selected publish-date range.');
    return;
  }

  await upsertRows(rows);
  console.log(`Upserted ${rows.length} rows to social_posts_daily.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
