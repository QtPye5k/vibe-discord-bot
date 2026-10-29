# Security policy

## Report privately

Do not post exploit details, credentials or private user data in a public issue or pull request. If this repository offers **Security → Advisories → Report a vulnerability**, use that private form. Its availability depends on the repository's settings; this file does not enable it. See [GitHub's private reporting instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).

If the private form is unavailable and no private contact is listed, open an issue asking only for a private security reporting channel. Withhold the vulnerability details until a private channel is agreed. No response deadline or remediation schedule is guaranteed.

Include the affected commit/version, relevant feature and configuration names without secret values, required attacker access, expected versus observed behavior, impact, and a minimal reproduction using synthetic data. Do not attach a real `.env`, production database, backup, private transcript or voice recording, even to demonstrate the issue.

If a bot token, API key, webhook credential or other secret is exposed, revoke or rotate it with its provider promptly. Deleting a post or rewriting a commit does not invalidate a leaked credential.

## Scope and expected boundaries

Vibe is a locally hosted Discord bot with SQLite state and optional provider adapters, HTTP companions, trusted plugins and fixed host tasks. Relevant security issues include unauthorized actions or data disclosure across servers/users, bypassed permission or confirmation checks, capture/delivery after consent withdrawal, exposed credentials, unsafe file/network processing, and reachable resource-exhaustion paths. A missing optional credential or a Discord hierarchy restriction alone is a setup issue.

Authorization must use the current requesting member and bot permissions. AI output and remote content must not grant authority. Voice capture requires individual consent, private transcript delivery and cancellation checks. Untrusted files and network responses need bounded processing. These are requirements for review, not a claim that every implementation is defect-free.

Local plugins and operator-approved host tasks execute with the host's authority; review them before enabling them. Host administrators can access local credentials and stored data. These deployment assumptions do not exclude reports of untrusted input crossing into host authority.

## Safe investigation

Use your own isolated installation, credentials, synthetic records and test server. Do not probe other installations or obtain other people's messages, recordings or accounts. Check current source and dependency versions when reporting; this project does not promise a maintained security backport schedule for older versions.
