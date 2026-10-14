import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  answerElicitation,
  connectProfile,
  fetchHealth,
  fetchRpc,
  resetProfile,
  streamTurn,
  type Elicitation,
  type Health,
  type ProfileId,
  type RpcEntry,
  type Speech,
  type ToolCall,
  type ToolResult,
  type TurnEvent,
  type Warning
} from './api';
import { AppView } from './AppView';
import { ResultCard } from './cards/Cards';
import { ElicitationCard, type ElicitationState } from './ElicitationCard';
import { ProtocolPanel } from './ProtocolPanel';
import { canListen, listenOnce, speak, stopSpeaking } from './voice';

/* ---------- model ---------- */

type Device = 'show8' | 'show15' | 'dot' | 'phone';
type Ring = 'idle' | 'listening' | 'thinking' | 'speaking';

type Item =
  | { kind: 'call'; call: ToolCall }
  | { kind: 'result'; result: ToolResult }
  | { kind: 'elicitation'; e: Elicitation }
  | { kind: 'warning'; w: Warning };

interface Turn {
  id: number;
  user: string;
  items: Item[];
  speech?: Speech;
  error?: string;
  pending: boolean;
}

interface ProfileState {
  turns: Turn[];
  rpc: RpcEntry[];
  lastSeq: number;
  /** Where the next poll starts. Turn events arrive out of band and can jump past an MCP App view's
   * own calls, so only a poll, which returns everything after its cursor, moves this. */
  polledSeq: number;
  clearedAt: number;
}

const PROFILES: { id: ProfileId; name: string; role: string }[] = [
  { id: 'rose', name: 'Rose', role: 'cared for' },
  { id: 'sam', name: 'Sam', role: 'son, coordinator' },
  { id: 'maya', name: 'Maya', role: 'daughter, helper' }
];

const DEVICES: { id: Device; label: string; hint: string }[] = [
  { id: 'show8', label: 'Show 8', hint: '8-inch smart display, landscape' },
  { id: 'show15', label: 'Show 15', hint: '15-inch smart display, landscape' },
  { id: 'dot', label: 'Dot', hint: 'Smart speaker, no screen' },
  { id: 'phone', label: 'Phone', hint: 'Phone app' }
];

const SUGGESTIONS: Record<ProfileId, string[]> = {
  rose: ['Good morning', 'I took my morning pills', 'I had a fall in the kitchen', 'Should I take an extra blood pressure tablet?', 'What do I take tonight?'],
  sam: ['How is Mom today?', 'Is she running low on anything?', 'Reorder it', 'Any updates?'],
  maya: ['How is Mom today?', 'What does Mom take tonight?', 'Mom says her knee hurts']
};

const emptyProfile = (): ProfileState => ({ turns: [], rpc: [], lastSeq: 0, polledSeq: 0, clearedAt: 0 });

const TOOL_LABEL: Record<string, string> = {
  get_care_status: 'Checking today’s care status…',
  list_medications: 'Looking up the medicine schedule…',
  log_medication: 'Logging the dose…',
  check_refills: 'Checking supplies…',
  request_refill: 'Starting a refill…',
  log_wellbeing: 'Adding a note…'
};

let nextTurnId = 1;

/* ---------- app ---------- */

