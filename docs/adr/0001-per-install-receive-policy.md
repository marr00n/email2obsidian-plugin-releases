# Each install chooses what it receives, and defaults to everything

Vault Markers route email to one of a user's Obsidian Vaults, but plugin
installs cannot see each other — settings and the fetch log both live in
`plugin.saveData`, scoped to one Obsidian Vault — so no cross-install rule can
be enforced. We gave each install a three-way receive policy (all emails /
only emails marked for a vault / that marker plus unmarked emails) defaulting
to "all emails", which is byte-for-byte the pre-feature behavior.

## Considered Options

- **Every install takes unmarked email.** Rejected: a user with three vaults
  gets three copies of every unmarked email, and unmarked is the common case.
- **No install takes unmarked email.** Rejected: it silently drops mail, and
  Starter accounts can never produce a marker at all — `canUseVaults` gates
  parsing, so their `@@` text stays in the subject and `vault` stays null.
  Those users would sync nothing.

## Consequences

An install claims at most one marker. A user whose vault should receive two
distinct markers has to consolidate them into one name; a multi-select was
rejected to keep setup simple, and is cheap to add later since
`normalizeSettings` already rewrites every stored field on load.

The catch-all is a per-install setting, not an invariant. A user who sets no
install to catch unmarked email will silently receive none of it, and a user
who sets two will get duplicates. Only settings copy can steer this.

The plugin must never fall back to re-parsing `@@` out of a subject when
`vault` is null — that would grant the entitlement the server deliberately
withheld.
