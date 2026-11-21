# Site-wide custom code: notes

The code Webflow serves (Site settings → Custom code) is kept comment-free so every
visitor isn't downloading ~15 KB of notes on every page. The deployed copies are
`site-head.html` and `site-footer.html` in this folder; they must stay identical to
what is in Webflow.

This file keeps the **annotated** versions: the same code with every explanation of
why it exists, what the Designer owns, and what must not be undone. Read these before
changing anything; when you change the deployed code, update the annotated copy too.

The light-mode theme switcher that used to sit (commented out) at the end of the
head block is preserved in the annotated head below. It was inert; re-enable it by
copying it back without the comment wrapper.

## HEAD (annotated)

```html
<!-- Christ the King — Site settings → Custom code → HEAD
     Post-narthex-migration state. See narthex docs/migration-christtheking.md.

     What used to be here and is now narthex:
       - the .navbar height measurer that wrote --nav-height
         → vci-nav="header" vci-nav-height-var="--nav-height" on nav.navbar
       - html { scroll-padding-top: … }
         → vci-scroll="native" + vci-scroll-offset on the footer script tag

     What is left is genuinely site-specific: the sticky-menu scrollspy. narthex
     has no scrollspy, and .sticky-menu-nav-item.is-current is this site's own
     active state. The jump-link preventDefault that used to live alongside it
     is gone too — vci-scroll="native" is what takes Webflow's jQuery anchor
     handler out of the way now, and the browser does the scrolling, which
     respects scroll-padding-top and prefers-reduced-motion for free. -->

<!-- ===========================================================
LIGHT MODE / THEME SWITCHER — DISABLED
Re-enable by removing this comment wrapper (this line,
the opening line above, and the closing line at the bottom).
===========================================================

<style>
/* Smooth transitions on mode swap */
body {
transition: background-color 0.2s ease, color 0.2s ease;
}
</style>
<script>
(function() {
function applyInitialTheme() {
// Strip any leftover from Designer/server
document.body.classList.remove('theme-light');

var saved = localStorage.getItem('ctk-theme');
var systemPrefersLight = window.matchMedia &&
window.matchMedia('(prefers-color-scheme: light)').matches;
var initial = saved || (systemPrefersLight ? 'light' : 'dark');

if (initial === 'light') {
document.body.classList.add('theme-light');
}
}

if (document.body) {
applyInitialTheme();
} else {
document.addEventListener('DOMContentLoaded', applyInitialTheme);
}
})();
document.addEventListener('DOMContentLoaded', function() {
document.querySelectorAll('[data-theme-toggle]').forEach(function(btn) {
btn.addEventListener('click', function() {
var isLight = document.body.classList.toggle('theme-light');
localStorage.setItem('ctk-theme', isLight ? 'light' : 'dark');
});
});
});
</script>

-->

<!-- ===========================================================
     STICKY-MENU SCROLLSPY
     Why custom code: the active state needs JS. The Designer style
     panel still owns all appearance:
       - "nav-height" site variable = 4.5rem fallback (used when
         narthex hasn't measured yet, e.g. on the Designer canvas)
       - .sticky-menu top = calc(var(--nav-height) + gutter)
       - .sticky-menu-nav-item.is-current = active link style
     narthex writes --nav-height (header height) and --nav-offset
     (the header's live bottom edge, which drops as the announcement
     bar scrolls away). The spy uses the offset when it is there.
     =========================================================== -->
<script>
(function () {
  'use strict';
  function init() {
    var menu = document.querySelector('.sticky-menu');
    // Pages with their own jump-menu tracker (Beliefs, Elder Affirmation:
    // [data-jump-toggle]) mark the active link themselves as .is-active.
    // Running this too lit two different links, one row apart.
    if (!menu || document.querySelector('[data-jump-toggle]')) return;

    var map = [];
    menu.querySelectorAll('a[href^="#"]').forEach(function (a) {
      var target = document.getElementById(a.getAttribute('href').slice(1));
      if (target) map.push({ link: a, target: target });
    });
    if (!map.length) return;

    function headerOffset() {
      var v = parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--nav-offset'));
      if (!isNaN(v)) return v;
      var n = document.querySelector('.navbar');
      return n ? n.offsetHeight : 72;
    }

    var current = null;
    function spy() {
      var offset = headerOffset() + 32;
      var active = map[0];
      map.forEach(function (m) {
        if (m.target.getBoundingClientRect().top <= offset) active = m;
      });
      if (active === current) return;
      current = active;
      map.forEach(function (m) {
        m.link.classList.toggle('is-current', m === active);
      });
    }
    window.addEventListener('scroll', spy, { passive: true });
    window.addEventListener('resize', spy);
    spy();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>

<!-- ===========================================================
     AUDIT FIXES 2026-10-13 (Claude, approved by Josh)
     Why custom code: neither rule can be written in the style panel.
       1. .media-card:hover .media-card-background is a descendant-hover
          selector. It used to live as an HTML embed INSIDE the media-card
          component, so every card on the media page shipped its own copy
          (140+ <style> tags). One copy here, embed removed from the component.
       2. scroll-margin-top below 992px: the sticky jump-menu bar
          (.sticky-menu-wrap) sits under the header on tablet/phone, so a
          jump target needs extra clearance there or its heading lands
          under the bar. narthex's vci-scroll-offset is one value for all
          widths; this adds the bar's height only where the bar exists.
       3. -webkit-tap-highlight-color (the style panel rejects the
          property): mobile browsers paint a translucent box over whatever
          is tapped — gray on iOS — which flashed as an outline around the
          mobile menu's dropdown rows on every open and close. The site's
          own hover/active states are the tap feedback; keyboard focus
          rings are unaffected.
     =========================================================== -->
<style>
@media (hover: hover) and (pointer: fine) {
  .media-card .media-card-background {
    transition: opacity 100ms ease, transform 150ms ease;
  }
  .media-card:hover .media-card-background {
    opacity: 1;
    transform: scale(1);
  }
}

@media (max-width: 991px) {
  .numbered-content {
    scroll-margin-top: 4rem;
  }
}

html {
  -webkit-tap-highlight-color: transparent;
}
</style>

<!-- ===========================================================
     NAMES IN A RUN: "A", "A and B", "A, B, and C" (Oxford comma)
     Why custom code: a card's contributors are a nested Collection
     List, one item per person, and where the separators go depends
     on each item's position - which only a structural selector
     knows. The list's word-sized gap (.contributor_list-card,
     style panel) is the space after each comma. The same style is
     what the sync writes into a media item's speaker-text
     (speakerText in lib/parse.js). The "and" is quieter than the
     names (text-03).
     =========================================================== -->
<style>
.contributor_list-card > .w-dyn-item:not(:last-child) > *::after {
  content: ",";
}
.contributor_list-card > .w-dyn-item:first-child:nth-last-child(2) > *::after {
  content: none;
}
.contributor_list-card > .w-dyn-item:last-child:not(:first-child) > *::before {
  content: "and ";
  color: var(--_theme---text-03);
}
</style>

<!-- ===========================================================
     TAP FEEDBACK ON iOS
     The style panel's Pressed (:active) states - series playlist
     rows and the jump-menu links at tablet down - only show on iOS
     Safari once the page has a touchstart listener somewhere; without
     one, :active never applies to a tap. This is that listener. It
     does nothing and is passive, so scrolling is unaffected.
     =========================================================== -->
<script>
document.addEventListener('touchstart', function () {}, { passive: true });
</script>

<!-- ===========================================================
     AUDIT FIXES 2026-11-20 (Claude, approved by Josh)
       1. Empty transcript: hide the transcript panel (desktop sidebar /
          phone drawer) and its preview box when the item has no
          transcript yet. Why custom code: visibility can only bind to a
          Switch field through the API, and Webflow marks an empty bound
          Rich Text with .w-dyn-bind-empty, which only a :has() selector
          can see from the panel. Transcripts arrive later (YouTube
          blocks captions from CI), so the panel comes back by itself.
       2. Checkboxes (Connect form, Media/Study Tools filter dropdowns):
          the unchecked box was the browser's white default on the dark
          inputs. appearance:none and the ::before check mark can't be
          set in the style panel. Border is text-03, not border-02, so
          the box keeps 3:1 contrast against the background. The Type
          pills (.is-pills) are hidden inputs and are left alone.
     =========================================================== -->
<style>
.media-content_wrap:has([data-transcript].w-dyn-bind-empty) :is(.media-secondary, [data-transcript-preview]) {
  display: none !important;
}

.form_checkbox-input,
.media-filters_checkbox:not(.is-pills) {
  -webkit-appearance: none;
  appearance: none;
  display: inline-grid;
  place-content: center;
  border: 2px solid var(--_theme---text-03);
  border-radius: .25rem;
  background-color: transparent;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.form_checkbox-input:checked,
.media-filters_checkbox:not(.is-pills):checked {
  background-color: var(--_theme---accent-01);
  border-color: var(--_theme---accent-01);
}
.form_checkbox-input:checked::before,
.media-filters_checkbox:not(.is-pills):checked::before {
  content: "";
  width: .6rem;
  height: .6rem;
  background-color: var(--_theme---background-01);
  clip-path: polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%);
}
.form_checkbox-input:focus-visible,
.media-filters_checkbox:not(.is-pills):focus-visible {
  outline: 2px solid var(--_theme---accent-01);
  outline-offset: 2px;
}
@media (hover: hover) {
  .form_checkbox-input:hover,
  .media-filters_checkbox:not(.is-pills):hover {
    border-color: var(--_theme---accent-01);
  }
}
</style>
```

