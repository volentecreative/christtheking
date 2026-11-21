/* Christ the King — site analytics (GA4), lightweight and privacy-first.
 * Site settings → Custom code → Registered scripts, as `ctkAnalytics`, applied
 * site-wide in the footer with the attribute data-gtm-id="GTM-P8MDSVXL" (the
 * container holds the GA4 tag, G-BMXRT9BS26). Do not also add GA/GTM in
 * Site settings → Integrations: that would load it twice and ignore GPC.
 * Source of truth: webflow/registered/analytics.js.
 *
 * PRIVACY
 *   - Loads nothing at all when the browser sends Global Privacy Control or
 *     Do Not Track. No banner needed for that path: the visitor already said no.
 *   - GA4 does not store IPs. Turn Google Signals and ad personalization OFF
 *     in GA4 Admin (Data collection) — they are property settings now.
 *   - Never sends what anyone types. The Connect form reports field NAMES and
 *     counts only, and never which interests were ticked (that is religious
 *     information).
 *   - Event params are short labels built from the page (section, button
 *     text), not visitor data.
 *
 * EVENTS (GA4 → Reports → Engagement → Events; mark the * ones as key events)
 *   get_directions *      { location }            Get Directions taps (hero, nav, location section, footer…)
 *   connect_cta_click     { location, link_text } any link to /connect
 *   connect_page_view     { entry_location }      landing on /connect: which CTA brought them ('none' = typed/external)
 *   connect_form_start    { form, entry_location } first interaction with the Connect form
 *   connect_form_field    { form, field }         a field left with something in it (field name only)
 *   Drop-off = connect_form_start → connect_form_field (per field) →
 *   connect_form_success, as a GA4 funnel exploration. (No "abandon" event:
 *   the Google tag drops anything queued after the page is hidden, so it
 *   never arrived from phones.)
 *   connect_form_submit   { form, fields_completed, interests_count }
 *   connect_form_success *{ form, entry_location }
 *   connect_form_error    { form }
 *   give_click *          { location, destination }
 *   contact_click         { method: email|phone, location }
 *   media_play            { mode: watch|listen }  first play on a sermon page
 *   media_mode            { mode }                Listen/Watch switch
 *   page_view             (sent for the media player's in-place navigation, which GA cannot see)
 *   (Prefixed connect_ so they never mix with GA's own Enhanced Measurement
 *   form_start / form_submit, which fire for every form.)
 *   Outbound links, scroll, file downloads and site search come from GA4
 *   Enhanced Measurement (turn it on in the data stream settings).
 */
