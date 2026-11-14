# Notes record the Original Sender and sent date, and omit them when unknown

Every note can carry two more properties, read from the service's
`originalFrom` and `sentAt` fields:

```yaml
---
created: 2026-11-13T09:20:41
from: "Jane Doe <jane@example.com>"
sent: 2026-11-13T09:15:00
---
```

- **`from`** is the **Original Sender**, never the wire `from`: on a forward
  that is the person who forwarded it, and the note is about the message, not
  the forward. It is always double-quoted through the same escaping as the
  subject, because it is untrusted text.
- **`sent`** is written as `YYYY-MM-DDTHH:mm:ss`, unquoted and with no zone —
  the shape `created` already has. Obsidian reads a zoneless date-time as
  local time, so the UTC instant from the service is converted to the
  device's zone once, in the Service Client.

Both are **omitted** when the service sends nothing usable. There is no
setting for either; no other property has one.

## Considered Options

- **Write them empty, as ADR-0003 does for `email2obsidianVault`.** Rejected.
  An empty Vault Marker is a real answer ("arrived unmarked"); an empty sender
  or date is not, it is "unknown". An empty `sent` would show as a blank or
  invalid date-time, and every note written before the service sent these
  fields — and every note written while an older service is still deployed —
  would gain two blank properties for nothing.
- **Fall back to the wire `from` when `originalFrom` is missing.** Rejected:
  on a forward it names the wrong person, and a wrong sender is worse than
  none.
- **Write `sent` in UTC, or with its zone.** Rejected: Obsidian's date-time
  property has no zone, so UTC would show the wrong wall-clock time, and a
  zone suffix would make the value text rather than a date.

## Consequences

`sent` is local to the device that fetched the email. A vault synced between
devices in different zones keeps whichever zone wrote the note, as any
hand-typed date-time in Obsidian would.

`created` is written from the service's zoneless SQL timestamp unconverted.
If that timestamp is UTC, `created` and `sent` can disagree by the device's
UTC offset. That predates this decision and is left alone here.
