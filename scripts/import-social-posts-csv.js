// import-social-posts-csv.js
// Imports organic post metrics from CSV into social_posts_daily
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing env vars. Set SUPABASE_URL and SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function parseArgs() {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : null;
  };

  const positionalFile = args.find((a) => a && !a.startsWith('--'));
  const filePathArg = getArg('--file') || positionalFile;
  if (!filePathArg) {
    throw new Error('Missing --file path/to/file.csv');
  }

  return {
    filePath: path.resolve(process.cwd(), filePathArg),
    day: getArg('--day') || new Date().toISOString().slice(0, 10),
    platformDefault: (getArg('--platform') || '').toLowerCase(),
    accountNameDefault: getArg('--account-name') || null,
    accountIdDefault: getArg('--account-id') || null,
  };
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === ',' && !inQuotes) {
      out.push(cur.trim());
      cur = '';
      continue;
    }

    cur += ch;
  }

  out.push(cur.trim());
  return out;
}

function toNumber(value) {
  const n = Number(String(value || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function normalizePlatform(value, fallback) {
  const v = String(value || fallback || '').toLowerCase().trim();
  if (!v) return 'unknown';
  return v;
}

function normalizeDate(value, fallback) {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toISOString().slice(0, 10);
}

function getValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  return null;
}

function parseCsv(text) {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ''; });
    return row;
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
  const args = parseArgs();
  const text = fs.readFileSync(args.filePath, 'utf8');
  const parsed = parseCsv(text);

  if (!parsed.length) {
    console.log('No CSV rows found.');
    return;
  }

  const rows = parsed.map((r) => {
    const platform = normalizePlatform(getValue(r, ['platform']), args.platformDefault);
    const postId = getValue(r, ['post_id', 'id']);
    if (!postId) return null;

    const likes = toNumber(getValue(r, ['likes']));
    const comments = toNumber(getValue(r, ['comments']));
    const shares = toNumber(getValue(r, ['shares']));
    const saves = toNumber(getValue(r, ['saves']));
    const engagementsFromCsv = getValue(r, ['engagements']);
    const engagements = engagementsFromCsv !== null ? toNumber(engagementsFromCsv) : (likes + comments + shares + saves);

    return {
      day: normalizeDate(getValue(r, ['day', 'date', 'snapshot_day']), args.day),
      platform,
      account_id: getValue(r, ['account_id', 'profile_id']) || args.accountIdDefault,
      account_name: getValue(r, ['account_name', 'profile_name']) || args.accountNameDefault,
      post_id: String(postId),
      post_url: getValue(r, ['post_url', 'url', 'permalink_url']),
      post_text: getValue(r, ['post_text', 'caption', 'message', 'title']),
      post_type: getValue(r, ['post_type', 'type']),
      published_at: getValue(r, ['published_at', 'created_time', 'post_time']),
      impressions: Math.round(toNumber(getValue(r, ['impressions']))),
      reach: Math.round(toNumber(getValue(r, ['reach']))),
      video_views: Math.round(toNumber(getValue(r, ['video_views', 'views']))),
      clicks: Math.round(toNumber(getValue(r, ['clicks', 'post_clicks']))),
      likes: Math.round(likes),
      comments: Math.round(comments),
      shares: Math.round(shares),
      saves: Math.round(saves),
      engagements: Math.round(engagements),
      created_at: new Date().toISOString(),
    };
  }).filter(Boolean);

  if (!rows.length) {
    console.log('No usable rows after normalization (missing post_id).');
    return;
  }

  await upsertRows(rows);
  console.log(`Upserted ${rows.length} rows to social_posts_daily.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
