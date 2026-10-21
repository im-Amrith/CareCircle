import type { Health } from './api';
import type { Layout } from './model';

interface Props {
  health: Health | null;
  layout: Layout;
  onLayout: (l: Layout) => void;
  muted: boolean;
  onMute: () => void;
}

export function TopBar({ health, layout, onLayout, muted, onMute }: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <div>
          <h1>CareCircle simulator</h1>
          <p className="tagline">Voice devices driving the CareCircle MCP server</p>
        </div>
      </div>
      <div className="segmented" role="radiogroup" aria-label="Layout">
        <button type="button" role="radio" aria-checked={layout === 'single'} className={layout === 'single' ? 'on' : ''} onClick={() => onLayout('single')}>
          One device
        </button>
        <button type="button" role="radio" aria-checked={layout === 'family'} className={layout === 'family' ? 'on' : ''} title="Two family members side by side, updating live" onClick={() => onLayout('family')}>
          Family view
        </button>
      </div>
      <div className="badges" aria-label="Status">
        <span className={`badge ${health?.mcp.reachable ? 'badge-ok' : 'badge-bad'}`} title={health?.mcp.url}>
          MCP {health?.mcp.reachable ? `· ${health.mcp.protocol ?? 'ok'}` : 'unreachable'}
        </span>
        <span className="badge" title={health?.brain.reason ?? health?.brain.region}>
          {health?.brain.mode === 'bedrock' ? `Bedrock · ${health.brain.model?.replace(/^global\./, '')}` : 'Mock router'}
        </span>
        <span className="badge" title={health?.speech.detail}>
          {health?.speech.mode === 'polly' ? `Polly · ${health.speech.voice}` : 'Browser voice'}
        </span>
        <button type="button" className="badge badge-button" onClick={onMute} aria-pressed={muted}>
          {muted ? 'Sound off' : 'Sound on'}
        </button>
      </div>
    </header>
  );
}
