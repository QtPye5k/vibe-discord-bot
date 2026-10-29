#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
command -v node >/dev/null || { echo 'Install Node.js 24.17+ within 24.x.' >&2; exit 1; }
command -v pnpm >/dev/null || { echo 'Install pnpm 11.25.0.' >&2; exit 1; }
command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || { echo 'Install FFmpeg and ffprobe on PATH.' >&2; exit 1; }
pnpm install --frozen-lockfile
pnpm configure
pnpm check
pnpm voice:prepare
if [ ! -f .env ]; then (umask 077; cp .env.example .env); fi
echo 'Setup complete. Configure .env, run ./check.sh, then ./start.sh.'
