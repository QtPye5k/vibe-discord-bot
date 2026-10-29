# Vibe project instructions

## Keep GitHub synchronized

The project owner has authorized routine GitHub updates whenever we change Vibe.
For this workspace, the public repository is
<https://github.com/QtPye5k/vibe-discord-bot>.

- Complete the requested changes, review the diff, run checks appropriate to the
  change, then commit and sync the reviewed work to GitHub in the same task.
  Routine synchronization does not require another confirmation.
- Inspect the working tree, branch, remote, and outgoing commits first. Stage
  explicit intended paths and preserve unrelated or pre-existing user changes.
- Respect branch protections and required checks. Never force-push or rewrite
  published history. Use authenticated Git or the connected GitHub tools; never
  embed credentials in commands or remote URLs.
- Report what was synchronized and any actual blocker. Never claim a successful
  update when publication failed or remains incomplete.

## Keep private information local

- Never publish `.env` or its private variants. Only a sanitized `.env.example`
  with safe placeholders may be tracked.
- Keep API keys, bot tokens, webhook credentials, OAuth grants, private keys,
  service credentials, databases, logs, transcripts, recordings, user exports,
  backups, caches, and private service configuration out of GitHub.
- Review staged content and outgoing commits for personal information, private
  user/server identifiers, and sensitive values in examples, documentation,
  screenshots, commit messages, and pull request descriptions. Use synthetic
  values or placeholders; automated scanning cannot recognize all private data.
- Respect `.gitignore` and never force-add ignored private files. Preserve local
  credentials and runtime data instead of deleting them to clean the repository.
- After staging, run `pnpm check:publication` against the exact publication
  snapshot. Resolve every failure before committing or publishing; never bypass
  the guard or print detected secret values.
- Run relevant formatting, build, and regression checks for the change. Run
  `pnpm check` for substantial code changes. The publication guard runs separately
  because portable installations do not require Git.
