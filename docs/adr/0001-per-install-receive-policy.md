# Each install chooses what it receives, and defaults to everything

Vault Markers route email to one of a user's Obsidian Vaults, but plugin
installs cannot see each other — settings and the fetch log both live in
`plugin.saveData`, scoped to one Obsidian Vault — so no cross-install rule can
be enforced. Each install therefore decides for itself, using two settings:

- **Markers** — a free-text, semicolon-separated list of the Vault Markers
  this vault accepts. **Blank means every marker**: it is the absence of a
  filter, not an empty allow list.
- **Unmarked emails** — a toggle, defaulting to on, for email carrying no
  marker at all.

The default state is blank markers plus unmarked on, which is byte-for-byte
the pre-feature behaviour. Existing installs upgrade silently, no migration
runs, and no first-run prompt interrupts the majority of users who have one
vault and no interest in this feature.

## Considered Options

- **Every install takes unmarked email.** Rejected: a user with three vaults
  gets three copies of every unmarked email, and unmarked is the common case.
- **No install takes unmarked email.** Rejected: it silently drops mail, and
  Starter accounts can never produce a marker at all — `canUseVaults` gates
  parsing, so their `@@` text stays in the subject and `vault` stays null.
  Those users would sync nothing.
- **A three-way radio group with a single marker** (all emails / only emails
  marked for X / X plus unmarked). This was the original decision here and is
  now superseded. It forced a user whose vault should receive two markers to
  consolidate them into one name server-side, changing their sending habits to
  suit the plugin's UI. It also bundled two orthogonal questions — which
  markers, and what about unmarked — into one control.
- **A checkbox list seeded from the `vaults` facet.** Rejected: the service
  deletes email after 72 hours, so the facet only ever shows markers used in
  the last three days. A user with three vaults who has emailed only one of
  them this week would see one row; the other two vaults exist, and the server
  cannot know it. A control whose contents silently omit most of the answer is
  worse than a plain text field, because it looks authoritative. Facet-driven
  autocomplete was rejected for the same reason in softer form.
- **An "any other marker" wildcard toggle beside the list.** Rejected: it has
  to default to on for upgrade safety, and while it is on the markers field
  does nothing. A new user's first action would produce no observable change.
  Folding "everything" into the blank state removes the toggle and the dead
  state with it.

## Consequences

Markers are matched case-insensitively after trimming. The field parses on
semicolon boundaries, because markers may legally contain spaces
(`Second Brain`) and so whitespace cannot be the separator, while a semicolon is
not legal inside a marker.

There is an allow list but no deny list. A vault cannot say "everything except
Art"; a user wanting that must list what they do want.

**A typo is silent.** `@@Wrok` routes nowhere, raises no error, and the email is
deleted from the service after 72 hours. The mitigation is to name declines
rather than only count them: the sync notice reports `5 not for this vault`,
and the settings tab carries a passive read-only line, `Last fetch declined:
Art (4), Wrok (1)`. This is diagnostic, never suggestive — it reports what was
turned away and never proposes a marker.

That same line is how a user discovers an unconfigured sibling vault. Because
blank means everything, a user who configures two of their three vaults leaves
the third taking every email, including mail marked for the other two. Only
settings copy can steer this, so the markers field says so directly.

Changing the markers releases previously declined mail, bounded by the 72-hour
window. The settings tab states what will arrive at the moment of the edit —
`Art: 7 emails from the last 3 days will arrive on the next fetch` — with a
Fetch now button. The count is a local lookup against the fetch log, not a
server request, since declines are recorded there anyway (see
`0002-filter-locally-not-on-the-wire.md`).

The plugin must never fall back to re-parsing `@@` out of a subject when
`vault` is null — that would grant the entitlement the server deliberately
withheld. It may read that text for one purpose only: detecting the Starter
signature (`vault` null on a summary whose subject begins with `@@`, which
cannot occur on an entitled account) in order to show an informational notice
that marker filtering will not work on the user's plan. It does not strip the
token from the note title, which would remove the visible evidence that makes
the notice credible.

The plugin cannot know the user's plan and must not try. The service branches
no route on plan, and the gate is ingest-only, so a downgraded account still
returns non-null `vault` values on older rows. The markers section is labelled
Pro but always remains editable — never disabled, never hidden — because a
lapsed pro user with months of marked mail still needs the control that filters
it.

## History

Revised 2026-09-09. The original decision was a three-way radio group with one
marker per install; it is retained above under Considered Options with the
reasons it was replaced. The full discussion is in
`Plan/7. Multi-vault UX decisions.md`.
