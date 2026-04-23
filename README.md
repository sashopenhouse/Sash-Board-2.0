# NYS Analytics — Setup Guide

Three files. ~30 minutes to deploy.

---

## Files

| File | Purpose |
|---|---|
| `nys-track.js` | Tracking snippet — goes on every site |
| `supabase-schema.sql` | Run once in Supabase to create your tables |
| `index.html` | Your analytics dashboard — deploy to Vercel |

---

## Step 1 — Supabase setup

1. Go to **supabase.com** → your project → **SQL Editor → New query**
2. Paste the contents of `supabase-schema.sql` and click **Run**
3. Grab your keys from **Settings → API**:
   - **Project URL** (e.g. `https://abcxyz.supabase.co`)
   - **anon public** key → goes in `nys-track.js`
  - **service_role secret** key → store in Vercel env vars (keep private, never in client code)

---

## Step 2 — Configure the tracking snippet

Open `nys-track.js` and replace:

```js
const NYS_ENDPOINT = 'https://YOUR_SUPABASE_URL/rest/v1/events';
const NYS_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
```

Leave `NYS_SITE_ID = 'AUTO'` — it will detect the domain automatically.

---

## Step 3 — Add the snippet to each site

Add this one line before `</body>` on every site (main + all campaigns):

```html
<script src="https://YOUR_CDN_OR_DOMAIN/nys-track.js"></script>
```

**Hosting options for the snippet:**
- Upload to your existing web host and reference it from there
- Use a free CDN like jsDelivr or Cloudflare Pages
- Or inline the entire script in a `<script>` tag if you prefer

**For sites where you already fire GA events**, find the GA event calls (usually `gtag('event', ...)` or `dataLayer.push(...)`) and you can optionally call `window.nysTrack('event_name', {})` right alongside them — or just let the snippet auto-detect everything.

### Phone clicks
The snippet auto-detects `<a href="tel:...">` links — no changes needed if your phone numbers are already linked that way.

### Quote form
The snippet watches for `form submit` events. If your quote form is an embedded iframe or third-party widget (e.g. JotForm, Gravity Forms), add this to the form's "thank you" redirect URL:
```
?nys_conversion=quote_confirmed
```
The snippet checks for this on page load automatically.

### Prize wheel (newyorksashoffers.com)
Add `data-nys-action="spin"` and `data-nys-action="claim"` to your spin and claim buttons:
```html
<button id="spinBtn" data-nys-action="spin" data-nys-prize="10% Off">Spin</button>
```

---

## Step 4 — Configure and deploy the dashboard

Open `index.html` and update the CONFIG block near the bottom:

```js
const CONFIG = {
  API_BASE: '/api/query',
  DASHBOARD_PASSWORD: 'change-this-password',
};
```

**Deploy to Vercel:**
1. Deploy the repo to Vercel
2. Add env vars in Vercel Project Settings → Environment Variables:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_KEY`
3. Your dashboard URL is: `https://sash-board-2-0.vercel.app/`

> ⚠️ The service role key bypasses Row Level Security. Never put it in client code. Keep it in Vercel env vars only.

---

## Step 5 — Verify

After adding the snippet to a page, visit that page and then run this in your Supabase SQL Editor:

```sql
SELECT event_type, site_id, page_path, city, ts
FROM events
ORDER BY ts DESC
LIMIT 20;
```

You should see your page_view event appear within a few seconds.

## Local full-stack run (dashboard + /api/query)

Run this from the project root:

```bash
python local_server.py
```

Then open:

```text
http://127.0.0.1:8080
```

The local server serves `index.html` and also provides `/api/query`.

- If `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are set (or placed in `.env.local`), `/api/query` reads directly from Supabase.
- If they are not set, `/api/query` automatically proxies to `https://sash-board-2-0.vercel.app/api/query` so local UI still shows live data.

Example `.env.local`:

```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_KEY=YOUR_SERVICE_ROLE_KEY
PORT=8080
HOST=127.0.0.1
```

### If events stop appearing

- Open a tracked page with `?nys_debug=1` (or run `localStorage.setItem('nys_debug','1')` in DevTools), then click around and watch Console for `[nys-track]` errors.
- Tracking is intentionally blocked only on local/dev hosts (`localhost`, `127.0.0.1`, and `sash-board-2-0.vercel.app`). If your production site runs on a different host, it should still track.

## Meta Ads view setup

The dashboard now includes a separate **Meta Ads** tab.

1. Re-run `supabase-schema.sql` in Supabase SQL Editor (it adds `meta_ads_daily` and `v_meta_ads_daily_summary`)
2. Import your Meta daily export into `meta_ads_daily`
3. Open dashboard and switch to **Meta Ads** tab

Required columns for `meta_ads_daily` imports:

- `date` (date)
- `account_id`, `account_name`
- `campaign_id`, `campaign_name`
- `spend`, `impressions`, `clicks`, `leads`, `purchase_value`

Optional columns:

- `adset_id`, `adset_name`, `ad_id`, `ad_name`

If the Meta tab shows no rows, verify data exists:

```sql
SELECT date, account_name, campaign_name, spend, impressions, clicks, leads, purchase_value
FROM meta_ads_daily
ORDER BY date DESC
LIMIT 20;
```

---

## Adding more campaigns in future

1. Add the `<script>` tag to the new site — auto-detection handles the rest
2. Add a new `<option>` to the site filter dropdown in `index.html`

---

## Event types reference

| event_type | Fires when |
|---|---|
| `page_view` | Any page loads |
| `phone_click` | User clicks a `tel:` link |
| `form_submit` | Any form is submitted |
| `quote_confirmed` | Thank-you/confirmation page loads |
| `outbound_to_main` | User clicks a link to newyorksash.com from a campaign site |
| `chat_click` | User clicks a chat button |
| `prize_wheel_spin` | Spin button clicked |
| `prize_wheel_claim` | Claim button clicked |
| `click_map` | Click point captured for daily heatmap hotspots |

---

## Manual tracking (for custom buttons/events)

```js
// Fire any custom event from anywhere on the page:
window.nysTrack('appointment_booked', { service: 'windows', source: 'hero-cta' });
```