(function () {
  'use strict';
  var w = window, d = document, nav = navigator;
  var me = d.currentScript;
  var GTM_ID = (me && me.getAttribute('data-gtm-id')) || '';
  if (!/^GTM-[A-Z0-9]+$/.test(GTM_ID)) return;
  if (nav.globalPrivacyControl === true || nav.doNotTrack === '1' || w.doNotTrack === '1') return;
  if (w.ctkAnalytics) return;

  /* ---------- Google Tag Manager (holds the GA4 tag, G-BMXRT9BS26) ----------
     The container's Google tag sends the page_view and Enhanced Measurement;
     this file only adds events. No gtag('config') here, or every page view
     would be counted twice. Signals / ad personalization: off in GA4 Admin. */
  w.dataLayer = w.dataLayer || [];
  function gtag() { w.dataLayer.push(arguments); }
  w.gtag = w.gtag || gtag;
  w.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
  var s = d.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(GTM_ID);
  d.head.appendChild(s);

  // GA4's Google tag already flushes queued events with sendBeacon on unload,
  // so clicks that navigate away (Get Directions, Connect) still arrive.
  function send(name, params) { w.gtag('event', name, params || {}); }

  /* ---------- where on the page a click came from ---------- */
  function slug(t) {
    return String(t || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  }
  function locationOf(el) {
    if (el.closest('nav, .navbar')) return 'nav';
    if (el.closest('footer, .footer')) return 'footer';
    var sec = el.closest('section');
    if (!sec) return 'page';
    var cls = (sec.className.split(' ')[0] || '');
    if (cls && cls !== 'section') return slug(cls.replace(/^section[_-]?/, '')) || 'section';
    var h = sec.querySelector('h1, h2, h3, .text-style-eyebrow');
    return h ? slug(h.textContent) : 'section';
  }
  function textOf(a) { return (a.textContent || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60); }

  var ENTRY_KEY = 'ctk:connect-entry';
  function remember(v) { try { sessionStorage.setItem(ENTRY_KEY, v); } catch (e) {} }
  function recall() { try { return sessionStorage.getItem(ENTRY_KEY) || 'none'; } catch (e) { return 'none'; } }

  /* ---------- clicks ---------- */
  d.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var loc = locationOf(a);
    var path = href.replace(/^https?:\/\/(www\.)?christtheking\.build/, '').split(/[?#]/)[0];

    if (path === '/directions' || /google\.[^/]+\/maps|maps\.apple\.com|goo\.gl\/maps/.test(href)) {
      send('get_directions', { location: loc });
    } else if (path === '/connect') {
      remember(loc + (location.pathname === '/' ? '' : '@' + location.pathname));
      send('connect_cta_click', { location: loc, link_text: textOf(a) });
    } else if (/subsplash\.com\/.*give/.test(href) || path === '/give') {
      send('give_click', { location: loc, destination: path === '/give' ? 'give_page' : 'online_giving' });
    } else if (/^mailto:/i.test(href)) {
      send('contact_click', { method: 'email', location: loc });
    } else if (/^tel:/i.test(href)) {
      send('contact_click', { method: 'phone', location: loc });
    }
  }, true);

  /* ---------- Connect page: entry + form funnel ---------- */
  function connectFunnel() {
    var form = d.getElementById('connect-form');
    if (!form || form.__ctkTracked) return;
    form.__ctkTracked = true;
    var FORM = 'connect';
    var entry = recall();
    send('connect_page_view', { entry_location: entry });

    var started = false, done = {};
    function fieldName(el) {
      if (el.type === 'checkbox') return 'interests';
      var n = (el.getAttribute('data-name') || el.name || el.id || '').toLowerCase();
      return slug(n.replace(/^connect-/, '')) || 'field';
    }
    form.addEventListener('focusin', function (e) {
      var el = e.target;
      if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.type === 'submit' || el.type === 'hidden') return;
      if (!started) { started = true; send('connect_form_start', { form: FORM, entry_location: entry }); }
    });
    form.addEventListener('change', function (e) {
      var el = e.target, f = fieldName(el);
      var filled = el.type === 'checkbox' ? form.querySelectorAll('input[type=checkbox]:checked').length > 0 : String(el.value || '').trim() !== '';
      if (filled && !done[f]) { done[f] = true; send('connect_form_field', { form: FORM, field: f }); }
    });
    var failed = false;
    form.addEventListener('submit', function () {
      failed = false;
      send('connect_form_submit', {
        form: FORM,
        fields_completed: Object.keys(done).length,
        interests_count: form.querySelectorAll('input[type=checkbox]:checked').length
      });
    });
    // Webflow shows .w-form-done / .w-form-fail after its AJAX submit.
    var wrap = form.parentElement;
    var okEl = wrap && wrap.querySelector('.w-form-done'), failEl = wrap && wrap.querySelector('.w-form-fail');
    var reported = false;
    function check() {
      if (okEl && getComputedStyle(okEl).display !== 'none' && !reported) {
        reported = true; send('connect_form_success', { form: FORM, entry_location: entry });
        try { sessionStorage.removeItem(ENTRY_KEY); } catch (e) {}
      }
      if (failEl && !failed && getComputedStyle(failEl).display !== 'none') { failed = true; send('connect_form_error', { form: FORM }); }
    }
    if (wrap && w.MutationObserver) new MutationObserver(check).observe(wrap, { attributes: true, subtree: true, attributeFilter: ['style', 'class'] });
  }

  /* ---------- sermon player (window.ctkPlayer emits on document) ---------- */
  var played = false;
  d.addEventListener('ctk:player:play', function (e) {
    if (played) return; played = true;
    send('media_play', { mode: (e.detail && e.detail.mode) || 'watch' });
  });
  d.addEventListener('ctk:player:mode', function (e) { send('media_mode', { mode: (e.detail && e.detail.mode) || '' }); });
  // In-place navigation while audio plays: GA never sees a page load, so report it.
  d.addEventListener('ctk:player:navigate', function () {
    played = false;
    send('page_view', { page_location: location.href, page_title: d.title });
    setTimeout(connectFunnel, 0);
  });

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', connectFunnel);
  else connectFunnel();

  w.ctkAnalytics = { send: send };
})();
