// One-time setup: server and web dependencies, and the orchestrator's Python env.
// Uses uv when it is installed, otherwise python -m venv + pip.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { IS_WIN, ORCH, SERVER, WEB, findPython, has, npmSpawn, venvPython } from './common.mjs';

function run(cmd, args, cwd, shell = IS_WIN && !cmd.endsWith('.exe')) {
  console.log(`\n> ${[cmd, ...args].join(' ')}   (${cwd})`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell });
  if (r.status !== 0) {
    console.error(`\nSetup failed at: ${[cmd, ...args].join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

function npm(args, cwd) {
  const n = npmSpawn(args);
  run(n.cmd, n.args, cwd, n.shell);
}

npm([existsSync(join(SERVER, 'package-lock.json')) ? 'ci' : 'install'], SERVER);
npm([existsSync(join(WEB, 'package-lock.json')) ? 'ci' : 'install'], WEB);

if (has('uv')) {
  if (!venvPython()) run('uv', ['venv', '--python', '3.12', '.venv'], ORCH);
  run('uv', ['pip', 'install', '--python', venvPython(), '-e', '.[dev]'], ORCH);
} else {
  if (!venvPython()) {
    const py = findPython();
    if (!py) {
      console.error('Python 3.11 or later is required: https://www.python.org/downloads/');
      process.exit(1);
    }
    run(py[0], [...py.slice(1), '-m', 'venv', '.venv'], ORCH);
  }
  run(venvPython(), ['-m', 'pip', 'install', '--upgrade', 'pip'], ORCH);
  run(venvPython(), ['-m', 'pip', 'install', '-e', '.[dev]'], ORCH);
}

console.log('\nSetup done. Start everything with:  npm run sim:demo   (clock frozen at 9 am IST)  or  npm run sim');
