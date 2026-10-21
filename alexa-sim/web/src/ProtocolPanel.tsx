import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, PanelRightClose, PanelRightOpen, Trash2 } from 'lucide-react';
import type { RpcEntry } from './api';
import type { Turn } from './model';

function time(t: number) {
  const d = new Date(t);
  return `${d.toLocaleTimeString('en-GB', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/**
 * The client first asks for a newer protocol version with server/discover; a 2025-11-25 server
 * rejects it and the client falls back to initialize. That's expected, so it isn't shown as an error.
 */
const isVersionProbe = (e: RpcEntry) => e.method === 'server/discover';

type Tone = 'request' | 'response' | 'notification' | 'elicitation' | 'info' | 'error';

function toneOf(e: RpcEntry): Tone {
  if (isVersionProbe(e)) return 'info';
  if (e.method?.startsWith('elicitation/') || e.method === 'notifications/elicitation/complete') return 'elicitation';
  if (e.kind === 'error') return 'error';
  if (e.kind === 'request' && e.dir === 'in') return 'elicitation';
  return e.kind as Tone;
}

const TONE_LABEL: Record<Tone, string> = {
  request: 'request',
  response: 'response',
  notification: 'notification',
  elicitation: 'elicitation',
  info: 'version probe',
  error: 'error'
};

function summary(e: RpcEntry): string {
  const body = e.body as any;
  if (isVersionProbe(e)) return e.kind === 'request' ? 'asks for a newer version' : 'not supported, so initialize';
  if (e.method === 'tools/call' && e.kind === 'request')
    return `${body?.params?.name ?? ''}${body?.params?._meta?.['carecircle.sim/origin'] === 'app' ? ' · from app view' : ''}`;
  if (e.method === 'resources/read' && e.kind === 'request') return body?.params?.uri ?? '';
  if (e.method === 'tools/call' && e.kind === 'response') {
    const sc = body?.result?.structuredContent;
    return body?.result?.isError ? 'isError' : sc?.result ? `result: ${sc.result}` : 'ok';
  }
  if (e.method === 'tools/list' && e.kind === 'response') return `${body?.result?.tools?.length ?? 0} tools`;
  if (e.method === 'initialize' && e.kind === 'request') return `v${body?.params?.protocolVersion}`;
  if (e.method === 'initialize' && e.kind === 'response') return `v${body?.result?.protocolVersion}`;
  if (e.method === 'elicitation/create' && e.kind === 'request') return body?.params?.mode ?? 'form';
  if (e.method === 'elicitation/create' && e.kind === 'response') return body?.result?.action ?? '';
  if (e.kind === 'error') return body?.error?.message ?? 'error';
  return '';
}

function Row({ e }: { e: RpcEntry }) {
  const [open, setOpen] = useState(false);
  const out = e.dir === 'out';
  const tone = toneOf(e);
  const label = e.method ?? (e.kind === 'error' ? 'error' : 'response');
  return (
    <li className={`rpc rpc-${tone}`}>
      <button type="button" className="rpc-head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="rpc-arrow" aria-label={out ? 'simulator to server' : 'server to simulator'}>
          {out ? '→' : '←'}
        </span>
        <span className="rpc-main">
          <span className="rpc-method">{label}</span>
          <span className="rpc-sum">{summary(e)}</span>
        </span>
        <span className="rpc-kind">{e.kind === 'request' && e.dir === 'in' ? 'server request' : TONE_LABEL[tone]}</span>
        <span className="rpc-ms">{e.ms !== null && e.ms !== undefined ? `${e.ms} ms` : time(e.t)}</span>
      </button>
      {e.note ? (
        <p className="rpc-note">{e.note}</p>
      ) : (
        isVersionProbe(e) && e.dir === 'in' && <p className="rpc-note">Expected: the client tries the newest MCP version first and falls back to initialize.</p>
      )}
      {open && <pre className="rpc-body">{JSON.stringify(e.body, null, 2)}</pre>}
    </li>
  );
}

interface Group {
  key: string;
  title: string;
  entries: RpcEntry[];
}

/** One group per turn, from the turn's first message until the next turn starts. */
function groupByTurn(entries: RpcEntry[], turns: Turn[], who: string): Group[] {
  const starts = turns.map(t => ({ seq: t.startSeq, title: `${who} said “${t.user}”`, key: `t${t.id}` }));
  const groups: Group[] = [{ key: 'setup', title: 'Session setup', entries: [] }];
  for (const e of entries) {
    let g = groups[0];
    for (let i = starts.length - 1; i >= 0; i--) {
      if (e.seq > starts[i].seq) {
        g = groups.find(x => x.key === starts[i].key) ?? (groups.push({ key: starts[i].key, title: starts[i].title, entries: [] }), groups.at(-1)!);
        break;
      }
    }
    g.entries.push(e);
  }
  return groups.filter(g => g.entries.length);
}

function GroupView({ g, open, onToggle }: { g: Group; open: boolean; onToggle: () => void }) {
  const tools = g.entries.filter(e => e.method === 'tools/call' && e.kind === 'request').map(e => (e.body as any)?.params?.name as string);
  const ms = g.entries.filter(e => e.kind === 'response' && e.method === 'tools/call').reduce((sum, e) => sum + (e.ms ?? 0), 0);
  return (
    <li className="rpc-group">
      <button type="button" className="rpc-group-head" aria-expanded={open} onClick={onToggle}>
        {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        <span className="rpc-group-title">{g.title}</span>
        <span className="rpc-group-meta">
          {tools.length ? (
            <>
              <code>tools/call {tools.join(', ')}</code> · {Math.round(ms * 10) / 10} ms
            </>
          ) : (
            `${g.entries.length} messages`
          )}
        </span>
      </button>
      {open && (
        <ol className="rpc-list">
          {g.entries.map(e => (
            <Row key={e.seq} e={e} />
          ))}
        </ol>
      )}
    </li>
  );
}

interface Props {
  entries: RpcEntry[];
  turns: Turn[];
  profileName: string;
  protocol?: string;
  collapsed: boolean;
  onToggle: () => void;
  onClear: () => void;
}

export function ProtocolPanel({ entries, turns, profileName, protocol, collapsed, onToggle, onClear }: Props) {
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const groups = useMemo(() => groupByTurn(entries, turns, profileName), [entries, turns, profileName]);
  // The newest group is open; the reader can open or fold any other.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const newest = groups.at(-1)?.key;

  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries.length, collapsed]);

  if (collapsed) {
    return (
      <aside className="hood hood-collapsed" aria-label="Under the hood: MCP protocol log">
        <button type="button" className="hood-open" aria-expanded={false} onClick={onToggle}>
          <PanelRightOpen aria-hidden="true" />
          <span>Under the hood</span>
          <span className="hood-count">{entries.length}</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="hood" aria-label="Under the hood: MCP protocol log">
      <header className="hood-head">
        <div className="hood-title">
          <h2>Under the hood</h2>
          <p className="hood-chip">
            MCP {protocol ?? '2025-11-25'} · Streamable HTTP · {profileName}’s session
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={onClear} aria-label="Clear the protocol view" title="Clear">
          <Trash2 aria-hidden="true" />
        </button>
        <button type="button" className="icon-btn" aria-expanded={true} onClick={onToggle} aria-label="Hide under the hood" title="Hide">
          <PanelRightClose aria-hidden="true" />
        </button>
      </header>
      <p className="hood-legend">
        <span className="lg lg-request">request</span>
        <span className="lg lg-response">response</span>
        <span className="lg lg-notification">notification</span>
        <span className="lg lg-elicitation">elicitation</span>
        <span className="lg lg-info">info</span>
      </p>
      <ol
        className="rpc-groups"
        ref={list}
        onScroll={ev => {
          const el = ev.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {groups.length === 0 && <li className="rpc-empty">No traffic yet. Say something to open the MCP session.</li>}
        {groups.map(g => {
          const open = toggled[g.key] ?? g.key === newest;
          return <GroupView key={g.key} g={g} open={open} onToggle={() => setToggled(t => ({ ...t, [g.key]: !open }))} />;
        })}
      </ol>
    </aside>
  );
}
