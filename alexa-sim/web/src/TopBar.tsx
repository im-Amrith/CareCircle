import type { Health } from './api';

/** "global.amazon.nova-2-lite-v1:0" -> "Nova 2 Lite" */
function modelName(id?: string) {
  if (!id) return 'Bedrock';
  const m = id.match(/nova-(\d+)-(\w+)/i);
  return m ? `Nova ${m[1]} ${m[2][0].toUpperCase()}${m[2].slice(1)}` : id.replace(/^global\./, '');
}

/** Wordmark and one quiet status pill: which brain is answering, and whether the server is up. */
export function TopBar({ health }: { health: Health | null }) {
  const reachable = !!health?.mcp.reachable;
  const brain =
    health?.brain.mode === 'bedrock' ? `${modelName(health.brain.model)}${health.brain.region ? ` · ${health.brain.region}` : ''}` : 'Mock mode';
  return (
    <header className="topbar">
      <h1 className="wordmark">CareCircle</h1>
      <p className="status-pill" title={reachable ? `CareCircle server at ${health?.mcp.url}` : 'The CareCircle server is not reachable'}>
        <span className={`status-dot${reachable ? '' : ' status-dot-off'}`} aria-hidden="true" />
        {reachable ? brain : 'Server offline'}
        <span className="sr-only">{reachable ? ', connected to the CareCircle server' : ''}</span>
      </p>
    </header>
  );
}
