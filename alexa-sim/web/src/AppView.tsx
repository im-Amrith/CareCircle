import { useEffect, useRef, useState } from 'react';
import { appToolCall, fetchUiResource, type ProfileId, type ToolResult, type UiResource } from './api';

/**
 * Host side of MCP Apps (io.modelcontextprotocol/ui, spec 2026-01-26) for one tool result.
 *
 * The view runs inside the orchestrator's sandbox proxy, which is on a different origin from this
 * page and renders the view's HTML in an inner iframe with no origin at all. All talk is JSON-RPC
 * over postMessage:
 *   proxy -> host  ui/notifications/sandbox-proxy-ready    host -> proxy  sandbox-resource-ready {html, csp}
 *   view  -> host  ui/initialize, ui/notifications/initialized, size-changed,
 *                  tools/call (relayed to the orchestrator, app-visible tools only), ui/message, ui/open-link
 *   host  -> view  ui/notifications/tool-input, tool-result, ui/resource-teardown
 */

export const MCP_APPS_PROTOCOL = '2026-01-26';
const HOST_INFO = { name: 'CareCircle Alexa+ Simulator', version: '0.2.0' };
const MAX_HEIGHT = 900;

type Json = Record<string, any>;

interface Props {
  profile: ProfileId;
  result: ToolResult;
  args: Record<string, unknown>;
  sandboxUrl: string;
  /** The view asked to say something in the conversation (ui/message). Resolves false if busy. */
  onMessage: (text: string) => boolean;
  /** Loading or the handshake failed: show the native card instead. */
  onFail: (reason: string) => void;
}

export function AppView({ profile, result, args, sandboxUrl, onMessage, onFail }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [view, setView] = useState<UiResource | null>(null);
  const [height, setHeight] = useState(320);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const latest = useRef({ onMessage, onFail, result, args });
  latest.current = { onMessage, onFail, result, args };

  const uri = result.uiResourceUri!;
  const src = `${sandboxUrl}?host=${encodeURIComponent(window.location.origin)}`;
  const sandboxOrigin = new URL(sandboxUrl).origin;

  useEffect(() => {
    let alive = true;
    fetchUiResource(profile, uri)
      .then(v => alive && setView(v))
      .catch(err => alive && latest.current.onFail((err as Error).message));
    return () => {
      alive = false;
    };
  }, [profile, uri]);

  useEffect(() => {
    if (!view) return;
    const post = (msg: Json) => frame.current?.contentWindow?.postMessage({ jsonrpc: '2.0', ...msg }, sandboxOrigin);
    const reply = (id: unknown, result: Json) => post({ id, result });
    const fail = (id: unknown, code: number, message: string) => post({ id, error: { code, message } });

    const onMessageEvent = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== sandboxOrigin) return;
      const msg = event.data as Json;
      if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return;
      const { id, method, params = {} } = msg;

      switch (method) {
        case 'ui/notifications/sandbox-proxy-ready':
          post({ method: 'ui/notifications/sandbox-resource-ready', params: { html: view.html, csp: view.csp, sandbox: 'allow-scripts' } });
          return;
        case 'ui/initialize': {
          const box = frame.current?.getBoundingClientRect();
          reply(id, {
            protocolVersion: MCP_APPS_PROTOCOL,
            hostInfo: HOST_INFO,
            hostCapabilities: { openLinks: {}, serverTools: {}, logging: {} },
            hostContext: {
              toolInfo: { id: result.id, tool: { name: result.name } },
              theme: 'dark',
              displayMode: 'inline',
              availableDisplayModes: ['inline'],
              containerDimensions: { width: Math.round(box?.width ?? 0), maxHeight: MAX_HEIGHT },
              locale: navigator.language,
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              platform: 'web',
              deviceCapabilities: { touch: navigator.maxTouchPoints > 0, hover: window.matchMedia('(hover: hover)').matches }
            }
          });
          return;
        }
        case 'ui/notifications/initialized': {
          const r = latest.current.result;
          post({ method: 'ui/notifications/tool-input', params: { arguments: latest.current.args } });
          post({
            method: 'ui/notifications/tool-result',
            params: { content: [{ type: 'text', text: r.text }], structuredContent: r.structuredContent, isError: r.isError }
          });
          setReady(true);
          return;
        }
        case 'ui/notifications/size-changed':
          if (typeof params.height === 'number') setHeight(Math.min(MAX_HEIGHT, Math.max(80, Math.ceil(params.height))));
          return;
        case 'tools/call':
          try {
            reply(id, await appToolCall(profile, String(params.name ?? ''), params.arguments ?? {}));
          } catch (err) {
            fail(id, -32603, (err as Error).message);
          }
          return;
        case 'ui/message': {
          const text = (Array.isArray(params.content) ? params.content : [params.content])
            .filter((c: Json) => c?.type === 'text')
            .map((c: Json) => String(c.text))
            .join(' ')
            .trim()
            .slice(0, 500);
          if (!text) return fail(id, -32602, 'ui/message needs text content');
          return latest.current.onMessage(text) ? reply(id, {}) : fail(id, -32000, 'Busy with another request; try again in a moment');
        }
        case 'ui/open-link': {
          const url = String(params.url ?? '');
          if (!/^https?:\/\//i.test(url)) return fail(id, -32602, 'Only http and https links can be opened');
          window.open(url, '_blank', 'noopener,noreferrer');
          return reply(id, {});
        }
        case 'notifications/message':
          console.info('[MCP App]', params.level ?? 'info', params.data);
          return;
        case 'ping':
          return reply(id, {});
        default:
          if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
      }
    };

    window.addEventListener('message', onMessageEvent);
    const handshake = setTimeout(() => {
      if (!readyRef.current) latest.current.onFail('The app view did not start');
    }, 8000);
    return () => {
      clearTimeout(handshake);
      window.removeEventListener('message', onMessageEvent);
    };
  }, [view, profile, result.id, result.name, sandboxOrigin]);

  // Tell the view before it goes away, as the spec asks; it has no state to save, so don't wait.
  useEffect(() => {
    const win = frame;
    return () => win.current?.contentWindow?.postMessage({ jsonrpc: '2.0', id: 'teardown', method: 'ui/resource-teardown', params: { reason: 'unmount' } }, sandboxOrigin);
  }, [sandboxOrigin]);

  if (!view) {
    return (
      <div className="app-view app-view-loading" role="status">
        Loading the interactive view…
      </div>
    );
  }
  return (
    <div className={`app-view${view.prefersBorder === false ? ' app-view-bare' : ''}`}>
      <iframe
        ref={frame}
        src={src}
        title={`${result.name} interactive view`}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        style={{ height }}
      />
      <p className="app-view-tag">
        MCP App · <code>{uri}</code>
      </p>
    </div>
  );
}
