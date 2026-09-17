# Webflow custom code

The site's front-end behaviour, version-controlled. Webflow is the source of
truth for what is *live*; this folder is the source of truth for what it
*should* say, so a change is reviewable instead of only existing in a textarea
in the Designer.

| File | Where it goes |
| --- | --- |
| `site-head.html` | Site settings → Custom code → **Head** |
| `site-footer.html` | Site settings → Custom code → **Footer** |
| `registered/navbar-speaker-names.js` | Site settings → Custom code → **Registered scripts**, as `navbarSpeakerNames` |

The two custom-code blocks are the **post-migration** state: the shared
behaviour has moved to [narthex](https://github.com/volentecreative/narthex),
and what is left here is the part that is genuinely this site's own. Since
2026-09-12 that is also what the site serves — see below.

## Why the mobile menu did not open (2026-09-12)

The Designer half of the migration was live; the code half never landed. Two
things were in the way — the first was enough on its own:

1. **The narthex tag is not on the site.** Site settings → Custom code still
   holds the pre-migration Head and Footer verbatim — the `.navbar` height
   measurer, the jump-link handler, the ~200-line modal IIFE — and no
   `<script src="…narthex…">` anywhere. The attributes below it are applied and
   published (`vci-nav="header"` on `nav.navbar`, `"menu"` on `.navbar_menu`,
   `"toggle"` on `.navbar_hamburger`), so the markup is asking for a nav module
   that never arrives, and nothing toggles `.navbar_menu.is-open`.
2. **The version pinned here did not exist.** `site-footer.html` asked for
   `narthex@v0.2.0`, copied from the example in the narthex README's release
   section — a tag that was never cut (the repo has v0.1.0, v0.1.1, v0.4.0,
   v0.5.0, v0.5.1). Pasting the footer as it stood would have swapped one dead
   menu for another: jsDelivr 404s an unknown tag, and the page carries on
   without narthex. Now pinned to `v0.5.1`, whose nav roles and settings are
   the ones this site's attributes already use.

It reads as a touch-device bug because the hamburger is the only way in and it
only exists there: `.navbar_hamburger` is `display: none` at base and
`display: flex` from `medium` down. There is nothing to click on a desktop, so
the only report comes from a phone.

Checked against the site's own markup and styles, as the Data API reports them
today, in Chromium at 390 × 844 with touch emulation: with no script tag and
with the 404 tag, a tap leaves the menu at `max-height: 0`; with narthex
loading, the same tap adds `is-open` and the menu opens.

### Made live, 2026-09-12

1. `site-head.html` into Head and `site-footer.html` into Footer, replacing the
   pre-migration blocks. The site is now on the state this folder describes,
   so the two are in step for the first time.
2. `faq_accordion_toggle` removed from the site's applied scripts in the same
   pass. The accordion roles were already on the FAQ elements, so it and
   narthex would both have toggled every row. `navbarSpeakerNames` stays.
3. `cursor: pointer` added to `.navbar_hamburger` in the Designer. iOS Safari
   uses that property, among a short list, to decide whether a bare `<div>` is
   "clickable", and a tap on an element it judges unclickable is not delivered
   to a document-level click handler — which is how narthex listens. Chromium's
   touch emulation does not model the rule, so it could not be proven here; the
   property costs nothing (the hamburger is hidden on desktop) and removes the
   question.
4. Published to the Webflow subdomain — the site has no custom domain attached.

Worth walking on a phone: the hamburger, the FAQ rows, and a sticky-menu jump
link (the scrollspy still runs from the Head, but the scrolling itself is
`vci-scroll="native"` now).

## What moved to narthex

narthex is Volente's attribute-driven utility library for Webflow — one script,
one `vci-*` attribute vocabulary, versioned and served from jsDelivr. The full
map, with the reasoning and a test that proves it against markup shaped like
this site's, is in
[`docs/migration-christtheking.md`](https://github.com/volentecreative/narthex/blob/main/docs/migration-christtheking.md).

| Was | Now |
| --- | --- |
| head: `.navbar` height measurer writing `--nav-height` | `nav` module — and it also writes `--nav-offset`, the header's live bottom edge |
| head: `html { scroll-padding-top: … }` + Webflow's jQuery anchor handler | `scroll` module (`vci-scroll="native"`) |
| footer: the ~200-line modal/drawer IIFE | `modal` module |
| applied script: `faq_accordion_toggle` | `accordion` module |
| nothing — the mobile menu is broken (see below) | `nav` module — `toggle` / `menu` / `dim` |

### Dropdowns are Webflow's; the mobile menu is not

Webflow puts `w--open` on two unrelated elements, which makes this easy to
misread:

| Webflow element | Renders | On this site |
| --- | --- | --- |
| **Dropdown** | `.w-dropdown` / `.w-dropdown-toggle` / `.w-dropdown-list` | **three** — the nav dropdowns, incl. the mega menu |
| **Navbar** | `.w-nav` / `.w-nav-menu` / `.w-nav-button` | **none** |

The nav dropdowns are real Webflow Dropdown elements and Webflow's own JS opens
them. narthex does not touch them. The hamburger is the unrelated half — a bare
div in a plain `<nav class="navbar">`, with no Webflow Navbar element behind it
and so no Webflow JS to open the menu.

Rebuilding the header on Webflow's Navbar element is the most native end state
and worth doing: Webflow would run the mobile menu itself, the way it already
runs the dropdowns. It is a by-hand Designer job — the Data API's element
builder can create a `Dropdown` but has no Navbar type. When it happens, delete
`vci-nav="toggle"` and `vci-nav="menu"`, keep `vci-nav="header"`, add
`vci-nav="dim"`, and narthex goes back to watching `w--open` on `.w-nav-button`.

### Proven on /test (2026-09-05)

The `/test` page carries the rebuilt header, built from the stock **Navbar
Logo Left** layout and then given this site's own classes and content:

```
NavbarWrapper  .navbar  [vci-nav="header" vci-nav-height-var="--nav-height"]
└─ .padding-global
   └─ .navbar_container
      ├─ NavbarBrand   .navbar_logo-link  → .logo-wrapper > img.logo
      ├─ NavbarMenu    .navbar_menu is-native
      │  ├─ Dropdown "About"    → I'm New / Sundays / Beliefs / Leadership
      │  ├─ Dropdown "Connect"  → Give / Contact
      │  ├─ Dropdown "Learn" .mega → CMS sermon list + Resources column
      │  └─ theme toggle link (hidden)
      ├─ button component instance "Connect"
      └─ NavbarButton  .navbar_hamburger → 2 × .navbar_hamburger_line
```

The element order matches the current component exactly: logo, menu, button,
hamburger. The three dropdowns were **moved**, not rebuilt, so the mega menu
keeps its CMS Collection List, its CMS-bound `media-card` instances and the
"See All Sermons" button — none of which would survive a hand rebuild. Webflow
now owns the mobile menu, and narthex is down to two attributes on the wrapper.

**`.navbar_menu.is-native` is a test-only shim.** The base `.navbar_menu` still
carries the `medium` overrides written for the hand-built menu — `position:
absolute`, `max-height: 0`, `top: 6rem` — which fight Webflow's own mobile menu.
The combo neutralises them for the test. Adopting this for real means deleting
those `medium` overrides and the `.navbar_menu.is-open` combo from the base
class, and then the shim goes away. Those styles were deliberately left alone:
they are live on all 22 pages.

Still to do if this is adopted: rebuild the real `navbar` component the same
way (the API cannot create a Navbar element, so it is a Designer job), and drop
`vci-nav="toggle"` / `vci-nav="menu"` from it.

### The mobile menu was never wired up

`.navbar_menu.is-open` already exists in the Designer, fully styled at the
`medium` breakpoint (`max-height: calc(100vh - 6rem)`, `opacity: 1`,
`pointer-events: auto`, `transform: translate(0, 0)`), against a closed base of
`max-height: 0`. The open state was designed and built — **nothing ever toggles
the class.** No handler for `data-mobile-toggle` exists in this repo's custom
code, and neither applied registered script is a menu toggle.

narthex's default menu class is `is-open`, so `vci-nav="toggle"` + `vci-nav="menu"`
connect the two ends with no new styles. The menu starts working the moment the
footer script tag lands — pointing at a tag that exists, which is the second
half of the story above.

## What stays here

- **Sticky-menu scrollspy** — narthex has no scrollspy, and
  `.sticky-menu-nav-item.is-current` is this site's own active state.
- **Parallax keyframes** — presentation, not state.
- **Turnstile hiding rule** — one form, one site.
- **Theme switcher** — still commented out, left exactly as it was.
- **Nav dropdowns open and close** — the Interactions that animated the three
  dropdowns were deleted in the Designer on 2026-09-12, which left them popping
  in. The replacement is a transition on Webflow's own `w--open`: its dropdown
  JS still does the toggling and its own `display: none` still hides the
  closed list (deferred to the end of the transition with
  `transition-behavior: allow-discrete`), so nothing is rendered-but-hidden
  and the closed links stay out of the tab order. Desktop fades; inside the
  mobile panel the list slides. **The list's horizontal alignment is pinned
  in the footer** — see below.
- **Mobile menu close icon and dim** — narthex puts its open class on the
  toggle and on the `vci-nav="dim"` element, and closes the menu when the dim
  is clicked; the footer holds only what the style panel cannot say,
  `pointer-events` and a descendant selector that folds the two hamburger bars
  into an X.

### The dropdown list is pinned left-aligned in the footer

The Designer gives the non-mega lists two geometries: the base style says
`right: 0` and the Open state says `left: 0`, flush with the toggle. The
close fade runs after `w--open` comes off, so the list would snap to the
right-aligned base box for the whole way out. The footer pins one geometry
for both states, with `!important` because an inline position from Webflow's
JS was reproduced to jump as well. It pins the Open state's: left-aligned,
which is what the Designer shows. The mega menu keeps `left: 0; right: 0`.

The cost: changing the list's horizontal alignment in the Designer will not
take effect. Change it in `site-footer.html` instead.

Untouched and still registered scripts: `LivestreamResolver`,
`Theme Logo Swap CSS`. `navbarSpeakerNames` is now tracked here — see below.

## `navbarSpeakerNames` — filling the media card's speaker

`speaker-s` on the Media collection is a **MultiReference**, and Webflow can
only render a multi-reference through a nested Collection List. A Collection
List cannot live inside a component. The media card *is* a component
(`media-card`, used on `/media` and in the navbar's Learn mega menu), so the
card ships the literal text `[Speaker]` and this script replaces it at runtime.

The card cannot be the source of its own data, so the mapping is rendered once
in a hidden Collection List and the script copies from it. It does not care
where that list lives: it harvests the current page first, and only if the page
has no source list does it fetch `/media` and cache the result in
`sessionStorage` for the rest of the tab.

**Put the source list on a page, not in a component.** Webflow allows a
Collection List inside a component (the Learn mega menu has one) but not a
Collection List *nested inside a Collection Item* inside a component — and the
nested list over `Speaker(s)` is the whole mechanism. That is the same wall the
media card hit. `/media` is the natural home; `detail_media` demonstrates the
nested pattern working on a page. Putting it in the navbar to get it on every
page is not needed anyway — the fetch-and-cache path already makes it global,
at the cost of one request per tab instead of ~92 hidden items of HTML on every
page.

### The contract

**Source** — a hidden Collection List on `/media`, over the **Media**
collection, one entry per item:

| Attribute | On | Bound to |
| --- | --- | --- |
| `data-speaker-source` | the item wrapper | — |
| `data-speaker-key` | a text block inside it | Media → **Slug** |
| `data-speaker-title` | a text block inside it | Media → **Name** |
| `data-speaker-name` | a text block in a **nested** Collection List over Media → **Speaker(s)** | Contributor → **Name** |

**Target** — on the `media-card` component, already applied:

| Attribute | On | Meaning |
| --- | --- | --- |
| `data-speakers-target` | `.media-card-speaker` | where the names are written |
| `data-media-title` | the title block | the fallback key |
| `data-speakers-done` | — | set by the script once a card is filled |

A card is matched on the slug in its own `href` first, falling back to its
normalized title text. Slug is exact; the title fallback exists so a card whose
link is not per-item still resolves.

### Things that are easy to get wrong

- **Hide the source list with `display: none`, not "delete".** Webflow's
  *conditional visibility* would keep it out of the DOM entirely, and the
  script reads the DOM.
- **The source list needs a limit above the item count.** A Webflow Collection
  List caps at 100 items per list; past that the tail of the library silently
  stops resolving. There are ~92 media items today.
- **An item with no speakers is left showing `[Speaker]`,** deliberately — a
  missing source row is indistinguishable from a not-yet-loaded one, and
  blanking it would hide the fact that `speaker-s` is empty in the CMS.
- The script repaints on DOM mutation, so the cards Finsweet appends on
  `/media` (`fs-list-load="infinite"`) get filled as they arrive.
- An empty harvest is **never** cached. The 1.0.0 script cached `{}` and then
  short-circuited on it for the rest of the session, so one bad load looked
  like a permanent failure.

### Tests

`npm run test:browser` drives the real script in headless Chromium against
fixtures shaped like the live markup (`test/speaker-names.test.mjs`). It needs
Playwright; in a sandbox without npm network access, symlink a global install:

```sh
mkdir -p node_modules && ln -s "$(npm root -g)/playwright" node_modules/playwright
```

## The Designer half

Custom code is only one side of the migration. The `vci-*` attributes go on
elements in the Designer, and those are **not** in this folder. The migration
doc lists every one; the short version:

| Element | Attributes |
| --- | --- |
| `nav.navbar` (navbar component root) | `vci-nav="header"`, `vci-nav-height-var="--nav-height"`, `vci-nav-key="main"` |
| `.navbar_menu` | `vci-nav="menu"` |
| `.navbar_hamburger` | `vci-nav="toggle"` |
| `.navbar_dim` — a backdrop div, first child of `nav.navbar` so the panel paints over it. Added 2026-09-12 | `vci-nav="dim"`, `vci-nav-key="main"` |
| `modal` component root | `vci-modal="dialog"` — no key needed, see below |
| every `data-modal-open` trigger | `vci-modal="open"` + `vci-modal-key="<key>"` |
| `a.modal_close` | `vci-modal="close"` |
| `.modal-dim` | `vci-modal="dim"` |
| `.faq_item` / `.faq_toggle` / `.faq_answer` / `.faq_icon` | `vci-accordion="item"` / `"trigger"` / `"body"` / `"icon"` |

**These are applied** (2026-09-05, via the Data API, unpublished). Two notes on
what is deliberately *not* there:

1. **No `vci-modal-key` on the modal component.** narthex resolves a key it
   cannot find as an attribute by falling back to `getElementById`, and reads a
   host's own key from its `id` — and the Modal ID prop already writes that id.
   So `vci-modal="dialog"` alone is enough. Binding was not an option anyway:
   the prop is Webflow's `id` type, bindable only to an `id` setting, never to
   an attribute value.
2. **Nothing on the orphaned Home modal.** The only `.modal` on the site is
   leftover scaffolding — default "Modal title", a close link reading "Button
   Text", no id, no dim, and nothing that opens it. There are **no
   `data-modal-open` triggers anywhere on the site** and the modal component has
   **zero instances**, so the footer modal IIFE currently drives nothing and can
   be deleted rather than migrated. The Home leftover wants deleting too, but
   that is a call for whoever put it there.

## Prefixes: what is narthex's and what is not

narthex reads **only `vci-*`** attributes. Anything `data-*` you see on these
elements belongs to the code being replaced:

- `data-mobile-toggle` on `.navbar_hamburger` and `data-modal-close` on
  `a.modal_close` are the old engines' hooks. They are kept until the code that
  reads them is deleted, so nothing breaks mid-migration — then they go.
- `data-theme-toggle` stays; it belongs to the commented-out theme switcher.

**State classes are not renamed.** `is-open` and `is-visible` are Designer
classes narthex is *configured to match*, not names it imposes — they are
settings (`vci-nav-menu-class`, `vci-modal-class`) precisely so a site keeps its
own vocabulary. `.navbar_menu.is-open` already existed here, which is why the
mobile menu needs no new styles at all.

## Two CSS rules to delete

The old FAQ script put `.is-open` on the item, the answer **and** the icon.
narthex puts the open class on the **item only** and drives the other two from
`vci-accordion-state="open"`, supplying the collapse CSS itself. So in the
Designer: keep `.faq_item.is-open`, and delete any rule on `.faq_answer.is-open`
or `.faq_icon.is-open`.

## Order of work

narthex and the old code key off different attributes and tolerate each other,
so this does not have to be a big-bang swap:

1. Add the footer script tag from `site-footer.html`.
2. Move one behaviour at a time, checking it on staging as you go.
3. Delete the old block for that behaviour only once its hooks are all moved.
4. `faq_accordion_toggle` must be removed from applied scripts the moment the
   accordion roles go on — that one *would* double-toggle.

**And it must stay removed.** It came back on 2026-09-12 at 14:37, in the same
write that registered `navbarSpeakerNames` 1.2.0 — which is what saving the
Designer's custom-code panel does: it writes the whole applied list, so a panel
opened before the script was removed puts it back. Both engines then toggle
each FAQ row on one click and they cancel out: the rows open and will not
close. That is what happened on Sundays. If it reappears, remove it again
rather than reaching for the accordion CSS; deleting the registered script
outright is the only way to make it unrepeatable, and that is irreversible.
