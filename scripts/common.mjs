// Shared helpers for the setup and run scripts. Plain Node, so they work the same on
// Windows PowerShell, macOS and Linux.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SERVER = join(ROOT, 'server');
export const ORCH = join(ROOT, 'alexa-sim', 'orchestrator');
export const WEB = join(ROOT, 'alexa-sim', 'web');
export const IS_WIN = process.platform === 'win32';
export const npmCmd = IS_WIN ? 'npm.cmd' : 'npm';

/**
 * How to run npm without a shell: through npm's own CLI script when we were started by
 * `npm run` (npm_execpath), else the npm binary (shell needed for npm.cmd on Windows).
 */
export function npmSpawn(args) {
  const cli = process.env.npm_execpath;
  if (cli && cli.endsWith('.js')) return { cmd: process.execPath, args: [cli, ...args], shell: false };
  return { cmd: npmCmd, args, shell: IS_WIN };
}

/** The orchestrator's virtualenv Python, or null if setup hasn't run. */
export function venvPython() {
  const p = IS_WIN ? join(ORCH, '.venv', 'Scripts', 'python.exe') : join(ORCH, '.venv', 'bin', 'python');
  return existsSync(p) ? p : null;
}

export function has(cmd, args = ['--version']) {
  return spawnSync(cmd, args, { stdio: 'ignore', shell: IS_WIN }).status === 0;
}

/** A Python 3.11+ launcher as [command, ...prefixArgs], or null. */
export function findPython() {
  const candidates = IS_WIN
    ? [['py', '-3.12'], ['py', '-3.13'], ['py', '-3.11'], ['python'], ['python3']]
    : [['python3.12'], ['python3.13'], ['python3.11'], ['python3'], ['python']];
  for (const [cmd, ...pre] of candidates) {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys; print(sys.version_info >= (3, 11))'], { encoding: 'utf8', shell: IS_WIN });
    if (r.status === 0 && r.stdout.trim() === 'True') return [cmd, ...pre];
  }
  return null;
}
