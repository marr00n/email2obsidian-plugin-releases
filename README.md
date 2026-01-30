# Email2Obsidian Plugin

## Email anything into Obsidian instantly.
Send an email and it appears in your Obsidian vault as a fully formed note — subject, body, and attachments included.

[Get Started for Free](https://email2obsidian.com/signup) 

## Features
- Instant capture from any device or email client—no extra apps or automations.
- Attachments handled automatically (email embeds and email attachments) using Obsidian's attachment settings.
- Privacy-first: data stored securely for 72 hours, no permanent retention.
- Never overwrites your notes: new files get a safe, unique name and old ones stay untouched.

## How it works
1) Email your unique address — subject, body, and attachments are captured instantly.  
2) Service parses and holds your content privately for 72 hours.  
3) Obsidian plugin fetches and saves notes + attachments using Obsidian's attachment settings.

## Who it’s for
- Obsidian power users who want fast capture without breaking flow.
- Knowledge workers and students who email themselves research, ideas, or docs.
- Document organizers who forward receipts, PDFs, scans straight into their vault.

## Plans
[Get Started for Free](https://email2obsidian.com/signup). [Upgrade when ready](https://email2obsidian.com/pricing)

---
## Installation

### Option 1: **Install via Community Plug-ins**  
- Currently under review, awaiting approval for listing.

### Option 2: **BRAT Plugin (Recommended - Auto Updates)**  
Using BRAT (Beta Reviewers Auto-update Tool) allows you to receive automatic updates:

1. **Install BRAT** (if not already installed)
   - Open **Settings** → **Community Plugins** → **Browse**
   - Search for "BRAT"
   - Install and enable it

2. **Add Email2Obsidian via BRAT**
   - Open **Settings** → **BRAT**
   - Click **Add Beta Plugin**
   - Enter repository: `https://github.com/marr00n/email2obsidian-plugin-releases`
   - Click **Add Plugin**
   - Enable the plugin

3. **Enable the plugin**
   - Go to **Settings** → **Community Plugins**
   - Find "Email2Obsidian" and enable it  
   BRAT will automatically check for and install updates from new releases.

### Option 3: **Manual Download**  
For one-time installation without auto-updates:

1. Download the latest release from [**GitHub Releases**](https://github.com/marr00n/email2obsidian-plugin-releases)
2. Extract `main.js`, `manifest.json`, and `styles.css`
3. Copy to `.obsidian/plugins/email2obsidian/` in your vault
4. Reload Obsidian (Cmd/Ctrl + R)
5. Enable in **Settings** → **Community Plugins**


## Setup
1) Open Settings → Email2Obsidian and configure:
   - **API Key** (required; sent as `x-api-key`; use “Test connection” to verify)
   - **Notes folder** (optional; leave blank or `.` to write into the vault root; otherwise auto-created with default `E2Oinbox`)
   - **Periodic sync** + **Interval** (5m/10m/15m/30m/1h/3h/6h/12h/daily); runs immediately when enabled
   - **Run on open** (optional one-time sync on app launch; interval countdown restarts on open)
2) Use the command palette:
   - **Fetch New Email2Obsidian Notes** (log-aware, appends to log)
   - **Fetch All Email2Obsidian Notes** (ignores log for selection, rewrites log to fetched set)

---

## Behaviour Notes
- Fetches each email only once and saves files with safe, unique names (adds -1, -2 if needed).
- Attachments follow Obsidian's attachment settings.

## Disclosures
- Requires an Email2Obsidian account and API key; depends on the Email2Obsidian service.
- Plugin stores sync state/settings locally under `.obsidian/plugins/email2obsidian/`; notes and attachments are written to your vault per your Obsidian settings.
- No telemetry or analytics beyond the network requests needed to sync.

## Development
- Install dependencies: `npm install`
- Build once: `npm run build`
- Watch and rebuild on changes: `npm run dev`
