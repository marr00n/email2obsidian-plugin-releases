# CLAUDE.md

## Git Commits

- NEVER add a `Co-Authored-By` trailer or any other attribution that lists Claude as a co-author or contributor in git commits.

## Releases

- A release happens ONLY when a version tag is pushed — pushes to main alone never release or deploy anything. Tag only when a release is intended (e.g., `git tag 3.2.0 && git push origin 3.2.0`), and bump `package.json`/`manifest.json` to match in the tagged commit.
- The tagged commit's message becomes the release body, so the tagged commit should carry a message that reads as release notes (e.g. "Release 3.2.0: …"). Missing or empty messages produce releases with no description, which harms the plugin's health rating.
- Every commit must have a meaningful commit message — if the user hasn't provided one, suggest one, and prompt them to agree or edit it before committing.

  ## Server Behaviour
  - The Email2Obsidian service retains a received email for **72 hours**, then deletes it. The plugin holds the durable copy; the server is a short-lived queue, not a store.
  - This is why `fetch-all` re-creating a note as `-1` rather than reconciling with an existing one is accepted behaviour, not a bug: nothing older than 2 hours is still on the server, so the window in which a re-fetch can duplicate an already-saved note is small and self-clearing.

## Agent skills

### Issue tracker

Issues tracked as GitHub Issues in this repo (`marr00n/email2obsidian-plugin-releases`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — `CONTEXT.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.
