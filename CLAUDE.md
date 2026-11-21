# Christ the King site — working notes for Claude

## Webflow build preferences (from Josh)

- **No spacer blocks.** Never add the `spacer` component or empty spacer divs. Space
  things with flex/grid **gap** on the parent (`vert-flex gap-*`, `horz-flex gap-*`),
  or with margin/padding. To space a new element from its neighbour, wrap the two in
  a `vert-flex gap-*` div rather than dropping a spacer between them.
- The user's Designer edits are authoritative; never silently revert them.
- Staging-only work goes on the `I'm New (staging)` page (`/about/im-new-staging`,
  noindex); publish it to the webflow.io subdomain only. Live publishes go to the
  custom domains only, with that page set to draft for the publish and undrafted after.
- Webflow's MCP tools can't insert into a component slot whose only children are
  component instances (no non-instance anchor). On I'm New (live + staging) the
  mission section's `container` was unlinked for this reason; it is labelled
  "container (Large, unlinked)" in the Navigator and renders identically.
