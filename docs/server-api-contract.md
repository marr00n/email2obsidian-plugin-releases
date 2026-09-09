# Server API contract

Record of what the **Email2Obsidian service** returns on its read endpoints,
written for whoever maintains the service. It is kept in the plugin repo
because the plugin is the consumer that breaks when a shape here changes; the
service is the owner of every fact below.

Terminology follows `CONTEXT.md`: a **Vault Marker** is the routing name a
sender puts on an email (`@@Work`), surfaced as the `vault` field; a
**Hashtag** is a keyword that becomes an Obsidian tag, surfaced as
`hashtags`.

## Authentication

Both read endpoints accept either a session cookie or an `x-api-key` header
(`app/lib/session.server.ts:33`).

A request with no credentials at all gets **302 to `/signin`**, not 401. Any
non-browser client has to treat a redirect as an auth failure, so keep this in
mind before changing the redirect target.

## `GET /api/emails`

`app/routes/api.emails._index.ts`

```jsonc
{
  "emails": [
    {
      "id": 42,                              // number
      "subject": "Weekly review",            // string, never null ("(no subject)" fallback)
      "createdAt": "2026-09-09 08:14:02",    // string, SQL timestamp — not ISO
      "hashtags": ["todo", "work"],          // string[] | null
      "vault": "Work"                        // string | null
    }
  ],
  "hasMore": false,                          // boolean
  "nextCursor": "MjAyNi0wOS0wOSAwODoxNDowMnw0Mg", // string | null (null on an empty page)
  "tags": ["todo", "work"],                  // string[], always an array, [] possible
  "vaults": ["Work"]                         // string[], always an array, [] possible
}
```

Query params: `cursor`, `limit` (clamped 1–100, default 10), `sort`
(`date-desc` | `date-asc`), `tag`, `vault`, `search`.

`tags` and `vaults` are facets over the account, not over the page.

## `GET /api/emails/:id`

`app/routes/api.emails.$id._index.ts`

```jsonc
{
  "id": 42,
  "emailId": "resend_abc123",                // string
  "subject": "Weekly review",
  "hashtags": ["todo"],                      // string[] | null
  "vault": null,                             // string | null
  "markdownBody": "# Notes\n...",            // string, "" when the email had no HTML
  "createdAt": "2026-09-09 08:14:02",
  "expiresAt": "2026-09-12 08:14:02",        // string, createdAt + 72h
  "attachments": [                           // always an array, [] when none — never null
    {
      "id": 7,
      "fileName": "doc.pdf",
      "fileSize": 10234,                     // number, bytes
      "mimeType": "application/pdf",
      "createdAt": "2026-09-09 08:14:02",
      "contentDisposition": "attachment"     // string | null
    }
  ]
}
```

## `GET /api/attachments/:id/download`

Binary body, not JSON. `Content-Type` is the stored mime type,
`Content-Disposition: attachment`.

## Plan gating

**No route branches on plan.** The response shape is identical on free,
starter and pro. What differs is which *values* can appear, and the only
affected field is `vault` — plus the `vaults` facet that derives from it.

The gate sits at **ingest**, not at read:
`canUseVaults(planId, hasVaultEntitlement(user))` in
`app/routes/api.webhook.resend._index/route.ts:279`.

| Plan | `vault` on new emails | `vaults` facet | `hashtags` | Monthly / daily cap |
|---|---|---|---|---|
| free | `string \| null` — parsed, part of the ten-email trial | can be non-empty | same | 10 / 10 |
| starter | `null` always, unless an active vault trial grant | `[]` typically | same | 300 / 200 |
| pro | `string \| null` — parsed while the sub is active | can be non-empty | same | 1000 / 200 |

Consequences worth holding onto when touching ingest:

- **Starter without a grant**: `@@Work` is *not* stripped from the subject.
  `subject` comes back as `"@@Work Weekly review"` with `vault: null`. Free
  and pro get `subject: "Weekly review"` and `vault: "Work"`. So a subject
  can carry raw marker text, and that is deliberate.
- **Starter with a vault trial** (`vaultTrialUntil` in the future plus an
  `active`/`trialing` sub) behaves like pro for vaults but keeps the 300
  allowance — the grant does not raise the cap (`getPlanMaxEmails`).
- **Lapsed pro** (row still reads `plan: 'pro'`, status not `active`/
  `trialing`) gets `vault: null` on new emails. Legacy rows with
  `subscriptionStatus: null` count as entitled.
- **The gate is ingest-only.** Emails captured earlier keep their Vault
  Marker forever, so a downgraded account still returns a non-null `vault`
  and a non-empty `vaults` array for older rows. Nothing downstream may
  infer plan from output.
- `hashtags` parsing is plan-independent by design (see the comment in
  `parse-subject.ts`). It is nullable only because the column is nullable
  JSON; the webhook always writes an array, so `[]` is what happens in
  practice and `null` only on legacy rows.

## Error shapes

Also plan-independent, but **two families that do not agree**:

```jsonc
// 401 invalid API key, 429 rate limited
{ "status": 401, "message": "Invalid API key. Please try again." }

// 400 bad id, 404 not found
{
  "status": 404,
  "error": "Email not found",
  "message": "The email was not found",
  "timestamp": "2026-09-09T08:14:02.000Z"
}
```

List/detail 400 and 404 carry `error` and `timestamp`; the auth errors carry
neither. Worth unifying on the server side, but any change is breaking for
clients that key off `error`.

Note that `timestamp` here is ISO 8601 while `createdAt`, `expiresAt` and the
`createdAt` inside a cursor are SQL timestamps. Two time formats in one
payload.

## Retention

The service keeps a received email for **72 hours**, then deletes it —
`expiresAt` is that deadline. The service is a short-lived queue, not a store;
the plugin holds the durable copy. Any read endpoint added later inherits the
same window.

## Invariants the plugin relies on

Breaking any of these breaks sync, not just a display detail:

1. `emails` is an array and `hasMore` is a boolean on every 200 response —
   the plugin rejects the payload outright otherwise (`src/api.ts:325`).
2. `attachments` is an array, never `null`.
3. `markdownBody` is a string, `""` rather than `null`, when there is no HTML.
4. `subject` is a string, never `null`.
5. `nextCursor` is opaque to the client. It currently encodes
   `createdAt|id`, and the plugin must not parse it — but it must survive a
   round trip unchanged.
6. `vault` is the only source of a Vault Marker. When the server withholds
   it, the plugin does not re-parse `@@` out of the subject, so a change that
   stops populating `vault` silently stops routing rather than falling back
   (see `docs/adr/0001-per-install-receive-policy.md`).
