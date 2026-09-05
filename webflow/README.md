# Webflow custom code

The site's front-end behaviour, version-controlled. Webflow is the source of
truth for what is *live*; this folder is the source of truth for what it
*should* say, so a change is reviewable instead of only existing in a textarea
in the Designer.

| File | Where it goes |
| --- | --- |
| `site-head.html` | Site settings → Custom code → **Head** |
| `site-footer.html` | Site settings → Custom code → **Footer** |

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

Untouched and still registered scripts: `navbarSpeakerNames`,
`LivestreamResolver`, `Theme Logo Swap CSS`.

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