## FOOTER (annotated)

```html
<!-- Christ the King — Site settings → Custom code → FOOTER
     Post-narthex-migration state. See narthex docs/migration-christtheking.md.

     What used to be here and is now narthex:
       - the ~200-line modal/drawer IIFE (data-modal-open, data-modal-close,
         .modal-dim, ?modal= deep links, swipe-to-dismiss)
         → the modal module, via vci-modal="dialog|open|close|dim|title"
     Also retired alongside it: the applied registered script
     "faq_accordion_toggle" → the accordion module. It must stay retired: with
     both engines applied, each FAQ row is toggled twice per click and will
     not close.

     What is left is presentation, and stays. -->

<!-- Pin a tag that exists. jsDelivr resolves @<tag> against the repo's git
     tags and 404s anything else — silently, as far as the page is concerned:
     no narthex, so no mobile menu. v0.2.0 was the example version in the
     narthex README's release section and was never cut; the tags are v0.1.0,
     v0.1.1, v0.4.0, v0.5.0, v0.5.1, v0.5.2. -->
<script src="https://cdn.jsdelivr.net/gh/volentecreative/narthex@v0.5.2/dist/narthex.min.js"
        vci-scroll="native"
        vci-scroll-offset="calc(var(--nav-height, 4.5rem) + 1.5rem)"></script>

<script>
(() => {
  const style = document.createElement('style');

  style.textContent = `
    .parallax-5,
    .parallax-10,
    .parallax-20 {
      animation-name: cf-parallax-y;
      animation-duration: 1ms;
      animation-timing-function: linear;
      animation-fill-mode: both;
      animation-timeline: view();
      animation-range: entry 0% exit 100%;
      will-change: transform;
    }

    .parallax-5 {
      --parallax-distance: 5%;
    }

    .parallax-10 {
      --parallax-distance: 10%;
    }

    .parallax-20 {
      --parallax-distance: 20%;
    }

    @keyframes cf-parallax-y {
      from {
        transform: translateY(calc(var(--parallax-distance) * -1));
      }

      to {
        transform: translateY(var(--parallax-distance));
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .parallax-5,
      .parallax-10,
      .parallax-20 {
        animation: none;
        transform: none;
      }
    }

    /* No parallax on phones (Webflow's mobile breakpoints, 767px down):
       the image sits still and fills the hero. !important because the hero
       component carries its own copy of the rules above (.parallax-handler
       embed), injected earlier, and this must win over both. */
    @media (max-width: 767px) {
      .parallax-5,
      .parallax-10,
      .parallax-20 {
        animation: none !important;
        transform: none !important;
        will-change: auto;
      }
    }
  `;

  document.head.appendChild(style);
})();
</script>

<style>
/* Nav dropdowns opening AND closing, in place of the deleted Interactions.

   Webflow's dropdown JS is left alone: it toggles w--open and nothing else.
   What made the close instant is its `.w-dropdown-list { display: none }` —
   the element stops being rendered the moment the class comes off, so there
   is nothing left to animate. `transition-behavior: allow-discrete` is the
   answer: display still flips, but not until the rest of the transition has
   finished, so the list is on screen for the whole way out.

   Desktop fades. Below 992px the list is `position: static` in the flow of the
   mobile panel, where the same appearance has to be a slide: a 0fr → 1fr grid
   row animates to a height nobody has measured. The collapsed values sit on
   :not(.w--open) so the open state says nothing about padding or border, and
   the Designer's own values are what it animates back to — nothing from the
   style panel is copied into this file to drift out of date. */
@media (min-width: 992px) {
  .nav_dropdown-list.w-dropdown-list {
    opacity: 0;
    transition: opacity 200ms ease-out, display 200ms allow-discrete;
  }

  .nav_dropdown-list.w-dropdown-list.w--open {
    opacity: 1;
  }

  @starting-style {
    .nav_dropdown-list.w-dropdown-list.w--open { opacity: 0; }
  }

  /* The fade is for the first open and the last close only. Moving from one
     item to the next, Webflow opens the new list and closes the old in the
     same moment; fading the old one out kept both on screen, and Learn's
     full-width list, later in the DOM, covered Connect's while it faded in.
     While another list is open, a closing one goes at once. */
  .navbar_menu:has(.w-dropdown-list.w--open) .nav_dropdown-list.w-dropdown-list:not(.w--open) {
    transition: none;
  }

  /* A list on its way out never catches the cursor (which could reopen it)
     or covers the open one. */
  .nav_dropdown-list.w-dropdown-list:not(.w--open) { pointer-events: none; }
  .nav_dropdown-list.w-dropdown-list.w--open { z-index: 2; }
}

/* The chevron flips at every width: the mobile menu's toggles get w--open
   from the same dropdown JS as desktop's. */
.navbar_dropdown-toggle .chevron_down {
  transition: transform 200ms ease-out;
}

.navbar_dropdown-toggle.w--open .chevron_down {
  transform: rotate(180deg);
}

/* Mobile easing front-loads the motion so a tap answers at once: opening one
   item closes the other, and with plain ease-out both crawled through their
   first frames together. */
@media (max-width: 991px) {
  .navbar_dropdown-toggle .chevron_down {
    transition: transform 240ms cubic-bezier(.22, 1, .36, 1);
  }

  .nav_dropdown-list.w-dropdown-list {
    transition: grid-template-rows 240ms cubic-bezier(.22, 1, .36, 1),
                padding 240ms cubic-bezier(.22, 1, .36, 1),
                border-width 240ms cubic-bezier(.22, 1, .36, 1),
                display 240ms allow-discrete;
  }

  .nav_dropdown-list.w-dropdown-list:not(.w--open) {
    grid-template-rows: 0fr;
    padding-top: 0;
    padding-bottom: 0;
    border-top-width: 0;
    border-bottom-width: 0;
  }

  .nav_dropdown-list.w-dropdown-list.w--open {
    display: grid;
    grid-template-rows: 1fr;
  }

  /* Coming out of display:none there is no before-state to transition from,
     so the opening slide needs its start written out. Only zeros here — the
     end of the slide is still whatever the Designer computes. */
  @starting-style {
    .nav_dropdown-list.w-dropdown-list.w--open {
      grid-template-rows: 0fr;
      padding-top: 0;
      padding-bottom: 0;
      border-top-width: 0;
      border-bottom-width: 0;
    }
  }

  /* A row can only collapse if what sits in it may be clipped — and only as
     far as its own padding allows. The link list carries 12px top and bottom,
     which held the closing row at 24px (a strip of the list's background) and
     then let it snap to nothing when display flipped. Its padding slides to
     zero with the row. */
  .nav_dropdown-list.w-dropdown-list > * {
    overflow: hidden;
    min-height: 0;
    transition: padding 240ms cubic-bezier(.22, 1, .36, 1);
  }

  .nav_dropdown-list.w-dropdown-list:not(.w--open) > * {
    padding-top: 0;
    padding-bottom: 0;
  }

  @starting-style {
    .nav_dropdown-list.w-dropdown-list.w--open > * {
      padding-top: 0;
      padding-bottom: 0;
    }
  }
}

/* Full-width buttons where a phone has a whole row to give them: the mobile
   menu's Connect / Get directions bar, and a filter drawer's Clear filters /
   Apply pair. The button component is fit-content everywhere else, so this is
   scoped by container rather than set on the component's own classes. Two
   buttons share a row while each keeps 10rem; narrower than that they stack.
   (In the drawer each button sits in a wrapper carrying its behaviour:
   fs-list-element="clear" or vci-modal="close".) */
@media (max-width: 991px) {
  .filter-drawer_component .button-wrap {
    flex-wrap: nowrap;
  }

  .navbar_menu-actions > .button,
  .filter-drawer_component .button-wrap > * {
    flex: 1 1 10rem;
    min-width: 0;
  }

  .navbar_menu-actions > .button,
  .filter-drawer_component .button-wrap > * > .button,
  .navbar_menu-actions > .button > .button-type,
  .filter-drawer_component .button-wrap .button-type {
    width: 100%;
  }

  .navbar_menu-actions > .button > .button-type,
  .filter-drawer_component .button-wrap .button-type {
    justify-content: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .nav_dropdown-list.w-dropdown-list,
  .nav_dropdown-list.w-dropdown-list > * { transition: none; }
  .navbar_dropdown-toggle .chevron_down { transition: none; }
}
</style>

<script>
/* Hold the list's open box for the length of the close fade.

   The Designer owns the list's position in both states, and the two differ:
   the base style and the Open state can each set their own left/right. The
   fade-out runs after w--open comes off, so for those 200ms the list would
   wear the base geometry while still visible — a jump before the fade.

   Nothing here decides where the list goes. On open, the values the Designer
   computed are read; on close, they are written back inline for the
   transition and removed when it ends. Change alignment in the Designer. */
(() => {
  const desktop = matchMedia('(min-width: 992px)');
  const PROPS = ['top', 'right', 'bottom', 'left', 'transform'];

  document.querySelectorAll('.nav_dropdown-list.w-dropdown-list').forEach((list) => {
    let open = list.classList.contains('w--open');
    let held = null;
    let timer = 0;

    /* transitionend bubbles, and every link inside the list has its own 200ms
       hover transition. Ending the hold on any of them drops the geometry at
       whatever moment the pointer last crossed a link, which is the jump this
       exists to prevent. Only the list's own opacity fade counts. release() is
       also called bare on open and by the timer below, so no event at all
       still means release now. */
    const release = (event) => {
      if (event && (event.target !== list || event.propertyName !== 'opacity')) return;
      clearTimeout(timer);
      PROPS.forEach((prop) => list.style.removeProperty(prop));
      list.removeEventListener('transitionend', release);
    };

    new MutationObserver(() => {
      const now = list.classList.contains('w--open');
      if (now === open) return;
      open = now;
      if (!desktop.matches) return;

      if (now) {
        release();
        const cs = getComputedStyle(list);
        held = PROPS.map((prop) => cs.getPropertyValue(prop));
      } else if (held) {
        PROPS.forEach((prop, i) => list.style.setProperty(prop, held[i]));
        list.addEventListener('transitionend', release);
        timer = setTimeout(release, 400);
      }
    }).observe(list, { attributes: true, attributeFilter: ['class'] });
  });
})();
</script>

<script>
/* Close the nav dropdown when one of its links is clicked (desktop).

   Webflow's hover dropdown closes when the pointer leaves it, and a link that
   loads a new page takes the open state with it. But Contact (a mailto: link)
   and Sing Your Part (a new tab) leave this page where it is, with the list
   still open under the pointer. And a page restored by Back comes out of the
   browser's back/forward cache exactly as it was left - dropdown open.
   'w-close' is Webflow's own close event, so its classes and aria-expanded are
   reset the way its JS does it, and hovering the menu again opens it as usual. */
(() => {
  const close = () => {
    if (window.jQuery) jQuery('.navbar_menu .w-dropdown').trigger('w-close');
  };
  document.addEventListener('click', (e) => {
    if (e.target.closest('.nav_dropdown-list a[href]') && matchMedia('(min-width: 992px)').matches) close();
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) close(); });
})();
</script>

<script>
/* Media card dates: the year appears once a date is more than twelve months
   old. "Sep 1" is this year's; "Sep 1, 2025" is last year's.

   The Designer cannot do date arithmetic, so the card carries two copies of
   its Date: the visible one, formatted without a year, and a hidden one with
   the year (the "Sort date" prop, which Finsweet also sorts the media list
   on). This reads the hidden copy, and when it is older than the cutoff
   appends its year to the visible text. Nothing else about the format is
   touched, so the Designer still owns how the date reads.

   Cards arrive after load too - Finsweet's infinite load on the media page -
   so a MutationObserver picks up new ones. Each card is stamped once. */
(() => {
  const MONTHS = 12;

  const cutoff = () => {
    const d = new Date();
    d.setMonth(d.getMonth() - MONTHS);
    return d;
  };

  const stamp = (el) => {
    el.setAttribute('data-media-date-stamped', '');

    let scope = el.parentElement;
    let full = null;
    while (scope && !(full = scope.querySelector('[data-media-date-full]'))) {
      scope = scope.parentElement;
    }
    if (!full) return;

    const when = new Date(full.textContent.trim());
    if (isNaN(when) || when >= cutoff()) return;

    const year = String(when.getFullYear());
    const text = el.textContent.trim();
    if (text && text.indexOf(year) === -1) el.textContent = text + ', ' + year;
  };

  const run = () => {
    document.querySelectorAll('[data-media-date]:not([data-media-date-stamped])').forEach(stamp);
  };

  const start = () => {
    run();
    new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
</script>

<style>
/* Mobile menu: the hamburger becomes a close icon, and the dim takes taps.

   Both halves are narthex's doing — it puts its open class on the toggle and
   on the vci-nav="dim" element alongside the menu, and a click on the dim
   closes the menu with no code here. All that is left is what the Designer's
   style panel cannot say: pointer-events, and a descendant selector for the
   two bars.

   The bars are 3px tall with a 0.5rem gap, so half the distance between their
   centres is 0.25rem + 1.5px — that is what each has to travel to meet in the
   middle before rotating.

   The dim's own geometry is in the Designer. Two values there are load-bearing
   and easy to lose:

     top at medium = var(--nav-offset, 6rem), narthex's live measurement of the
       header's bottom edge, which drops as the announcement bar scrolls away.
       A fixed number cannot work — 6rem sits 42px above that edge while the
       bar is still on screen, which is the dim creeping over the header.

     z-index: -1, which keeps the dim behind the panel no matter where it sits
       in nav.navbar. Without it the dim only stays behind while it is the
       first child, and a backdrop that paints last covers the menu, its
       dropdowns and every link in it — the whole panel stops taking taps. It
       still catches taps below the panel, which is what closes the menu: the
       negative index is below the header's own content, not below the page. */
[vci-nav="dim"] {
  pointer-events: none;
}

[vci-nav="dim"].is-open {
  pointer-events: auto;
}

/* The panel itself. The Designer opens it by animating max-height and
   min-height (0 → the viewport below the header) under `transition: all`,
   and steps padding-top 0 → 1rem as it goes — a layout pass on every frame
   and a jump at the start, which is the jank. Here it keeps its open size
   while shut and is revealed instead: clip-path wipes it down from the header,
   with a short fade and a 0.5rem settle, all paint/compositor work. The sizes
   are the same values the Designer gives .navbar_menu.is-open. visibility
   waits for the wipe to finish on close, then takes the shut panel out of the
   tab order and away from taps. */
@media (max-width: 991px) {
  .navbar_menu {
    min-height: calc(100dvh - var(--nav-offset, 6rem));
    max-height: calc(100dvh - var(--nav-offset, 6rem));
    padding-top: 1rem;
    clip-path: inset(0 0 100% 0);
    opacity: 0;
    transform: translateY(-0.5rem);
    visibility: hidden;
    pointer-events: none;
    transition: clip-path 360ms cubic-bezier(.22, 1, .36, 1),
                transform 360ms cubic-bezier(.22, 1, .36, 1),
                opacity 200ms ease-out,
                visibility 0s linear 360ms;
  }

  .navbar_menu.is-open {
    clip-path: inset(0);
    opacity: 1;
    transform: none;
    visibility: visible;
    pointer-events: auto;
    transition-delay: 0s;
  }

  .navbar_hamburger_line {
    transition: transform 200ms ease-out;
  }

  .navbar_hamburger.is-open .navbar_hamburger_line:first-child {
    transform: translateY(calc(0.25rem + 1.5px)) rotate(45deg);
  }

  .navbar_hamburger.is-open .navbar_hamburger_line:last-child {
    transform: translateY(calc(-0.25rem - 1.5px)) rotate(-45deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .navbar_hamburger_line,
  .navbar_menu { transition: none; }
}
</style>

<style>
/* The Turnstile widget's wrapper div, hidden without removing it from the form.
   The closing brace was missing in the live block — browsers recover at the end
   of a stylesheet, so it worked, but nothing may be appended after it. */
.media-filter-form > div:has([name="cf-turnstile-response"]) {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
  pointer-events: none;
}
</style>
```
