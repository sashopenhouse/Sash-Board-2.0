/**
 * NYS Analytics Tracker v1.0
 * New York Sash — Custom Event Tracking
 *
 * Drop this snippet on every site (campaign + main).
 * Works alongside GA — fires independently to your Supabase endpoint.
 *
 * SETUP: Set NYS_ENDPOINT and NYS_SITE_ID before deploying.
 */

(function () {
  // ─── CONFIG ────────────────────────────────────────────────────────────────
  const NYS_ENDPOINT = 'https://iyywdyrspsiqhdnxsbzc.supabase.co/rest/v1/events'; // TODO: replace
  const NYS_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml5eXdkeXJzcHNpcWhkbnhzYnpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MjQ2ODUsImV4cCI6MjA5MTQwMDY4NX0.muOn2hQfAbIPDz5jWySWNJtiMUroBkT-M0vwZNQXlgo';                   // TODO: replace
  const NYS_SITE_ID  = 'AUTO'; // 'AUTO' = detect from hostname, or set manually
                                // e.g. 'newyorksash-main' | 'newyorksashoffers'
                                // | 'upstatetoughny' | 'newyorksash-adirondacks'
                                // | 'newyorksash-cooperstown' | 'energy-efficient-cny'
  // ───────────────────────────────────────────────────────────────────────────

  // ── Site ID auto-detection ──────────────────────────────────────────────────
  function isBlockedHost(host) {
    const blockedHosts = new Set([
      'localhost',
      '127.0.0.1',
      'sash-board-2-0.vercel.app',
    ]);
    return blockedHosts.has(host);
  }

  function isDebugEnabled() {
    try {
      const byQuery = new URLSearchParams(location.search).get('nys_debug') === '1';
      const byStorage = localStorage.getItem('nys_debug') === '1';
      return byQuery || byStorage;
    } catch {
      return false;
    }
  }

  function getSiteId() {
    if (NYS_SITE_ID !== 'AUTO') return NYS_SITE_ID;
    const host = location.hostname.replace('www.', '');
    const path = location.pathname;

    // Check for specific campaign paths on the main domain first
    if (host === 'newyorksash.com') {
      if (path.includes('energy-efficient')) return 'nys-campaign-energy';
      if (path.includes('bathroom-promo'))  return 'nys-campaign-bath';
      if (path.includes('window-offer'))    return 'nys-campaign-windows';
    }

    const map = {
      'newyorksash.com':              'newyorksash-main',
      'newyorksashoffers.com':        'newyorksashoffers',
      'upstatetoughny.com':           'upstatetoughny',
      'newyorksash-adirondacks.com':  'newyorksash-adirondacks',
      'newyorksash-cooperstown.com':  'newyorksash-cooperstown',
      'energy-efficient-cny.com':    'energy-efficient-cny',
    };
    return map[host] || host;
  }

  // ── UTM / referrer helpers ──────────────────────────────────────────────────
  function getUTM() {
    const p = new URLSearchParams(location.search);
    return {
      utm_source:   p.get('utm_source')   || null,
      utm_medium:   p.get('utm_medium')   || null,
      utm_campaign: p.get('utm_campaign') || null,
      utm_content:  p.get('utm_content')  || null,
      utm_term:     p.get('utm_term')     || null,
    };
  }

  // Persist UTM params across the session so conversion events keep attribution
  function getOrStoreUTM() {
    const key = 'nys_utm';
    const fresh = getUTM();
    const hasValues = Object.values(fresh).some(Boolean);
    if (hasValues) {
      sessionStorage.setItem(key, JSON.stringify(fresh));
      return fresh;
    }
    try { return JSON.parse(sessionStorage.getItem(key) || '{}'); } catch { return {}; }
  }

  // ── Session / visitor ID ────────────────────────────────────────────────────
  function getId(storageKey, len) {
    let id = localStorage.getItem(storageKey);
    if (!id) { id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(storageKey, id); }
    return id;
  }
  const visitorId = getId('nys_vid');

  function getSessionId() {
    const key = 'nys_sid';
    const tsKey = 'nys_sid_ts';
    const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 min
    const last = parseInt(localStorage.getItem(tsKey) || '0', 10);
    if (Date.now() - last > SESSION_TIMEOUT || !localStorage.getItem(key)) {
      const sid = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
      localStorage.setItem(key, sid);
    }
    localStorage.setItem(tsKey, Date.now().toString());
    return localStorage.getItem(key);
  }

  // ── Geo / location (async, best-effort) ─────────────────────────────────────
  // Uses a free IP geo API — no PII, city-level only
  let geoCache = null;
  async function getGeo() {
    if (geoCache) return geoCache;
    try {
      const r = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      geoCache = { city: d.city || null, region: d.region || null, country: d.country_name || null, lat: d.latitude || null, lon: d.longitude || null };
    } catch { geoCache = {}; }
    return geoCache;
  }

  // ── User journey tracking ───────────────────────────────────────────────────
  // Records pages visited this session in order, with timestamps
  function recordJourneyStep(page) {
    const key = 'nys_journey';
    let journey = [];
    try { journey = JSON.parse(sessionStorage.getItem(key) || '[]'); } catch {}
    journey.push({ page, ts: Date.now() });
    if (journey.length > 50) journey = journey.slice(-50); // cap at 50 steps
    sessionStorage.setItem(key, JSON.stringify(journey));
    return journey;
  }

  function getJourney() {
    try { return JSON.parse(sessionStorage.getItem('nys_journey') || '[]'); } catch { return []; }
  }

  // ── Core fire function ──────────────────────────────────────────────────────
  async function fire(eventType, meta = {}) {
    const utm  = getOrStoreUTM();
    const geo  = await getGeo();
    const sessionId = getSessionId();
    const journey   = getJourney();

    const payload = {
      event_type:   eventType,
      site_id:      getSiteId(),
      visitor_id:   visitorId,
      session_id:   sessionId,
      page_url:     location.href,
      page_path:    location.pathname,
      referrer:     document.referrer || null,
      ...utm,
      city:         geo.city    || null,
      region:       geo.region  || null,
      country:      geo.country || null,
      lat:          geo.lat     || null,
      lon:          geo.lon     || null,
      journey_steps: journey.length,
      journey_json: JSON.stringify(journey.slice(-10)), // last 10 steps
      user_agent:   navigator.userAgent,
      screen_width: screen.width,
      ts:           new Date().toISOString(),
      ...meta,
    };

    // Supabase requires headers, so always use fetch.
    const body = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json', 'apikey': NYS_ANON_KEY, 'Authorization': `Bearer ${NYS_ANON_KEY}`, 'Prefer': 'return=minimal' };
    fetch(NYS_ENDPOINT, { method: 'POST', headers, body, keepalive: true })
      .then((response) => {
        if (!response.ok && isDebugEnabled()) {
          console.warn('[nys-track] Event rejected', response.status, eventType, payload);
        }
      })
      .catch((error) => {
        if (isDebugEnabled()) {
          console.warn('[nys-track] Event failed', eventType, error);
        }
      });
  }

  // ── 1. Page view ────────────────────────────────────────────────────────────
  function trackPageView() {
    recordJourneyStep(location.pathname);
    fire('page_view', { page_title: document.title });
  }

  // ── 2. Phone number clicks ──────────────────────────────────────────────────
  function trackPhoneClicks() {
    document.addEventListener('click', function (e) {
      const a = e.target.closest('a[href^="tel:"]');
      if (!a) return;
      fire('phone_click', { phone_number: a.href.replace('tel:', ''), link_text: a.innerText.trim() });
    });
  }

  // ── 3. Quote form submission ────────────────────────────────────────────────
  // Matches common form patterns — adjust selectors to fit each site's markup
  function trackFormSubmissions() {
    // Approach A: watch for form submit events
    document.addEventListener('submit', function (e) {
      const form = e.target;
      if (!form || form.tagName !== 'FORM') return;

      // Skip if form is explicitly marked for manual tracking only
      if (form.hasAttribute('data-nys-ignore') || form.classList.contains('nys-ignore')) return;

      const id    = (form.id || '').toLowerCase();
      const cls   = (form.className || '').toLowerCase();
      const isQuote = /quote|estimate|contact|lead|request|free/i.test(id + ' ' + cls + ' ' + document.title);
      fire('form_submit', { form_id: form.id || null, form_class: form.className || null, is_quote_form: isQuote });
    });

    // Approach B: watch for Thank You / confirmation page navigation
    if (/thank|confirm|success|submitted/i.test(location.pathname + location.search + document.title)) {
      fire('quote_confirmed', { confirmation_url: location.href });
    }

    // Explicit conversion marker for custom confirmation redirects
    const conversionParam = new URLSearchParams(location.search).get('nys_conversion');
    if (conversionParam === 'bath_quiz_lead') {
      fire('bath_quiz_lead', { conversion_url: location.href, source: 'query_param' });
    }
  }

  // ── 3b. Bath quiz lead tracking ───────────────────────────────────────────
  // Catches quiz-style flows that may not fire standard form submit events.
  function trackBathQuizLeads() {
    const key = 'nys_bath_quiz_lead_sent';

    document.addEventListener('click', function (e) {
      const trigger = e.target.closest('[data-nys-bath-quiz-lead], .bath-quiz-submit, #bathQuizSubmit, [data-bath-quiz-submit]');
      if (!trigger) return;
      fire('bath_quiz_lead', {
        source: 'click',
        element_id: trigger.id || null,
        element_class: trigger.className || null,
        element_text: (trigger.innerText || '').trim().slice(0, 120) || null,
      });
    });

    const inBathQuizContext = /bath/i.test(location.pathname + location.search + document.title) && /quiz/i.test(location.pathname + location.search + document.title);
    const looksLikeConfirmation = /thank|confirm|success|submitted|complete|results/i.test(location.pathname + location.search + document.title);

    if (inBathQuizContext && looksLikeConfirmation && sessionStorage.getItem(key) !== '1') {
      sessionStorage.setItem(key, '1');
      fire('bath_quiz_lead', { source: 'confirmation_page', conversion_url: location.href });
    }
  }

  // ── 4. Prize wheel interactions (campaign-specific) ─────────────────────────
  // Fires when spin/claim buttons are clicked — harmless no-op on sites without them
  function trackPrizeWheel() {
    document.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-nys-spin], [data-nys-claim], .spin-btn, .claim-btn, #spinBtn, #claimBtn');
      if (!btn) return;
      const action = btn.dataset.nysAction || (btn.id.includes('claim') ? 'claim' : 'spin');
      fire('prize_wheel_' + action, { prize_label: btn.dataset.nysPrize || null });
    });
  }

  // ── 5. Chat button clicks ───────────────────────────────────────────────────
  function trackChatClicks() {
    document.addEventListener('click', function (e) {
      const el = e.target.closest('[data-nys-chat], .chat-btn, .live-chat, #chatBtn, [class*="chat-widget"]');
      if (!el) return;
      fire('chat_click', { chat_label: el.innerText?.trim().slice(0, 80) || null });
    });
  }

  // ── 6. Click heatmap points ─────────────────────────────────────────────────
  // Stores normalized click coordinates in link_text so dashboard can render hotspots
  let lastHeatTs = 0;
  function trackClickHeatmap() {
    document.addEventListener('click', function (e) {
      const target = e.target.closest('a, button, [role="button"], input[type="submit"], input[type="button"], .btn, [onclick]');
      if (!target) return;

      const now = Date.now();
      if (now - lastHeatTs < 400) return; // basic throttle
      lastHeatTs = now;

      const docWidth = Math.max(document.documentElement.scrollWidth || 0, document.body.scrollWidth || 0, window.innerWidth || 0);
      const docHeight = Math.max(document.documentElement.scrollHeight || 0, document.body.scrollHeight || 0, window.innerHeight || 0);
      const pageX = (window.scrollX || window.pageXOffset || 0) + e.clientX;
      const pageY = (window.scrollY || window.pageYOffset || 0) + e.clientY;
      const x = docWidth > 0 ? (pageX / docWidth) : 0;
      const y = docHeight > 0 ? (pageY / docHeight) : 0;
      const payload = {
        x: Number(x.toFixed(4)),
        y: Number(y.toFixed(4)),
        coord_space: 'document',
        doc_width: docWidth,
        doc_height: docHeight,
        path: location.pathname || '/',
        target: (target.tagName || '').toLowerCase(),
        text: (target.innerText || target.value || '').trim().slice(0, 80),
      };

      fire('click_map', { link_text: JSON.stringify(payload) });
    }, { passive: true });
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  function init() {
    const host = location.hostname.replace('www.', '');
    if (isBlockedHost(host)) return;
    trackPageView();
    trackPhoneClicks();
    trackFormSubmissions();
    trackBathQuizLeads();
    trackPrizeWheel();
    trackChatClicks();
    trackClickHeatmap();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose manual fire for inline onclick handlers: nysTrack('custom_event', {key:'val'})
  window.nysTrack = fire;
})();
