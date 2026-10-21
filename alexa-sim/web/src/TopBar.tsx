import { AudioLines, Cpu, Plug } from 'lucide-react';
import type { Health } from './api';
import type { Layout } from './model';

interface Props {
  health: Health | null;
  layout: Layout;
  onLayout: (l: Layout) => void;
  muted: boolean;
}

export function TopBar({ health, layout, onLayout, muted }: Props) {
  const reachable = !!health?.mcp.reachable;
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <h1>CareCircle</h1>
        <span className="brand-note">Simulated Alexa+ experience</span>
      </div>
      <div className="segmented" role="radiogroup" aria-label="Layout">
        <button type="button" role="radio" aria-checked={layout === 'single'} className={layout === 'single' ? 'on' : ''} onClick={() => onLayout('single')}>
          One device
        </button>
        <button type="button" role="radio" aria-checked={layout === 'family'} className={layout === 'family' ? 'on' : ''} title="Two family members side by side, updating live" onClick={() => onLayout('family')}>
          Family view
        </button>
      </div>
      <ul className="badges" aria-label="Status">
        <li className={`badge ${reachable ? 'badge-ok' : 'badge-bad'}`} title={health?.mcp.url}>
          <Plug aria-hidden="true" />
          {reachable ? 'MCP connected' : 'MCP unreachable'}
        </li>
        <li className="badge" title={health?.brain.reason ?? health?.brain.region}>
          <Cpu aria-hidden="true" />
          {health?.brain.mode === 'bedrock' ? `Bedrock · ${health.brain.model?.replace(/^global\./, '')}` : 'Mock mode'}
        </li>
        <li className="badge" title={health?.speech.detail}>
          <AudioLines aria-hidden="true" />
          {health?.speech.mode === 'polly' ? `Polly · ${health.speech.voice}` : 'Browser voice'}
          {muted ? ' · muted' : ''}
        </li>
      </ul>
    </header>
  );
}
