# Each install chooses what it receives, and defaults to everything

A **Vault Marker** names a whole Obsidian Vault, never a folder within one. An
email marked `@@Art` is not filed into an Art folder; it is claimed by the
install running in the Art vault and declined by every other install. Notes
continue to land in `notesFolder` exactly as before this feature, so a marker
never becomes a path and the 64-character, space-permitting name format raises
no sanitisation question.

Installs cannot see each other. Settings and the fetch log both live in
`plugin.saveData`, scoped to one Obsidian Vault, and a plugin cannot enumerate
the other vaults on the machine — `getName()` returns only the current one. So
no cross-install rule can be enforced, and each install decides for itself,
using two settings:

- **Markers** — a free-text, semicolon-separated list of the Vault Markers
  this vault accepts. **Blank means every marker**: it is the absence of a
  filter, not an empty allow list.
- **Unmarked emails** — a toggle, defaulting to on, for email carrying no
  marker at all.

```
Vault markers                                          [Pro]

Markers          [ Work; Second Brain                       ]
                 Semicolon-separated. Leave blank to receive every marker.
                 Each vault is set up separately. A vault left blank
                 receives everything — including mail marked for your
                 other vaults.
                 Last fetch declined: Art (4), Wrok (1)

Unmarked emails                                          [ON]
                 Emails sent without a marker.
```

All copy above is placeholder; see Not yet decided.

The default state is blank markers plus unmarked on, which is byte-for-byte
the pre-feature behaviour. Existing installs upgrade silently, no migration
runs, and no first-run prompt interrupts the majority of users who have one
vault and no interest in this feature.

Which markers a vault takes, and whether it takes unmarked email, are
orthogonal questions, so they are two controls rather than options within one.

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
  suit the plugin's UI. It also bundled the two orthogonal questions above into
  one control.
- **A checkbox list seeded from the `vaults` facet.** Rejected: the service
  deletes email after 72 hours, so the facet only ever shows markers used in
  the last three days. A user with three vaults who has emailed only one of
  them this week would see one row; the other two vaults exist, and the server
  cannot know it. A control whose contents silently omit most of the answer is
  worse than a plain text field, because it looks authoritative. Facet-driven
  autocomplete was rejected for the same reason in softer form, and prefilling
  from `app.vault.getName()` was rejected because a vault's name and its marker
  are often different strings.
- **An "any other marker" wildcard toggle beside the list.** Rejected: it has
  to default to on for upgrade safety, and while it is on the markers field
  does nothing. A new user's first action would produce no observable change.
  Folding "everything" into the blank state removes the toggle and the dead
  state with it.

## Consequences

Markers are matched case-insensitively after trimming. The field parses on
semicolon boundaries, because markers may legally contain spaces
(`Second Brain`) and so whitespace cannot be the separator, while a semicolon is
not legal inside a marker. Entries are trimmed and duplicates collapsed
case-insensitively.

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

Forward-only was rejected: a user who mistypes a marker and corrects it ten
minutes later would otherwise lose that mail permanently, and "Fetch all notes"
is not a safe recovery route while it duplicates rather than reconciles.

The plugin must never fall back to re-parsing `@@` out of a subject when
`vault` is null — that would grant the entitlement the server deliberately
withheld. Unmarked means `vault === null`, full stop. It may read that text for
one purpose only: detecting the Starter signature (`vault` null on a summary
whose subject begins with `@@`, which cannot occur on an entitled account) in
order to show an informational notice that marker filtering will not work on
the user's plan. It does not strip the token from the note title, which would
remove the visible evidence that makes the notice credible.

The plugin cannot know the user's plan and must not try. The service branches
no route on plan, and the gate is ingest-only, so a downgraded account still
returns non-null `vault` values on older rows. The markers section is labelled
Pro but always remains editable — never disabled, never hidden — because a
lapsed pro user with months of marked mail still needs the control that filters
it.

## Implementation surface

Spans this ADR, `0002-filter-locally-not-on-the-wire.md` and
`0003-notes-record-their-vault-marker.md`.

- `src/api.ts` — add `vault: string | null` to `EmailSummary` and
  `EmailDetail`. Do **not** add a `vault` param to `EmailListRequest`. The
  `vaults` facet on `EmailListResponse` is not needed by settings; add it only
  if something else wants it.
- `src/receive-policy.ts` — the two questions, and the only place a Vault
  Marker is compared to anything: `createReceivePolicy`, the semicolon
  parsing, and the per-marker tally the readouts are built from.
- `src/main.ts` — `vaultMarkers: string[]` and `receiveUnmarked: boolean` on
  `Email2ObsidianSettings`, defaulting to `[]` and `true`, parsed in
  `normalizeSettings`. The two controls, the decline readout, the
  pending-backfill row with its Fetch now button, the Pro label, the plan
  warning.
- `src/pipeline.ts` — decide each summary before the `getEmail` call, so a
  decline skips the body and every attachment download. Declined count and
  per-marker tally onto `SyncResult`, and a clause in the notice when there
  were any.
- `src/fetch-ledger.ts` — a declined entry carries its marker and timestamp, so
  the backfill count is computed locally and bounded to the 72-hour window
  (`release`, `pendingRelease`).
- `src/helpers.ts` — `email2obsidianVault` in `renderEmailMarkdown`.

New settings copy must be sentence case; `obsidianmd/ui/sentence-case` already
accounts for 5 of the 11 existing lint errors.

## Not yet decided

- **All user-facing copy above is placeholder** and needs rewriting,
  particularly the Pro label and the plan warning.
- The two remaining defects recorded in `Plan/6. Multiple vault support.md`
  are unaddressed, and one of them — `fetch-all` duplicating rather than
  reconciling — is load-bearing for the recovery story above.

Settled while implementing:

- **Where the section sits**: its own "Vault markers" heading between Set up
  and Fetch Notes Automatically. It governs what arrives, so it reads before
  the schedule that fetches it.
- **What Fetch now runs**: an ordinary `fetch-new`. The release machinery is
  in the sync already, so a targeted pull would be a second path to the same
  place and a second path that can be wrong.

## History

Implemented 2026-09-10 (issue #14). The implementation follows this ADR; where
it differs from the spec written from it, this ADR was the one that was right.
Two points worth recording. The unmarked toggle stays live when the marker list
is blank, as the two-orthogonal-controls decision above requires — the spec's
matching rule had blank markers claiming everything unconditionally, which
would have made the toggle dead in exactly the case a catch-all vault uses.
And the ledger stores no policy configuration of its own: the marker on each
declined entry is enough to answer what the current policy claims, so the
release is correct whichever device made the correction.

Revised 2026-09-09. The original decision was a three-way radio group with one
marker per install, chosen from a facet-seeded dropdown prefilled with the
vault's own name; it is retained above under Considered Options with the
reasons it was replaced. `Plan/6. Multiple vault support.md` records the
earlier session and the defect list; this ADR is self-contained and does not
depend on it.
