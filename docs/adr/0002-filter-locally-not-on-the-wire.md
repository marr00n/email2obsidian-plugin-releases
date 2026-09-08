# Filtering happens in the plugin, not via `?vault=`

`GET /api/emails` accepts a `?vault=` filter, and we deliberately do not use
it. Filtering is inherently per-install — the same email is a decline in the
Work vault and an accept in the Art vault — so no server-side filter is right
for more than one of a user's vaults at a time. Every install pulls the whole
stream of summaries and decides locally.

## Consequences

The receive policy's third option ("marked for X, and unmarked") cannot be
expressed as a single `?vault=` request anyway: the filter excludes nulls and
there is no `?vault=none`. Filtering locally serves all three policies with one
code path.

The extra bandwidth is small and bounded. Summaries carry no body and no
attachments; the expensive `getEmail` call happens per selected email, so
declining before that point skips the body and every attachment download.

Declined ids are recorded in the fetch log, marked as declined. Without this
the log holds only accepted emails and becomes sparse, which breaks the
early-stop in `paginateEmails` — it halts at the first already-logged id, on
the assumption that the log is a contiguous run of the newest emails. Logging
declines keeps that assumption true.

When a user changes their receive policy, drop the declined entries from the
log. Previously-declined email then gets reconsidered by the next ordinary
`fetch-new`, with no full re-fetch. This matters because "Fetch all notes" is
not a safe reconciliation path: `safeFilename` suffixes against names already
in the folder, so re-fetching an email whose note exists writes
`Meeting notes-1.md` beside `Meeting notes.md` rather than recognising it.

Notes already downloaded under a previous policy stay where they are. The
plugin never moves or deletes a note in response to a policy change: those
files are the user's by then, and notes written before this feature carry no
marker in their frontmatter, so identifying them would cost a `getEmail` call
per note. Notes written from now on do carry one — `email2obsidianVault`,
alongside the existing `email2obsidianID` — so a future cleanup or re-route
feature can work locally for everything except that pre-existing tail.
