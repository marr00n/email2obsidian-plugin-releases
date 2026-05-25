# Send Email into Vault by Email2Obsidian

## Email anything into Obsidian instantly.
Send an email and it appears in your Obsidian vault as a complete note, including the subject, body, and any attachments.

👉 [Get Started for Free](https://email2obsidian.com/signup) 

## Features
- Capture notes from any device or email client. No extra apps or automations required.
- Emails and attachments are handled automatically and saved to your chosen folders.
- Privacy-first design: data is stored securely for up to 72 hours, with no permanent retention.
- Existing notes are never overwritten. Each new file is given a safe, unique name.

## How it works
1) You get a private email address
2) Send an email (notes, PDFs, receipts, ideas, files)
3) Fetch it into Obsidian via the plugin, exactly where you want it

## Who it’s for
- Anyone who forwards receipts, PDFs, or scans straight into their vault
- Knowledge workers and students emailing themselves research, ideas, or documents
- Obsidian power users who want fast capture without disrupting their workflow
 
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
