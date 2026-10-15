import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  answerElicitation,
  connectProfile,
  fetchHealth,
  fetchRpc,
  openDeviceEvents,
  remindNow,
  resetProfile,
  setLanguage,
  streamTurn,
  type Elicitation,
  type FamilyMessage,
  type Health,
  type Language,
  type ProfileId,
  type RpcEntry,
  type Speech,
  type Today,
  type ToolCall,
  type ToolResult,
  type TurnEvent,
  type Warning
} from './api';
import { AppView } from './AppView';
import { ResultCard } from './cards/Cards';
import { ElicitationCard, type ElicitationState } from './ElicitationCard';
import { ProtocolPanel } from './ProtocolPanel';
import { announce, canListen, listenOnce, speak, stopSpeaking } from './voice';

/* ---------- model ---------- */

type Device = 'show8' | 'show15' | 'dot' | 'phone';
type Ring = 'idle' | 'listening' | 'thinking' | 'speaking' | 'notify';
type Layout = 'single' | 'family';

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

/** Something on the device that nobody asked for: a family alert, a dose reminder, a new summary. */
interface Notice {
  id: string;
  kind: 'alert' | 'reminder' | 'message';
  title: string;
  text: string;
}

/** Per-person accessibility settings, kept on the device. */
interface Prefs {
  slow: boolean;
  large: boolean;
}

interface Pane {
  profile: ProfileId;
  device: Device;
}

const PROFILES: { id: ProfileId; name: string; role: string }[] = [
  { id: 'rose', name: 'Rose', role: 'cared for' },
  { id: 'sam', name: 'Sam', role: 'son, coordinator' },
  { id: 'maya', name: 'Maya', role: 'daughter, helper' }
];
const nameOf = (p: ProfileId) => PROFILES.find(x => x.id === p)!.name;

const DEVICES: { id: Device; label: string; hint: string }[] = [
  { id: 'show8', label: 'Show 8', hint: '8-inch smart display, landscape' },
  { id: 'show15', label: 'Show 15', hint: '15-inch smart display, landscape' },
  { id: 'dot', label: 'Dot', hint: 'Smart speaker, no screen' },
  { id: 'phone', label: 'Phone', hint: 'Phone app' }
];

const SUGGESTIONS: Record<ProfileId, Record<Language, string[]>> = {
  rose: {
    en: ['Good morning', 'I took my morning pills', 'I had a fall in the kitchen', 'Should I take an extra blood pressure tablet?', 'What do I take tonight?', 'Say that again', 'Talk to me in Hindi'],
    hi: ['सुप्रभात', 'मैंने दवा ले ली', 'मैं रसोई में गिर गई', 'एक और गोली ले लूँ?', 'आज रात कौन सी दवा लेनी है', 'फिर से बोलो', 'Speak English']
  },
  sam: {
    en: ['How is Mom today?', 'Is she running low on anything?', 'Reorder it', 'Any updates?', 'Send everyone today’s summary'],
    hi: ['माँ का आज का हाल कैसा है', 'दवाई खत्म हो रही है क्या?', 'Speak English']
  },
  maya: {
    en: ['How is Mom today?', 'What does Mom take tonight?', 'Mom says her knee hurts', 'Say that again'],
    hi: ['माँ का आज का हाल कैसा है', 'Speak English']
  }
};

const emptyProfile = (): ProfileState => ({ turns: [], rpc: [], lastSeq: 0, polledSeq: 0, clearedAt: 0 });
const byProfile = <T,>(make: () => T): Record<ProfileId, T> => ({ rose: make(), sam: make(), maya: make() });

const TOOL_LABEL: Record<string, string> = {
  get_care_status: 'Checking today’s care status…',
  list_medications: 'Looking up the medicine schedule…',
  log_medication: 'Logging the dose…',
  check_refills: 'Checking supplies…',
  request_refill: 'Starting a refill…',
  log_wellbeing: 'Adding a note…',
  set_language: 'Changing the language…',
  send_daily_summary: 'Sending today’s summary…'
};

let nextTurnId = 1;

/* ---------- app ---------- */

