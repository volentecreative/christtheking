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

Both are the **post-migration** state: the shared behaviour has moved to
[narthex](https://github.com/volentecreative/narthex), and what is left here is
the part that is genuinely this site's own.

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
footer script tag lands.

## What stays here

- **Sticky-menu scrollspy** — narthex has no scrollspy, and
  `.sticky-menu-nav-item.is-current` is this site's own active state.
- **Parallax keyframes** — presentation, not state.
- **Turnstile hiding rule** — one form, one site.
- **Theme switcher** — still commented out, left exactly as it was.

Untouched and still registered scripts: `LivestreamResolver`,
`Theme Logo Swap CSS`. `navbarSpeakerNames` is now tracked here — see below.

## `navbarSpeakerNames` — filling the media card's speaker

`speaker-s` on the Media collection is a **MultiReference**, and Webflow can
only render a multi-reference through a nested Collection List. A Collection
List cannot live inside a component. The media card *is* a component
(`media-card`, used on `/media` and in the navbar's Learn mega menu), so the
card ships the literal text `[Speaker]` and this script replaces it at runtime.

The card cannot be the source of its own data, so the script keeps one page
that renders the mapping — `/media`, in a hidden Collection List — and copies
from it. On `/media` it harvests the local document; on any other page it
fetches `/media` once and caches the result in `sessionStorage`.

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
| a new full-page backdrop div, if wanted | `vci-nav="dim"`, `vci-nav-key="main"` — optional, none exists today |
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
