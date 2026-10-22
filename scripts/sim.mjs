// Starts the CareCircle MCP server (8000), the simulator orchestrator (8100) and the
// web app (5173) together, with prefixed output. Ctrl+C stops all three.
//
//   npm run sim          real clock; Bedrock + Polly if AWS credentials are found
//   npm run sim:demo     clock frozen at 9 am IST, so the demo script always matches
//   npm run sim:mock     no AWS calls at all (and the frozen clock)
//   node scripts/sim.mjs --pytest   runs the orchestrator tests
import { spawn, spawnSync } from 'node:child_process';
import { IS_WIN, ORCH, SERVER, WEB, npmSpawn, venvPython } from './common.mjs';

const args = new Set(process.argv.slice(2));
const python = venvPython();
if (!python) {
  console.error('The orchestrator environment is missing. Run:  npm run setup');
  process.exit(1);
}

if (args.has('--pytest')) {
  const r = spawnSync(python, ['-m', 'pytest', '-q'], { cwd: ORCH, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const DEMO_NOW = '2026-10-10T03:30:00Z';
const base = { ...process.env, FORCE_COLOR: '1' };
const procs = [
  {
    name: 'server',
    color: 36,
    // Plain start (no file watching) so the demo's in-memory data is never reset mid-recording.
    ...npmSpawn(['exec', '--', 'tsx', 'src/index.ts']),
    cwd: SERVER,
    // Appointment options are ranked by the orchestrator's Strands care team (local ranking if it's down).
    env: { ...base, PORT: '8000', CARECIRCLE_PLANNER_URL: 'http://127.0.0.1:8100/plan/appointment', ...(args.has('--demo') ? { CARECIRCLE_NOW: DEMO_NOW } : {}) }
  },
  {
    name: 'orch',
    color: 35,
    cmd: python,
    shell: false,
    args: ['-m', 'uvicorn', 'carecircle_sim.app:app', '--host', '127.0.0.1', '--port', '8100'],
    cwd: ORCH,
    env: { ...base, MCP_URL: 'http://127.0.0.1:8000/mcp', PYTHONUNBUFFERED: '1', ...(args.has('--mock') ? { MOCK_AWS: '1' } : {}) },
    delayMs: 1500
  },
  { name: 'web', color: 33, ...npmSpawn(['run', 'dev']), cwd: WEB, env: base }
];

const children = [];
let stopping = false;

const prefix = (name, color) => `\x1b[${color}m${name.padEnd(6)}\x1b[0m|`;

function pipe(stream, name, color) {
  let buf = '';
  stream.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const line of lines) console.log(`${prefix(name, color)} ${line}`);
  });
}

function start(p) {
  if (stopping) return;
  const child = spawn(p.cmd, p.args, { cwd: p.cwd, env: p.env, shell: p.shell ?? false, stdio: ['ignore', 'pipe', 'pipe'] });
  pipe(child.stdout, p.name, p.color);
  pipe(child.stderr, p.name, p.color);
  child.on('exit', code => {
    if (!stopping) {
      console.log(`${prefix(p.name, p.color)} exited with code ${code}; stopping everything.`);
      stop(code ?? 1);
    }
  });
  children.push(child);
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null) continue;
    if (IS_WIN) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

const mode = [args.has('--demo') && `clock frozen at ${DEMO_NOW}`, args.has('--mock') && 'mock mode'].filter(Boolean).join(', ');
console.log(`Starting CareCircle${mode ? ` (${mode})` : ''}...`);
for (const p of procs) setTimeout(() => start(p), p.delayMs ?? 0);
setTimeout(() => !stopping && console.log('\n  Simulator:  http://127.0.0.1:5173\n'), 5000);
