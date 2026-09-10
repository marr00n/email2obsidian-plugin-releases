# Filtering happens in the plugin, not via `?vault=`

`GET /api/emails` accepts a `?vault=` filter, and we deliberately do not use
it. Filtering is inherently per-install — the same email is a decline in the
Work vault and an accept in the Art vault — so no server-side filter is right
for more than one of a user's vaults at a time. Every install pulls the whole
stream of summaries and decides locally.

## Consequences

A vault that takes both its listed markers and unmarked email cannot be
expressed as a single `?vault=` request anyway: the filter excludes nulls and
there is no `?vault=none`. Neither can a vault listing several markers.
Filtering locally serves every combination with one code path.

The extra bandwidth is small and bounded. Summaries carry no body and no
attachments; the expensive `getEmail` call happens per selected email, so
declining before that point skips the body and every attachment download.

Declined ids are recorded in the fetch log, marked as declined. Without this
the log holds only accepted emails and becomes sparse, which breaks the
early-stop in `paginateEmails` — it halts at the first already-logged id, on
the assumption that the log is a contiguous run of the newest emails. Logging
declines keeps that assumption true.

When a user changes their markers, drop the matching declined entries from the
log. Previously-declined email then gets reconsidered by the next ordinary
`fetch-new`, with no full re-fetch. A declined entry stores its marker and its
timestamp, which also lets the settings tab state how much mail an edit is
about to release without asking the server. This matters because "Fetch all
notes" is not a safe reconciliation path: `safeFilename` suffixes against names
already in the folder, so re-fetching an email whose note exists writes
`Meeting notes-1.md` beside `Meeting notes.md` rather than recognising it.

Because the marker is on the entry, the ledger never has to remember which
policy it was written under: the policy in force *now*, read against the marker
recorded *then*, answers the question directly. That is what makes a correction
typed on one device take effect on whichever device next syncs.

Releasing a decline is the one thing that deliberately breaks the contiguity
the early-stop depends on, so the ledger compensates rather than the caller.
Until every released id has been met again, `shouldStopScan` keeps the scan
running: stopping at the usual place would halt on newer email and walk
straight past the very mail the run exists to recover. The cost of running on
is bounded by the service's own 72-hour retention — the whole stream is at most
72 hours of email — which is also why a decline older than that is never
released: the email it names is already deleted. A released id the run never
met is dropped at commit for the same reason, so the next run stops early
again instead of hunting for something that no longer exists — but only when
the run finished. A run cut short by a rate limit has proved nothing about
what it did not reach: it stopped, the service did not. Its released entries
stay put, and the next run releases and hunts them again.

Notes already downloaded under a previous policy stay where they are. The
plugin never moves or deletes a note in response to a policy change: those
files are the user's by then, and notes written before this feature carry no
marker in their frontmatter, so identifying them would cost a `getEmail` call
per note. Notes written from now on do carry one — see
`0003-notes-record-their-vault-marker.md` — so a future cleanup or re-route
feature can work locally for everything except that pre-existing tail.
