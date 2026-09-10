# Imported notes record their Vault Marker in frontmatter

Every note the plugin writes carries `email2obsidianVault` alongside the
existing `email2obsidianID`. It is written on every note, and left as an empty
string for an Unmarked Email rather than omitted, so a query never has to
handle a missing key.

```yaml
---
email2obsidianID: 42
email2obsidianVault: Art
---
```

## Considered Options

- **Omit the key for unmarked email.** Rejected: unmarked is the common case,
  so the majority of notes would lack the property and every Bases or Dataview
  query over it would need a null branch. The cost of the alternative is one
  empty property in the properties panel.
- **Do not stamp at all.** Rejected on recoverability. The service deletes an
  email after 72 hours, so a note older than three days cannot be
  re-interrogated to find out which marker brought it in. Anything not stamped
  at write time is unrecoverable, and any future cleanup or re-route feature
  would have nothing local to work from.

## Consequences

A note becomes self-describing about why it landed in this vault, and Bases and
Dataview have something to group on.

Notes written before this feature carry no such key, so any later feature that
works from the stamp has a pre-existing tail it cannot classify. That tail is
finite and shrinks in relevance; it is not worth a `getEmail` round trip per
note to close, and past 72 hours it cannot be closed at all.

The plugin never moves, deletes or re-stamps a note in response to a change of
markers. Files on disk by then are the user's — edited, linked, embedded in
other notes — and a tidiness win does not justify that risk. See
`0002-filter-locally-not-on-the-wire.md`.
