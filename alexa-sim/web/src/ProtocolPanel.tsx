import { useEffect, useRef, useState } from 'react';
import type { RpcEntry } from './api';

function time(t: number) {
  const d = new Date(t);
  return `${d.toLocaleTimeString('en-GB', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function summary(e: RpcEntry): string {
  const body = e.body as any;
  if (e.method === 'tools/call' && e.kind === 'request') return body?.params?.name ?? '';
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
  const label = e.method ?? (e.kind === 'error' ? 'error' : 'response');
  return (
    <li className={`rpc rpc-${e.dir} rpc-${e.kind}`}>
      <button type="button" className="rpc-head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="rpc-arrow" aria-label={out ? 'client to server' : 'server to client'}>
          {out ? '→' : '←'}
        </span>
        <span className="rpc-method">{label}</span>
        <span className={`rpc-kind rpc-kind-${e.kind}`}>{e.kind === 'request' && e.dir === 'in' ? 'server request' : e.kind}</span>
        {e.id !== null && e.id !== undefined && <span className="rpc-id">#{String(e.id)}</span>}
        <span className="rpc-sum">{summary(e)}</span>
        <span className="rpc-ms">{e.ms !== null && e.ms !== undefined ? `${e.ms} ms` : time(e.t)}</span>
      </button>
      {e.note && <p className="rpc-note">{e.note}</p>}
      {open && <pre className="rpc-body">{JSON.stringify(e.body, null, 2)}</pre>}
    </li>
  );
}

interface Props {
  entries: RpcEntry[];
  profileName: string;
  collapsed: boolean;
  onToggle: () => void;
  onClear: () => void;
}

export function ProtocolPanel({ entries, profileName, collapsed, onToggle, onClear }: Props) {
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  return (
    <aside className={`protocol ${collapsed ? 'protocol-collapsed' : ''}`} aria-label="MCP protocol log">
      <header className="protocol-head">
        <button type="button" className="btn btn-ghost protocol-toggle" aria-expanded={!collapsed} onClick={onToggle}>
          {collapsed ? '◀ MCP' : 'MCP protocol ▶'}
        </button>
        {!collapsed && (
          <>
            <span className="protocol-sub">
              {profileName}'s session · {entries.length} messages
            </span>
            <button type="button" className="btn btn-ghost" onClick={onClear} aria-label="Clear the protocol view">
              Clear
            </button>
          </>
        )}
      </header>
      {!collapsed && (
        <>
          <p className="protocol-legend">
            <span>→ simulator to CareCircle server</span>
            <span>← server to simulator</span>
            <span>JSON-RPC 2.0 · MCP 2025-11-25 · Streamable HTTP</span>
          </p>
          <ol
            className="rpc-list"
            ref={list}
            onScroll={ev => {
              const el = ev.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {entries.length === 0 && <li className="rpc-empty">No traffic yet. Say something to open the MCP session.</li>}
            {entries.map(e => (
              <Row key={e.seq} e={e} />
            ))}
          </ol>
        </>
      )}
    </aside>
  );
}
