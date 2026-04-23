-- ============================================================
-- NYS Analytics — Supabase Schema
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- ============================================================

-- ── Events table: every tracked action lands here ─────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Identity
  event_type    TEXT NOT NULL,           -- page_view | phone_click | form_submit | quote_confirmed | outbound_to_main | prize_wheel_spin | prize_wheel_claim | chat_click
  site_id       TEXT NOT NULL,           -- newyorksash-main | newyorksashoffers | upstatetoughny | etc.
  visitor_id    TEXT,                    -- persistent per browser
  session_id    TEXT,                    -- resets after 30min inactivity

  -- Page context
  page_url      TEXT,
  page_path     TEXT,
  page_title    TEXT,
  referrer      TEXT,

  -- UTM attribution
  utm_source    TEXT,
  utm_medium    TEXT,
  utm_campaign  TEXT,
  utm_content   TEXT,
  utm_term      TEXT,

  -- Geo / location
  city          TEXT,
  region        TEXT,
  country       TEXT,
  lat           NUMERIC(9,6),
  lon           NUMERIC(9,6),

  -- User journey
  journey_steps INT,
  journey_json  TEXT,                    -- JSON array of last 10 pages visited

  -- Event-specific metadata
  phone_number      TEXT,
  form_id           TEXT,
  form_class        TEXT,
  is_quote_form     BOOLEAN,
  destination_url   TEXT,
  link_text         TEXT,
  prize_label       TEXT,
  chat_label        TEXT,
  confirmation_url  TEXT,

  -- Device / browser
  user_agent    TEXT,
  screen_width  INT
);

-- Indexes for dashboard query performance
CREATE INDEX IF NOT EXISTS idx_events_ts         ON events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_site_id    ON events (site_id);
CREATE INDEX IF NOT EXISTS idx_events_event_type ON events (event_type);
CREATE INDEX IF NOT EXISTS idx_events_visitor    ON events (visitor_id);
CREATE INDEX IF NOT EXISTS idx_events_session    ON events (session_id);
CREATE INDEX IF NOT EXISTS idx_events_utm        ON events (utm_campaign, utm_source);

-- ── Convenience views ─────────────────────────────────────────────────────────

-- Daily site summary
CREATE OR REPLACE VIEW v_daily_summary AS
SELECT
  DATE(ts)                                       AS day,
  site_id,
  COUNT(*) FILTER (WHERE event_type = 'page_view')           AS page_views,
  COUNT(DISTINCT visitor_id) FILTER (WHERE event_type = 'page_view') AS unique_visitors,
  COUNT(*) FILTER (WHERE event_type = 'phone_click')         AS phone_clicks,
  COUNT(*) FILTER (WHERE event_type = 'form_submit')         AS form_submits,
  COUNT(*) FILTER (WHERE event_type = 'quote_confirmed')     AS quote_confirmations,
  COUNT(*) FILTER (WHERE event_type = 'outbound_to_main')    AS outbound_to_main,
  COUNT(*) FILTER (WHERE event_type = 'chat_click')          AS chat_clicks
FROM events
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

-- Campaign conversion funnel (last 30 days)
CREATE OR REPLACE VIEW v_campaign_funnel AS
SELECT
  site_id,
  COUNT(DISTINCT visitor_id)                                         AS total_visitors,
  COUNT(DISTINCT visitor_id) FILTER (WHERE event_type = 'outbound_to_main') AS clicked_to_main,
  COUNT(DISTINCT visitor_id) FILTER (WHERE event_type = 'phone_click')      AS phone_contacts,
  COUNT(DISTINCT visitor_id) FILTER (WHERE event_type = 'quote_confirmed')  AS quote_conversions,
  ROUND(
    100.0 * COUNT(DISTINCT visitor_id) FILTER (WHERE event_type = 'quote_confirmed')
    / NULLIF(COUNT(DISTINCT visitor_id), 0), 2
  )                                                                          AS conversion_rate_pct
FROM events
WHERE ts >= NOW() - INTERVAL '30 days'
GROUP BY site_id
ORDER BY total_visitors DESC;

-- Geographic distribution
CREATE OR REPLACE VIEW v_geo_summary AS
SELECT
  city,
  region,
  country,
  ROUND(AVG(lat)::NUMERIC, 4) AS lat,
  ROUND(AVG(lon)::NUMERIC, 4) AS lon,
  COUNT(*) FILTER (WHERE event_type = 'page_view')       AS page_views,
  COUNT(*) FILTER (WHERE event_type = 'quote_confirmed') AS conversions
FROM events
WHERE city IS NOT NULL
GROUP BY city, region, country
ORDER BY page_views DESC;

-- Meta ads daily import table (populate from your Meta export/ETL)
CREATE TABLE IF NOT EXISTS public.meta_ads_daily (
  id bigserial primary key,
  date date not null,
  account_id text,
  account_name text,
  campaign_id text,
  campaign_name text,
  adset_id text,
  adset_name text,
  ad_id text,
  ad_name text,
  spend numeric(12,2) default 0,
  impressions int default 0,
  clicks int default 0,
  leads int default 0,
  purchase_value numeric(12,2) default 0,
  created_at timestamptz default now()
);

CREATE INDEX IF NOT EXISTS idx_meta_ads_daily_date ON public.meta_ads_daily(date);
CREATE INDEX IF NOT EXISTS idx_meta_ads_daily_account ON public.meta_ads_daily(account_id);
CREATE INDEX IF NOT EXISTS idx_meta_ads_daily_campaign ON public.meta_ads_daily(campaign_id);

CREATE OR REPLACE VIEW public.v_meta_ads_daily_summary AS
SELECT
  date AS day,
  account_id,
  account_name,
  campaign_id,
  campaign_name,
  SUM(COALESCE(spend, 0))::numeric(12,2) AS spend,
  SUM(COALESCE(impressions, 0))::bigint AS impressions,
  SUM(COALESCE(clicks, 0))::bigint AS clicks,
  SUM(COALESCE(leads, 0))::bigint AS leads,
  SUM(COALESCE(purchase_value, 0))::numeric(12,2) AS purchase_value
FROM public.meta_ads_daily
GROUP BY 1,2,3,4,5;
-- Allow anonymous INSERT (the tracker fires without login)
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_anon_insert" ON events
  FOR INSERT TO anon
  WITH CHECK (true);

-- Dashboard reads via service_role key only (set in dashboard env vars)
-- No SELECT policy for anon — dashboard calls Supabase with your service key
-- which bypasses RLS automatically.

-- ── Quick test query ──────────────────────────────────────────────────────────
-- After adding the tracker to a page, run this to verify events are landing:
-- SELECT event_type, site_id, page_path, ts FROM events ORDER BY ts DESC LIMIT 20;