export function App() {
  const [layout, setLayout] = useState<Layout>('single');
  const [panes, setPanes] = useState<Pane[]>([
    { profile: 'rose', device: 'show8' },
    { profile: 'sam', device: 'phone' }
  ]);
  /** The pane the protocol panel follows: the one last used. */
  const [focus, setFocus] = useState(0);
  const [profiles, setProfiles] = useState<Record<ProfileId, ProfileState>>(() => byProfile(emptyProfile));
  const [busy, setBusy] = useState<Record<ProfileId, boolean>>(() => byProfile(() => false));
  const [rings, setRings] = useState<Record<ProfileId, Ring>>(() => byProfile((): Ring => 'idle'));
  const [drafts, setDrafts] = useState<Record<ProfileId, string>>(() => byProfile(() => ''));
  const [interims, setInterims] = useState<Record<ProfileId, string>>(() => byProfile(() => ''));
  const [prefs, setPrefs] = useState<Record<ProfileId, Prefs>>({ rose: { slow: true, large: true }, sam: { slow: false, large: false }, maya: { slow: false, large: false } });
  const [live, setLive] = useState<Record<ProfileId, Today | null>>(() => byProfile((): Today | null => null));
  const [inbox, setInbox] = useState<Record<ProfileId, FamilyMessage[]>>(() => byProfile((): FamilyMessage[] => []));
  const [notices, setNotices] = useState<Record<ProfileId, Notice[]>>(() => byProfile((): Notice[] => []));
  const [muted, setMuted] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [banner, setBanner] = useState<{ tone: 'warn' | 'error'; text: string } | null>(null);
  const [elicit, setElicit] = useState<Record<string, ElicitationState>>({});
  /** Tool results whose MCP App view failed to load; they fall back to the native card. */
  const [appFailed, setAppFailed] = useState<Record<string, string>>({});
  const listeners = useRef<Partial<Record<ProfileId, { stop: () => void }>>>({});
  /** Server elicitationId -> our elicitation id, to match notifications/elicitation/complete. */
  const urlElicitations = useRef(new Map<string, string>());
  const screenBodies = useRef<Partial<Record<number, HTMLDivElement | null>>>({});
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const shown = layout === 'single' ? panes.slice(0, 1) : panes;
  const visible = useMemo(() => [...new Set(shown.map(p => p.profile))], [shown]);
  const visibleKey = visible.join(',');
  const panelProfile = shown[Math.min(focus, shown.length - 1)].profile;
  const langOf = useCallback((p: ProfileId): Language => live[p]?.viewer.language ?? 'en', [live]);

  /* ----- state helpers ----- */

  const setRing = useCallback((p: ProfileId, r: Ring) => setRings(all => ({ ...all, [p]: r })), []);

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

  const pushNotice = useCallback((p: ProfileId, n: Notice) => {
    setNotices(all => (all[p].some(x => x.id === n.id) ? all : { ...all, [p]: [...all[p], n].slice(-4) }));
  }, []);
  const dismissNotice = useCallback((p: ProfileId, id: string) => {
    setNotices(all => ({ ...all, [p]: all[p].filter(n => n.id !== id) }));
    setRings(all => (all[p] === 'notify' ? { ...all, [p]: 'idle' } : all));
  }, []);

  /* ----- health, sessions, protocol log ----- */

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
    connectProfile(panelProfile)
      .then(() => fetchRpc(panelProfile, 0).then(e => addRpc(panelProfile, e, true)))
      .catch(err => setBanner({ tone: 'error', text: `Can't open ${nameOf(panelProfile)}'s MCP session. ${err.message}` }));
  }, [panelProfile, addRpc]);

  const polledSeq = profiles[panelProfile].polledSeq;
  useEffect(() => {
    const timer = setInterval(() => {
      fetchRpc(panelProfile, polledSeq).then(e => addRpc(panelProfile, e, true));
    }, 2000);
    return () => clearInterval(timer);
  }, [panelProfile, polledSeq, addRpc]);

  /* ----- what each device hears outside its own turns ----- */

  useEffect(() => {
    const closers = visible.map(p => {
      let firstInbox = true;
      return openDeviceEvents(p, {
        today: t => setLive(all => ({ ...all, [p]: t })),
        inbox: messages => {
          setInbox(all => {
            // A message that wasn't there before pops up on the device; the backlog doesn't.
            if (!firstInbox) {
              const known = new Set(all[p].map(m => m.id));
              for (const m of messages) if (!known.has(m.id)) pushNotice(p, { id: m.id, kind: 'message', title: m.title, text: m.text });
            }
            firstInbox = false;
            return { ...all, [p]: messages };
          });
        },
        announcement: a => {
          pushNotice(p, { id: a.id, kind: a.kind, title: a.kind === 'alert' ? 'CareCircle alert' : 'Gentle reminder', text: a.text });
          setRing(p, 'notify');
          void announce(a.text, a.audio, { muted: mutedRef.current, lang: a.lang, slow: prefsRef.current[p].slow });
        }
      });
    });
    return () => closers.forEach(close => close());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, pushNotice, setRing]);

  /* ----- a turn ----- */

  const submit = useCallback(
    async (p: ProfileId, raw: string) => {
      const text = raw.trim();
      if (!text || busy[p]) return;
      stopSpeaking();
      setDrafts(d => ({ ...d, [p]: '' }));
      setInterims(d => ({ ...d, [p]: '' }));
      // Answering a reminder (or anything else) means it has been heard.
      setNotices(all => ({ ...all, [p]: all[p].filter(n => n.kind !== 'reminder') }));
      const id = nextTurnId++;
      setProfiles(all => ({ ...all, [p]: { ...all[p], turns: [...all[p].turns, { id, user: text, items: [], pending: true }] } }));
      setBusy(b => ({ ...b, [p]: true }));
      setRing(p, 'thinking');
      let spoke: Promise<void> | null = null;
      const asked: string[] = [];
      const slow = prefsRef.current[p].slow;

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
            setRing(p, 'speaking');
            void speak(ev.data.message.replace(/https?:\/\/\S+/g, ''), undefined, { muted: mutedRef.current, slow }).then(() => setRing(p, 'thinking'));
            break;
          case 'warning':
            updateTurn(p, id, t => ({ ...t, items: [...t.items, { kind: 'warning', w: ev.data }] }));
            setBanner({ tone: 'warn', text: ev.data.message });
            break;
          case 'speech':
            updateTurn(p, id, t => ({ ...t, speech: ev.data }));
            setRing(p, 'speaking');
            spoke = speak(ev.data.text, ev.data.audio, { muted: mutedRef.current, lang: ev.data.lang, slow: ev.data.slow ?? slow });
            break;
          case 'rpc':
            addRpc(p, [ev.data]);
            break;
          case 'error':
            updateTurn(p, id, t => ({ ...t, error: ev.data.message }));
            break;
          default:
            break;
        }
      };

      try {
        await streamTurn(p, text, onEvent, { slow });
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
        setRing(p, 'idle');
      }
    },
    [busy, updateTurn, addRpc, setRing]
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

  /* ----- push to talk ----- */

  const talk = useCallback(
    async (p: ProfileId) => {
      if (rings[p] === 'listening') {
        listeners.current[p]?.stop();
        return;
      }
      stopSpeaking();
      setRing(p, 'listening');
      try {
        const l = listenOnce(text => setInterims(d => ({ ...d, [p]: text })), langOf(p));
        listeners.current[p] = l;
        const heard = await l.done;
        delete listeners.current[p];
        setRing(p, 'idle');
        if (heard) void submit(p, heard);
        else setInterims(d => ({ ...d, [p]: '' }));
      } catch (err) {
        setRing(p, 'idle');
        setBanner({ tone: 'warn', text: (err as Error).message });
      }
    },
    [rings, submit, setRing, langOf]
  );

  const reset = useCallback(async (p: ProfileId) => {
    stopSpeaking();
    await resetProfile(p);
    setProfiles(all => ({ ...all, [p]: { ...emptyProfile(), lastSeq: all[p].lastSeq, polledSeq: all[p].polledSeq, clearedAt: all[p].lastSeq } }));
    setNotices(all => ({ ...all, [p]: [] }));
    connectProfile(p).catch(() => undefined);
  }, []);

  const changeLanguage = useCallback(async (p: ProfileId, language: Language) => {
    try {
      await setLanguage(p, language);
    } catch (err) {
      setBanner({ tone: 'error', text: `Couldn't change the language. ${(err as Error).message}` });
    }
  }, []);

  const remind = useCallback(async (p: ProfileId) => {
    try {
      const r = await remindNow(p);
      if (!r.reminded) setBanner({ tone: 'warn', text: `${nameOf(p)} has no overdue doses to be reminded about.` });
    } catch (err) {
      setBanner({ tone: 'error', text: (err as Error).message });
    }
  }, []);

  // Keep the newest exchange in view on each device screen.
  useEffect(() => {
    for (const el of Object.values(screenBodies.current)) if (el) el.scrollTop = el.scrollHeight;
  }, [profiles, elicit, interims, notices, panes, layout]);

  const current = profiles[panelProfile];
  const visibleRpc = useMemo(() => current.rpc.filter(e => e.seq > current.clearedAt), [current.rpc, current.clearedAt]);

  /* ----- render ----- */

  const checkoutOf = (t: Turn) => {
    const url = t.items.find((i): i is Extract<Item, { kind: 'elicitation' }> => i.kind === 'elicitation' && i.e.mode === 'url');
    if (!url) return undefined;
    return elicit[url.e.id] === 'complete' ? ('complete' as const) : ('pending' as const);
  };

  const renderTurns = (p: ProfileId) =>
    profiles[p].turns.map(t => (
      <article key={t.id} className="turn" aria-busy={t.pending}>
        <p className="said-user">
          <span className="sr-only">{nameOf(p)} said: </span>“{t.user}”
        </p>
        {t.items.map((it, i) => {
          if (it.kind === 'call')
            return t.pending && !t.items.some(x => x.kind === 'result' && x.result.id === it.call.id) ? (
              <p key={i} className="invoking" role="status">
                {it.call.invoking ?? TOOL_LABEL[it.call.name] ?? `Calling ${it.call.name}…`}
              </p>
            ) : null;
          if (it.kind === 'result') {
            const key = `${t.id}:${String(it.result.id)}`;
            if (it.result.uiResourceUri && !it.result.isError && health?.sandboxUrl && !appFailed[key]) {
              const call = t.items.find((x): x is Extract<Item, { kind: 'call' }> => x.kind === 'call' && x.call.id === it.result.id);
              return (
                <AppView
                  key={key}
                  profile={p}
                  result={it.result}
                  args={call?.call.arguments ?? {}}
                  sandboxUrl={health.sandboxUrl}
                  live={live[p]}
                  locale={langOf(p) === 'hi' ? 'hi-IN' : 'en-IN'}
                  largeText={prefs[p].large}
                  onMessage={text => {
                    if (busy[p]) return false;
                    void submit(p, text);
                    return true;
                  }}
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
        {t.speech && (
          <p className="said-alexa" lang={t.speech.lang === 'hi' ? 'hi' : undefined}>
            {t.speech.text}
          </p>
        )}
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

  const renderNotices = (p: ProfileId) =>
    notices[p].length > 0 && (
      <div className="notices" role="region" aria-label="Notifications">
        {notices[p].map(n => (
          <div key={n.id} className={`notice notice-${n.kind}`} role={n.kind === 'alert' ? 'alert' : 'status'}>
            <div className="notice-head">
              <strong>{n.kind === 'message' ? `Message · ${n.title}` : n.title}</strong>
              <button type="button" className="btn btn-ghost notice-close" onClick={() => dismissNotice(p, n.id)} aria-label="Dismiss">
                ✕
              </button>
            </div>
            <p className={n.kind === 'message' ? 'notice-text notice-pre' : 'notice-text'} lang={/[ऀ-ॿ]/.test(n.text) ? 'hi' : undefined}>
              {n.kind === 'message' ? n.text.split('\n').slice(2).join('\n') : n.text}
            </p>
          </div>
        ))}
      </div>
    );

  const renderScreen = (pane: Pane, index: number) => {
    const p = pane.profile;
    const ring = rings[p];
    const ringEl = <div className={`ring ring-${ring}`} aria-hidden="true" />;
    const turns = profiles[p].turns;
    const lastTurn = turns.at(-1);
    const interim = interims[p];
    if (pane.device === 'dot') {
      const pendingElicitations = turns.flatMap(t => t.items.filter((i): i is Extract<Item, { kind: 'elicitation' }> => i.kind === 'elicitation'));
      const notice = notices[p].at(-1);
      return (
        <div className="dot-wrap">
          <div className={`dot dot-${ring}`}>
            {ringEl}
            <div className="dot-top" />
          </div>
          <div className="dot-caption" aria-live="polite">
            {notice && <p className={`said-alexa dot-notice-${notice.kind}`}>{notice.kind === 'message' ? `New message: ${notice.title}` : notice.text}</p>}
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
    }
    const suggestion = SUGGESTIONS[p][langOf(p)][0];
    return (
      <div className={`frame frame-${pane.device}`}>
        <div className={`screen${prefs[p].large ? ' screen-large' : ''}`}>
          <header className="screen-bar">
            <span>{pane.device === 'phone' ? `CareCircle · ${nameOf(p)}` : nameOf(p)}</span>
            <span className="screen-time">{health?.mcp.reachable ? 'Connected' : 'Offline'}</span>
          </header>
          <div className="screen-body" aria-live="polite" ref={el => {
              screenBodies.current[index] = el;
            }}>
            {turns.length === 0 && !notices[p].length && (
              <div className="screen-idle">
                <p className="idle-hello">{langOf(p) === 'hi' ? `नमस्ते ${nameOf(p)}` : `Hi ${nameOf(p)}`}</p>
                <p className="muted">Try “{suggestion}”</p>
              </div>
            )}
            {renderTurns(p)}
            {interim && <p className="said-user said-interim">“{interim}”</p>}
            {renderNotices(p)}
          </div>
          {ringEl}
        </div>
      </div>
    );
  };

  const renderPane = (pane: Pane, index: number) => {
    const p = pane.profile;
    const lang = langOf(p);
    const other = layout === 'family' ? panes[1 - index].profile : null;
    const isRecipient = live[p]?.viewer.role === 'recipient' || p === 'rose';
    const setPane = (patch: Partial<Pane>) => setPanes(all => all.map((x, i) => (i === index ? { ...x, ...patch } : x)));
    return (
      <section key={index} className="pane" aria-label={`${nameOf(p)}'s device`} onPointerDown={() => setFocus(index)} onFocus={() => setFocus(index)}>
        <div className="controls">
          <div className="segmented" role="radiogroup" aria-label="Device">
            {DEVICES.map(d => (
              <button key={d.id} type="button" role="radio" aria-checked={pane.device === d.id} title={d.hint} className={pane.device === d.id ? 'on' : ''} onClick={() => setPane({ device: d.id })}>
                {d.label}
              </button>
            ))}
          </div>
          <div className="segmented" role="radiogroup" aria-label="Who is speaking">
            {PROFILES.map(x => (
              <button
                key={x.id}
                type="button"
                role="radio"
                aria-checked={p === x.id}
                title={x.id === other ? `${x.name} is on the other device` : x.role}
                className={p === x.id ? 'on' : ''}
                disabled={x.id === other}
                onClick={() => {
                  stopSpeaking();
                  setPane({ profile: x.id });
                }}
              >
                {x.name}
                {busy[x.id] ? ' …' : ''}
              </button>
            ))}
          </div>
        </div>

        <div className="settings" aria-label={`${nameOf(p)}'s settings`}>
          <div className="segmented segmented-small" role="radiogroup" aria-label="Language">
            {(['en', 'hi'] as const).map(l => (
              <button key={l} type="button" role="radio" aria-checked={lang === l} className={lang === l ? 'on' : ''} disabled={busy[p]} onClick={() => lang !== l && void changeLanguage(p, l)}>
                {l === 'en' ? 'English' : 'हिंदी'}
              </button>
            ))}
          </div>
          <label className="toggle">
            <input type="checkbox" checked={prefs[p].slow} onChange={e => setPrefs(all => ({ ...all, [p]: { ...all[p], slow: e.target.checked } }))} />
            Slower speech
          </label>
          <label className="toggle">
            <input type="checkbox" checked={prefs[p].large} onChange={e => setPrefs(all => ({ ...all, [p]: { ...all[p], large: e.target.checked } }))} />
            Large text
          </label>
          {isRecipient && (
            <button type="button" className="btn btn-ghost btn-small" onClick={() => void remind(p)} title={`Reminders also come by themselves after ${health?.reminders?.idleSeconds ?? 45} seconds of quiet`}>
              Remind now
            </button>
          )}
          {inbox[p].length > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() => {
                const m = inbox[p][0];
                pushNotice(p, { id: m.id, kind: 'message', title: m.title, text: m.text });
              }}
            >
              Inbox ({inbox[p].length})
            </button>
          )}
        </div>

        <div className={`device device-${pane.device}`}>{renderScreen(pane, index)}</div>

        <form
          className="inputbar"
          onSubmit={ev => {
            ev.preventDefault();
            void submit(p, drafts[p]);
          }}
        >
          <button
            type="button"
            className={`talk talk-${rings[p]}`}
            onClick={() => void talk(p)}
            disabled={!canListen() || busy[p]}
            aria-label={rings[p] === 'listening' ? 'Stop listening' : 'Push to talk'}
            title={canListen() ? `Push to talk (${lang === 'hi' ? 'Hindi' : 'English'})` : 'Voice input needs Chrome or Edge; type instead'}
          >
            <span className="talk-dot" aria-hidden="true" />
          </button>
          <label className="sr-only" htmlFor={`say-${index}`}>
            What {nameOf(p)} says
          </label>
          <input
            id={`say-${index}`}
            value={drafts[p]}
            onChange={e => setDrafts(d => ({ ...d, [p]: e.target.value }))}
            placeholder={`Type what ${nameOf(p)} says…`}
            autoComplete="off"
            disabled={busy[p]}
            lang={lang === 'hi' ? 'hi' : undefined}
          />
          <button type="submit" className="btn btn-primary" disabled={!drafts[p].trim() || busy[p]}>
            Send
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void reset(p)} disabled={busy[p]} aria-label={`Start a new conversation for ${nameOf(p)}`}>
            New chat
          </button>
        </form>

        <div className="suggestions" aria-label="Try saying">
          {SUGGESTIONS[p][lang].map(s => (
            <button key={s} type="button" className="suggestion" disabled={busy[p]} onClick={() => void submit(p, s)} lang={/[ऀ-ॿ]/.test(s) ? 'hi' : undefined}>
              {s}
            </button>
          ))}
        </div>
      </section>
    );
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>CareCircle simulator</h1>
            <p className="tagline">Voice devices driving the CareCircle MCP server</p>
          </div>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Layout">
          <button type="button" role="radio" aria-checked={layout === 'single'} className={layout === 'single' ? 'on' : ''} onClick={() => setLayout('single')}>
            One device
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={layout === 'family'}
            className={layout === 'family' ? 'on' : ''}
            title="Two family members side by side, updating live"
            onClick={() => {
              setLayout('family');
              // Two different people, so the live updates are visible.
              setPanes(all => (all[0].profile === all[1].profile ? [all[0], { ...all[1], profile: all[0].profile === 'sam' ? 'rose' : 'sam' }] : all));
            }}
          >
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
          <button type="button" className="badge badge-button" onClick={() => setMuted(m => !m)} aria-pressed={muted}>
            {muted ? 'Sound off' : 'Sound on'}
          </button>
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
        <main className={`stage stage-${layout}`}>{shown.map(renderPane)}</main>

        <ProtocolPanel
          entries={visibleRpc}
          profileName={nameOf(panelProfile)}
          collapsed={panelCollapsed}
          onToggle={() => setPanelCollapsed(c => !c)}
          onClear={() => setProfiles(all => ({ ...all, [panelProfile]: { ...all[panelProfile], clearedAt: all[panelProfile].lastSeq } }))}
        />
      </div>
    </div>
  );
}