export function App() {
  const [device, setDevice] = useState<Device>('show8');
  const [profile, setProfile] = useState<ProfileId>('rose');
  const [profiles, setProfiles] = useState<Record<ProfileId, ProfileState>>({ rose: emptyProfile(), sam: emptyProfile(), maya: emptyProfile() });
  const [busy, setBusy] = useState<Record<ProfileId, boolean>>({ rose: false, sam: false, maya: false });
  const [ring, setRing] = useState<Ring>('idle');
  const [draft, setDraft] = useState('');
  const [interim, setInterim] = useState('');
  const [muted, setMuted] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [banner, setBanner] = useState<{ tone: 'warn' | 'error'; text: string } | null>(null);
  const [elicit, setElicit] = useState<Record<string, ElicitationState>>({});
  /** Tool results whose MCP App view failed to load; they fall back to the native card. */
  const [appFailed, setAppFailed] = useState<Record<string, string>>({});
  const listener = useRef<{ stop: () => void } | null>(null);
  /** Server elicitationId -> our elicitation id, to match notifications/elicitation/complete. */
  const urlElicitations = useRef(new Map<string, string>());
  const screenBody = useRef<HTMLDivElement>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const current = profiles[profile];
  const profileName = PROFILES.find(p => p.id === profile)!.name;

  /* ----- state helpers ----- */

  const addRpc = useCallback((p: ProfileId, entries: RpcEntry[], polled = false) => {
    if (!entries.length) return;
    setProfiles(all => {
      const st = all[p];
      const polledSeq = polled ? Math.max(st.polledSeq, ...entries.map(e => e.seq)) : st.polledSeq;
      const seen = new Set(st.rpc.map(e => e.seq));
      const fresh = entries.filter(e => !seen.has(e.seq));
      if (!fresh.length) return polledSeq === st.polledSeq ? all : { ...all, [p]: { ...st, polledSeq } };
      const rpc = [...st.rpc, ...fresh].sort((a, b) => a.seq - b.seq).slice(-800);
      return { ...all, [p]: { ...st, rpc, polledSeq, lastSeq: Math.max(st.lastSeq, ...fresh.map(e => e.seq)) } };
    });
    // A URL elicitation finishes when the server says so.
    for (const e of entries) {
      if (e.method !== 'notifications/elicitation/complete') continue;
      const local = urlElicitations.current.get((e.body as any)?.params?.elicitationId);
      if (local) setElicit(s => ({ ...s, [local]: 'complete' }));
    }
  }, []);

  const updateTurn = useCallback((p: ProfileId, id: number, fn: (t: Turn) => Turn) => {
    setProfiles(all => ({ ...all, [p]: { ...all[p], turns: all[p].turns.map(t => (t.id === id ? fn(t) : t)) } }));
  }, []);

  /* ----- health, session and protocol log ----- */

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const h = await fetchHealth();
      if (alive) setHealth(h);
    };
    void tick();
    const timer = setInterval(tick, 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    connectProfile(profile)
      .then(() => fetchRpc(profile, 0).then(e => addRpc(profile, e, true)))
      .catch(err => setBanner({ tone: 'error', text: `Can't open ${profileName}'s MCP session. ${err.message}` }));
  }, [profile, profileName, addRpc]);

  const polledSeq = current.polledSeq;
  useEffect(() => {
    const timer = setInterval(() => {
      fetchRpc(profile, polledSeq).then(e => addRpc(profile, e, true));
    }, 2000);
    return () => clearInterval(timer);
  }, [profile, polledSeq, addRpc]);

  /* ----- a turn ----- */

  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      const p = profile;
      if (!text || busy[p]) return;
      stopSpeaking();
      setDraft('');
      setInterim('');
      const id = nextTurnId++;
      setProfiles(all => ({ ...all, [p]: { ...all[p], turns: [...all[p].turns, { id, user: text, items: [], pending: true }] } }));
      setBusy(b => ({ ...b, [p]: true }));
      setRing('thinking');
      let spoke: Promise<void> | null = null;
      const asked: string[] = [];

      const onEvent = (ev: TurnEvent) => {
        switch (ev.type) {
          case 'tool_call':
            updateTurn(p, id, t => ({ ...t, items: [...t.items, { kind: 'call', call: ev.data }] }));
            break;
          case 'tool_result':
            updateTurn(p, id, t => ({ ...t, items: [...t.items, { kind: 'result', result: ev.data }] }));
            break;
          case 'elicitation':
            asked.push(ev.data.id);
            if (ev.data.elicitationId) urlElicitations.current.set(ev.data.elicitationId, ev.data.id);
            setElicit(s => ({ ...s, [ev.data.id]: 'open' }));
            updateTurn(p, id, t => ({ ...t, items: [...t.items, { kind: 'elicitation', e: ev.data }] }));
            setRing('speaking');
            void speak(ev.data.message.replace(/https?:\/\/\S+/g, ''), undefined, mutedRef.current).then(() => setRing('thinking'));
            break;
          case 'warning':
            updateTurn(p, id, t => ({ ...t, items: [...t.items, { kind: 'warning', w: ev.data }] }));
            setBanner({ tone: 'warn', text: ev.data.message });
            break;
          case 'speech':
            updateTurn(p, id, t => ({ ...t, speech: ev.data }));
            setRing('speaking');
            spoke = speak(ev.data.text, ev.data.audio, mutedRef.current);
            break;
          case 'rpc':
            addRpc(p, [ev.data]);
            break;
          case 'error':
            updateTurn(p, id, t => ({ ...t, error: ev.data.message }));
            break;
          case 'done':
          case 'transcript':
            break;
        }
      };

      try {
        await streamTurn(p, text, onEvent);
      } catch (err) {
        updateTurn(p, id, t => ({ ...t, error: (err as Error).message }));
      } finally {
        updateTurn(p, id, t => ({ ...t, pending: false }));
        setBusy(b => ({ ...b, [p]: false }));
        // Anything still waiting on this turn can no longer be answered.
        setElicit(s => {
          const next = { ...s };
          for (const k of asked) if (next[k] === 'open' || next[k] === 'sending') next[k] = 'failed';
          return next;
        });
        if (spoke) await spoke;
        setRing('idle');
      }
    },
    [profile, busy, updateTurn, addRpc]
  );

  const answer = useCallback(async (e: Elicitation, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) => {
    setElicit(s => ({ ...s, [e.id]: 'sending' }));
    try {
      await answerElicitation(e.id, action, content);
      setElicit(s => ({ ...s, [e.id]: action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'cancelled' }));
    } catch {
      setElicit(s => ({ ...s, [e.id]: 'failed' }));
    }
  }, []);

  /** ui/message from an MCP App view: said in the conversation as if spoken, when free. */
  const fromApp = useCallback(
    (text: string) => {
      if (busy[profile]) return false;
      void submit(text);
      return true;
    },
    [busy, profile, submit]
  );

  /* ----- push to talk ----- */

  const talk = useCallback(async () => {
    if (ring === 'listening') {
      listener.current?.stop();
      return;
    }
    stopSpeaking();
    setRing('listening');
    try {
      const l = listenOnce(setInterim);
      listener.current = l;
      const heard = await l.done;
      listener.current = null;
      setRing('idle');
      if (heard) void submit(heard);
      else setInterim('');
    } catch (err) {
      setRing('idle');
      setBanner({ tone: 'warn', text: (err as Error).message });
    }
  }, [ring, submit]);

  const reset = useCallback(async () => {
    stopSpeaking();
    await resetProfile(profile);
    setProfiles(all => ({ ...all, [profile]: { ...emptyProfile(), lastSeq: all[profile].lastSeq, polledSeq: all[profile].polledSeq, clearedAt: all[profile].lastSeq } }));
    connectProfile(profile).catch(() => undefined);
  }, [profile]);

  // Keep the newest exchange in view on the device screen.
  useEffect(() => {
    const el = screenBody.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [current.turns, elicit, interim, device]);

  const visibleRpc = useMemo(() => current.rpc.filter(e => e.seq > current.clearedAt), [current.rpc, current.clearedAt]);
  const lastTurn = current.turns.at(-1);

  /* ----- render ----- */

  const checkoutOf = (t: Turn) => {
    const url = t.items.find((i): i is Extract<Item, { kind: 'elicitation' }> => i.kind === 'elicitation' && i.e.mode === 'url');
    if (!url) return undefined;
    return elicit[url.e.id] === 'complete' ? ('complete' as const) : ('pending' as const);
  };

  const renderTurns = (withCards: boolean) =>
    current.turns.map(t => (
      <article key={t.id} className="turn" aria-busy={t.pending}>
        <p className="said-user">
          <span className="sr-only">{profileName} said: </span>“{t.user}”
        </p>
        {t.items.map((it, i) => {
          if (it.kind === 'call')
            return t.pending && !t.items.some(x => x.kind === 'result' && x.result.id === it.call.id) ? (
              <p key={i} className="invoking" role="status">
                {it.call.invoking ?? TOOL_LABEL[it.call.name] ?? `Calling ${it.call.name}…`}
              </p>
            ) : null;
          if (it.kind === 'result') {
            if (!withCards) return null;
            const key = `${t.id}:${String(it.result.id)}`;
            if (it.result.uiResourceUri && !it.result.isError && health?.sandboxUrl && !appFailed[key]) {
              const call = t.items.find((x): x is Extract<Item, { kind: 'call' }> => x.kind === 'call' && x.call.id === it.result.id);
              return (
                <AppView
                  key={key}
                  profile={profile}
                  result={it.result}
                  args={call?.call.arguments ?? {}}
                  sandboxUrl={health.sandboxUrl}
                  onMessage={fromApp}
                  onFail={reason => setAppFailed(f => ({ ...f, [key]: reason }))}
                />
              );
            }
            return <ResultCard key={i} result={it.result} checkout={checkoutOf(t)} />;
          }
          if (it.kind === 'elicitation')
            return <ElicitationCard key={i} e={it.e} state={elicit[it.e.id] ?? 'open'} onAnswer={(a, c) => answer(it.e, a, c)} onDismiss={() => setElicit(s => ({ ...s, [it.e.id]: 'complete' }))} />;
          return (
            <p key={i} className="turn-warning" role="alert">
              ⚠ {it.w.message}
            </p>
          );
        })}
        {t.speech && <p className="said-alexa">{t.speech.text}</p>}
        {t.pending && !t.speech && !t.items.length && (
          <p className="invoking" role="status">
            Thinking…
          </p>
        )}
        {t.error && (
          <p className="turn-error" role="alert">
            {t.error}
          </p>
        )}
      </article>
    ));

  const ringEl = <div className={`ring ring-${ring}`} aria-hidden="true" />;

  let screen: React.ReactNode;
  if (device === 'dot') {
    const pendingElicitations = current.turns.flatMap(t => t.items.filter((i): i is Extract<Item, { kind: 'elicitation' }> => i.kind === 'elicitation'));
    screen = (
      <div className="dot-wrap">
        <div className={`dot dot-${ring}`}>
          {ringEl}
          <div className="dot-top" />
        </div>
        <div className="dot-caption" aria-live="polite">
          {interim && <p className="said-user">“{interim}”</p>}
          {lastTurn && !interim && <p className="said-user">“{lastTurn.user}”</p>}
          {lastTurn?.speech && <p className="said-alexa">{lastTurn.speech.text}</p>}
          {lastTurn?.items.filter(i => i.kind === 'warning').map((i, k) => (
            <p key={k} className="turn-warning" role="alert">
              ⚠ {(i as { w: Warning }).w.message}
            </p>
          ))}
        </div>
        {pendingElicitations
          .filter(i => {
            const st = elicit[i.e.id] ?? 'open';
            return st === 'open' || st === 'sending' || (i.e.mode === 'url' && st === 'accepted');
          })
          .map(i => (
            <div key={i.e.id} className="dot-companion">
              <p className="muted">On the companion phone:</p>
              <ElicitationCard e={i.e} state={elicit[i.e.id] ?? 'open'} onAnswer={(a, c) => answer(i.e, a, c)} onDismiss={() => setElicit(s => ({ ...s, [i.e.id]: 'complete' }))} />
            </div>
          ))}
      </div>
    );
  } else {
    screen = (
      <div className={`frame frame-${device}`}>
        <div className="screen">
          <header className="screen-bar">
            <span>{device === 'phone' ? 'CareCircle' : profileName}</span>
            <span className="screen-time">{health?.mcp.reachable ? 'Connected' : 'Offline'}</span>
          </header>
          <div className="screen-body" aria-live="polite" ref={screenBody}>
            {current.turns.length === 0 && (
              <div className="screen-idle">
                <p className="idle-hello">Hi {profileName}</p>
                <p className="muted">Try “{SUGGESTIONS[profile][0]}”</p>
              </div>
            )}
            {renderTurns(true)}
            {interim && <p className="said-user said-interim">“{interim}”</p>}
          </div>
          {ringEl}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>CareCircle simulator</h1>
            <p className="tagline">A voice device driving the CareCircle MCP server</p>
          </div>
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
        </div>
      </header>

      {banner && (
        <div className={`banner banner-${banner.tone}`} role="alert">
          <span>
            {banner.tone === 'warn' ? '⚠ ' : ''}
            {banner.text}
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => setBanner(null)} aria-label="Dismiss message">
            ✕
          </button>
        </div>
      )}

      <div className="layout">
        <main className="stage">
          <div className="controls">
            <div className="segmented" role="radiogroup" aria-label="Device">
              {DEVICES.map(d => (
                <button key={d.id} type="button" role="radio" aria-checked={device === d.id} title={d.hint} className={device === d.id ? 'on' : ''} onClick={() => setDevice(d.id)}>
                  {d.label}
                </button>
              ))}
            </div>
            <div className="segmented" role="radiogroup" aria-label="Who is speaking">
              {PROFILES.map(p => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={profile === p.id}
                  title={p.role}
                  className={profile === p.id ? 'on' : ''}
                  onClick={() => {
                    stopSpeaking();
                    setProfile(p.id);
                  }}
                >
                  {p.name}
                  {busy[p.id] ? ' …' : ''}
                </button>
              ))}
            </div>
          </div>

          <div className={`device device-${device}`}>{screen}</div>

          <form
            className="inputbar"
            onSubmit={ev => {
              ev.preventDefault();
              void submit(draft);
            }}
          >
            <button
              type="button"
              className={`talk talk-${ring}`}
              onClick={talk}
              disabled={!canListen() || busy[profile]}
              aria-label={ring === 'listening' ? 'Stop listening' : 'Push to talk'}
              title={canListen() ? 'Push to talk' : 'Voice input needs Chrome or Edge; type instead'}
            >
              <span className="talk-dot" aria-hidden="true" />
            </button>
            <label className="sr-only" htmlFor="say">
              What {profileName} says
            </label>
            <input id="say" value={draft} onChange={e => setDraft(e.target.value)} placeholder={`Type what ${profileName} says…`} autoComplete="off" disabled={busy[profile]} />
            <button type="submit" className="btn btn-primary" disabled={!draft.trim() || busy[profile]}>
              Send
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setMuted(m => !m)} aria-pressed={muted} aria-label={muted ? 'Unmute speech' : 'Mute speech'}>
              {muted ? 'Unmute' : 'Mute'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={reset} disabled={busy[profile]} aria-label={`Start a new conversation for ${profileName}`}>
              New chat
            </button>
          </form>

          <div className="suggestions" aria-label="Try saying">
            {SUGGESTIONS[profile].map(s => (
              <button key={s} type="button" className="suggestion" disabled={busy[profile]} onClick={() => void submit(s)}>
                {s}
              </button>
            ))}
          </div>
        </main>

        <ProtocolPanel
          entries={visibleRpc}
          profileName={profileName}
          collapsed={panelCollapsed}
          onToggle={() => setPanelCollapsed(c => !c)}
          onClear={() => setProfiles(all => ({ ...all, [profile]: { ...all[profile], clearedAt: all[profile].lastSeq } }))}
        />
      </div>
    </div>
  );
}
