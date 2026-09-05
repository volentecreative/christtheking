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
| Interaction on `.navbar_hamburger` (see below) | `nav` module — `toggle` / `menu` / `dim` |

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
| a new full-page backdrop div, if wanted | `vci-nav="dim"`, `vci-nav-key="main"` |
| `modal` component root | `vci-modal="dialog"` + `vci-modal-key` **bound to the Modal ID prop** |
| every `data-modal-open` trigger | `vci-modal="open"` + `vci-modal-key="<key>"` |
| `a.modal_close` | `vci-modal="close"` |
| `.modal-dim` | `vci-modal="dim"` |
| `.faq_item` / `.faq_toggle` / `.faq_answer` / `.faq_icon` | `vci-accordion="item"` / `"trigger"` / `"body"` / `"icon"` |

Two things that need a person in the Designer and cannot be done through the
Data API:

1. **`vci-modal-key` on the `modal` component root must be *bound* to the Modal
   ID prop** — the same prop its `id` is bound to. The API can set attribute
   values but not attribute *bindings*.
2. **The mobile menu has one decision in it.** Nothing in the site's custom code
   handles `data-mobile-toggle`, so a Webflow Interaction presumably opens the
   menu today. Two engines must not both own the open class: either delete the
   Interaction and let narthex own `.navbar_menu.is-open`, or keep the
   Interaction and set `vci-nav-own="false"` on `.navbar_menu` so narthex only
   watches it. The second only works if the Interaction toggles a *class* —
   check before choosing.

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
