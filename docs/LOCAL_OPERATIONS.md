# Fixed local operations and process supervision

Local operations run only definitions reviewed and placed on the host. `LOCAL_OPERATIONS_MANIFEST` is blank by default. Set it to a local absolute JSON file to enable the task catalog. Application owner or `OPERATOR_IDS` access, current server/channel access, module/action policies and the ordinary human confirmation are required.

## Define a task

A manifest has `version:1` and up to twenty unique tasks. Each task fixes its executable, arguments, working directory and timeout. Example paths below are placeholders to replace locally:

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "maintenance-report",
      "description": "Run the reviewed local reporting script",
      "executable": "C:\\Program Files\\nodejs\\node.exe",
      "arguments": ["C:\\BotMaintenance\\report.mjs"],
      "cwd": "C:\\BotMaintenance",
      "timeoutSeconds": 30,
      "retrySafe": false
    }
  ]
}
```

The manifest is capped at 64 KiB. Executable and working-directory paths must be absolute local paths. Batch files require an explicitly configured interpreter with fixed arguments. Definitions cannot contain recognized credentials. The child receives a minimal environment without bot/provider keys or language startup hooks. Child tasks still execute as the host account; review the executable, referenced scripts and their filesystem permissions. This is not a sandbox.

`operation.tasks` returns each current `definitionHash`. Supply the exact `taskId` and hash to `operation.run`; confirm the reviewed definition. Discord input cannot add arbitrary arguments, paths, environment variables or shell text. The hash covers the definition, not the executable/script bytes, so review local file updates as well.

At most two subprocesses run concurrently. Each has a maximum sixty-second deadline and 64 KiB combined output, with credential redaction and terminal-control stripping. Excess output or timeout terminates the child and records the outcome. No operation is automatically retried, including definitions marked `retrySafe`.

## Schedule and recover

Use `operation.schedule.set` with an ID, task ID, exact hash and five-field **UTC** cron expression. There are at most ten schedules per server. Each run rechecks current definition, author/operator authority, channel access and policies. Failure or ambiguous interruption pauses the schedule. Reconfigure it deliberately after inspecting host state.

`operation.history` shows retained results; history is bounded to 100 runs per server and 1,000 overall. A process interrupted before its result was saved becomes `unknown` and blocks the same task from repeating. After inspecting host state, `operation.run.acknowledge` with `reviewedHostState:true` clears that block without executing or undoing anything. `operation.schedule.remove` cancels future occurrences; a started child is not recalled. Shutdown waits for tracked child tasks before closing SQLite.

## Supervision and restart

`pnpm start:supervised` runs the compiled bot under the included Node supervisor. A confirmed operator-only `system.restart` requests graceful shutdown and planned exit code 75. This action is available only when a supervisor is configured. Unexpected exits back off from one to sixty seconds; all restarts, including planned ones, are capped at ten per hour. Five minutes of stable runtime resets failure backoff. The supervisor forwards shutdown and grants up to ninety seconds before force termination.

`pnpm start` runs directly and supplies no automatic restart. Compose uses Docker's restart policy and sets `BOT_SUPERVISED=1` for planned restart support. Do not set that flag in a standalone launch without an actual process manager. Restart does not fetch, deploy or roll back code. Use [the backup/update procedure](OPERATIONS.md) for releases and [trusted plugins](PLUGINS.md) for local code extensions.
