# CLAUDE.md

## Git Commits

- NEVER add a `Co-Authored-By` trailer or any other attribution that lists Claude as a co-author or contributor in git commits.

## Releases

- Every push to main MUST be accompanied by a version tag (e.g., `git tag 3.1.1 && git push origin main && git push origin 3.1.1`).
- Every commit must have a meaningful commit message — if the user hasn't provided one, suggest one, and prompt them for to agree or edit it before committing.
- The release workflow uses the commit message as the release body. Missing or empty commit messages result in releases with no description, which harms the plugin's health rating.

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
