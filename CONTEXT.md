# Email2Obsidian Plugin

The Obsidian-side half of Email2Obsidian: it pulls email-derived notes from the
E2O service into a user's vault. The service owns ingestion and parsing; this
plugin owns everything that touches the local filesystem.

## Language

**Obsidian Vault**:
The local directory tree a single plugin instance reads and writes.
_Avoid_: vault (unqualified, in plugin code)

**Vault Marker**:
The name a sender puts on an email to say which Obsidian Vault it belongs in.
_Avoid_: vault tag, tag, vault name, vault ID, label

**Hashtag**:
A keyword on an email that becomes an Obsidian tag in the note's frontmatter.
_Avoid_: tag (unqualified)

**Unmarked Email**:
An email that carries no Vault Marker.
_Avoid_: untagged email, null vault, default vault

**Service Client**:
The plugin's one handset to the E2O service, holding the credentials and the
transport. Wire shapes end at it; everything past it sees domain values.
_Avoid_: api module, fetcher, HTTP layer

**Note Namer**:
The plugin's one answer to "which filename does this email-derived note get?".
Opened over the destination folder, it scans that folder once, then sanitises,
resolves collisions with `-1`, `-2`, … and reserves each note path it hands out.
_Avoid_: filename helper, safeFilename, name lock, existing-names set

**Fetch Ledger**:
The plugin's record of which emails this install has already dealt with —
accepted or declined. It is a contiguous run of the newest emails, which is why
the newest-first scan may stop at the first entry it recognises: everything
older is already in the ledger.
_Avoid_: fetch log, seen set, logged ids, history, dedupe cache

## Relationships

- A **Vault Marker** names at most one intended **Obsidian Vault**
- An email carries zero or one **Vault Marker** — never several
- An email carries zero or more **Hashtags**, independently of its **Vault Marker**
- A plugin instance serves exactly one **Obsidian Vault**, and can neither
  see nor name any other
- **Vault Markers** are compared case-insensitively: `Work` and `work` name
  the same **Obsidian Vault**

## Example dialogue

> **Dev:** "If I send an email marked `Work`, does the plugin file it under a
> Work folder?"
> **Domain expert:** "No — `Work` is a **Vault Marker**, it names a whole
> **Obsidian Vault**. The install running in your Art vault sees that email in
> the stream and declines it. Only the install running in Work takes it."
> **Dev:** "So every install sees every email?"
> **Domain expert:** "Every install can. What differs is what each one claims."
> **Dev:** "And if the sender also put `#invoice` on it?"
> **Domain expert:** "That's a **Hashtag** — it rides along into the note's
> frontmatter wherever the note lands. It has no say in which vault takes it."

## Flagged ambiguities

- "vault" was used to mean both the local **Obsidian Vault** and the routing
  name on an email — resolved: these are distinct. The routing name is a
  **Vault Marker**; in plugin code the bare name `vault` stays reserved for
  Obsidian's `Vault` handle, which is already bound that way in `runSync`.
- "tag" is triple-booked: Obsidian's own `#tag`, the `hashtags` field on an
  email, and the `?tag=` filter on `GET /api/emails` — resolved: the email-side
  concept is a **Hashtag**, and a **Vault Marker** is never called a tag.
  `?tag=` and `?vault=` are sibling params filtering different things.
