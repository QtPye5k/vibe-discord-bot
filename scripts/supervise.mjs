import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HOUR = 3_600_000;
const STABLE = 300_000;

/** All restarts count toward the hourly bound; planned exit 75 does not count as a failure. */
export function restartDecision({ recent = [], startedAt, now, code, failures = 0 }) {
  const retained = recent.filter((at) => at > now - HOUR && at <= now);
  const stable = now - startedAt >= STABLE;
  const nextFailures = code === 75 ? (stable ? 0 : failures) : stable ? 1 : failures + 1;
  if (retained.length >= 10) return { allowed: false, recent: retained, failures: nextFailures, delayMs: 0 };
  return {
    allowed: true,
    recent: [...retained, now],
    failures: nextFailures,
    delayMs: code === 75 ? 1000 : Math.min(60_000, 1000 * 2 ** Math.min(10, Math.max(0, nextFailures - 1))),
  };
}

export function runSupervisor(options = {}) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const spawnProcess = options.spawnProcess ?? spawn;
  const signalSource = options.signalSource ?? process;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  const log =
    options.log ??
    ((event, fields) =>
      process.stdout.write(JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + '\n'));
  const graceMs = Math.max(1, Math.min(90_000, options.graceMs ?? 90_000));
  return new Promise((resolveExit) => {
    let child,
      restartTimer,
      shutdownTimer,
      stopping = false,
      finished = false,
      recent = [],
      failures = 0;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      if (restartTimer) clearTimer(restartTimer);
      if (shutdownTimer) clearTimer(shutdownTimer);
      signalSource.off('SIGINT', onInterrupt);
      signalSource.off('SIGTERM', onTerminate);
      resolveExit(code);
    };
    const shutdown = (signal) => {
      if (stopping || finished) return;
      stopping = true;
      if (restartTimer) {
        clearTimer(restartTimer);
        restartTimer = undefined;
      }
      if (!child) {
        finish(0);
        return;
      }
      log('supervisor.shutdown', { signal, graceMs });
      // Windows kill(SIGTERM) terminates immediately. The controlled child instead receives
      // a shutdown IPC message and gets the same bounded opportunity to drain its work.
      if (platform === 'win32' && child.connected) {
        try {
          child.send({ type: 'bot.shutdown', signal }, (error) => {
            if (error && !finished) child?.kill(signal);
          });
        } catch {
          child.kill(signal);
        }
      } else child.kill(signal);
      shutdownTimer = setTimer(() => {
        if (child && !finished) child.kill('SIGKILL');
      }, graceMs);
    };
    const onInterrupt = () => shutdown('SIGINT');
    const onTerminate = () => shutdown('SIGTERM');
    const launch = () => {
      restartTimer = undefined;
      if (stopping || finished) return;
      const startedAt = now();
      let spawnFailure = false;
      try {
        child = spawnProcess(process.execPath, [options.entry ?? resolve(root, 'scripts/start.mjs')], {
          cwd: options.cwd ?? root,
          env: { ...(options.env ?? process.env), BOT_SUPERVISED: '1' },
          windowsHide: true,
          shell: false,
          stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        });
      } catch {
        log('supervisor.spawn-failed', {});
        finish(1);
        return;
      }
      child.once('error', () => {
        spawnFailure = true;
      });
      child.once('close', (code, signal) => {
        child = undefined;
        if (stopping) {
          finish(0);
          return;
        }
        const decision = restartDecision({
          recent,
          failures,
          startedAt,
          now: now(),
          code: spawnFailure ? null : code,
        });
        recent = decision.recent;
        failures = decision.failures;
        log('supervisor.child-exit', {
          code,
          signal,
          planned: code === 75 && !spawnFailure,
          restartInMs: decision.allowed ? decision.delayMs : null,
        });
        if (!decision.allowed) {
          log('supervisor.restart-limit', { restartsInHour: recent.length });
          finish(1);
        } else restartTimer = setTimer(launch, decision.delayMs);
      });
    };
    signalSource.on('SIGINT', onInterrupt);
    signalSource.on('SIGTERM', onTerminate);
    launch();
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runSupervisor();
}
