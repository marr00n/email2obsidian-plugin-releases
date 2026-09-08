# Send Email into Vault by Email2Obsidian

## Email anything into Obsidian instantly.

## Send Email into Vault by Email2Obsidian
Send an email and it appears in your Obsidian vault as a complete note, including the subject, body, and any attachments.

👉 [Get Started with Free Trial](https://email2obsidian.com/signup) 

## Features
- **Works on desktop and mobile** — access your ingestion address from any device
- **Flexible sync** — trigger manually, on a schedule, or automatically when your vault opens
- **Safe file handling** — new notes never overwrite existing files in your vault
- **Configurable attachment storage** — choose where attachments are saved within your vault
- **Strong privacy** — emails are automatically deleted after 72 hours and are never sold, shared, or used for AI training; no vault telemetry

## How it works
1) You get a private email address
2) Send an email (notes, PDFs, receipts, ideas, files)
3) Fetch it into Obsidian via the plugin, exactly where you want it, automatically

## Who it’s for
- Anyone who forwards receipts, PDFs, or scans straight into their vault
- Knowledge workers and students emailing themselves research, ideas, or documents
- Obsidian power users who want fast capture without disrupting their workflow

## Upcoming Features
- **Multiple vault support** — route emails to different vaults
 
## Paid Plans
[Get Started with Free Trial](https://email2obsidian.com/signup). [Upgrade when ready](https://email2obsidian.com/pricing)

---
## Installation

### via Community Plug-ins
- https://community.obsidian.md/plugins/send-email-into-vault


## Setup
2) Open Settings → Email2Obsidian and configure:
   - **API Key** (required; sent as `x-api-key`; use “Test connection” to verify)
   - **Notes folder** (optional; leave blank or `.` to write into the vault root; otherwise auto-created with default `E2Oinbox`)
   - **Attachment folder** (optional; if set, all attachments/inline references will point here)
   - **Periodic sync** + **Interval** (1h/3h/6h/12h/daily); runs immediately when enabled
   - **Run on open** (optional one-time sync on app launch; interval countdown restarts on open)
3) Use the command palette:
   - **Fetch New Email2Obsidian Notes** - fetches unseen emails and appends to the sync log
   - **Fetch All Email2Obsidian Notes** - ignores the log and refetches all emails on server

---

## Behaviour Notes
- Each email is only fetched once.
- Notes are saved with safe, unique filenames (e.g. -1, -2 added if required).
- Attachments saved to the attachment folder if set; otherwise beside the note.

## Disclosures
- Requires an Email2Obsidian account and API key.
- Plugin stores sync state/settings locally under `.obsidian/plugins/email2obsidian/`.
- No telemetry or analytics beyond the network requests needed to sync.

## Development
- Install dependencies: `npm install`
- Build once: `npm run build`
- Watch and rebuild on changes: `npm run dev`
