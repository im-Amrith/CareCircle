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
  type Today,
  type TurnEvent
} from './api';
import { AppView } from './AppView';
import { ResultCard } from './cards/Cards';
import { DeviceView } from './DeviceView';
import { ElicitationCard, type ElicitationState } from './ElicitationCard';
import {
  DEVICES,
  isHindi,
  nameOf,
  PROFILES,
  SUGGESTIONS,
  TOOL_LABEL,
  type Item,
  type Layout,
  type Notice,
  type Pane,
  type Prefs,
  type Ring,
  type Turn
} from './model';
import { ProtocolPanel } from './ProtocolPanel';
import { TopBar } from './TopBar';
import { announce, canListen, listenOnce, speak, stopSpeaking } from './voice';

interface ProfileState {
  turns: Turn[];
  rpc: RpcEntry[];
  lastSeq: number;
  /** Where the next poll starts. Turn events arrive out of band and can jump past an MCP App view's
   * own calls, so only a poll, which returns everything after its cursor, moves this. */
  polledSeq: number;
  clearedAt: number;
}

const emptyProfile = (): ProfileState => ({ turns: [], rpc: [], lastSeq: 0, polledSeq: 0, clearedAt: 0 });
const byProfile = <T,>(make: () => T): Record<ProfileId, T> => ({ rose: make(), sam: make(), maya: make() });

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
      setProfiles(all => ({ ...all, [p]: { ...all[p], turns: [...all[p].turns, { id, user: text, items: [], pending: true, startSeq: all[p].lastSeq }] } }));
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

  // Keep the newest exchange in view on each device screen: the bottom, unless that would push the
  // start of the newest reply off the top. Then the reply's first line sits at the top and the card
  // below it is a scroll away.
  const scrollKey = JSON.stringify([
    layout,
    panes,
    shown.map(x => profiles[x.profile].turns.map(t => [t.id, t.items.length, !!t.speech, t.pending])),
    shown.map(x => [interims[x.profile], notices[x.profile].length])
  ]);
  useEffect(() => {
    for (const el of Object.values(screenBodies.current)) {
      if (!el) continue;
      const bottom = el.scrollHeight - el.clientHeight;
      const lead = el.querySelector<HTMLElement>('.turn-now .said-alexa') ?? el.querySelector<HTMLElement>('.turn-now');
      // Measured on screen, not with offsetTop, which Large text's CSS zoom throws off.
      const leadTop = lead ? el.scrollTop + lead.getBoundingClientRect().top - el.getBoundingClientRect().top : Infinity;
      el.scrollTop = Math.min(bottom, leadTop - 48);
    }
  }, [scrollKey, elicit]);

  const current = profiles[panelProfile];
  const visibleRpc = useMemo(() => current.rpc.filter(e => e.seq > current.clearedAt), [current.rpc, current.clearedAt]);

  /* ----- render ----- */

  const checkoutOf = (t: Turn) => {
    const url = t.items.find((i): i is Extract<Item, { kind: 'elicitation' }> => i.kind === 'elicitation' && i.e.mode === 'url');
    if (!url) return undefined;
    return elicit[url.e.id] === 'complete' ? ('complete' as const) : ('pending' as const);
  };

  const elicitationCard = (e: Elicitation) => (
    <ElicitationCard key={e.id} e={e} state={elicit[e.id] ?? 'open'} onAnswer={(a, c) => answer(e, a, c)} onDismiss={() => setElicit(s => ({ ...s, [e.id]: 'complete' }))} />
  );

  /** The phone shows MCP App views; the Show devices keep to native cards, sized for across the room. */
  const renderItem = (pane: Pane, t: Turn, it: Item, i: number) => {
    const p = pane.profile;
    if (it.kind === 'call')
      return t.pending && !t.items.some(x => x.kind === 'result' && x.result.id === it.call.id) ? (
        <p key={i} className="invoking" role="status">
          {it.call.invoking ?? TOOL_LABEL[it.call.name] ?? `Calling ${it.call.name}…`}
        </p>
      ) : null;
    if (it.kind === 'result') {
      const key = `${t.id}:${String(it.result.id)}`;
      if (pane.device === 'phone' && it.result.uiResourceUri && !it.result.isError && health?.sandboxUrl && !appFailed[key]) {
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
    if (it.kind === 'elicitation') return elicitationCard(it.e);
    return (
      <p key={i} className="turn-warning" role="alert">
        ⚠ {it.w.message}
      </p>
    );
  };

  /** Questions a Dot can't show, so they go to the companion phone. */
  const companionQuestions = (turns: Turn[]) =>
    turns
      .flatMap(t => t.items.filter((i): i is Extract<Item, { kind: 'elicitation' }> => i.kind === 'elicitation'))
      .filter(i => {
        const st = elicit[i.e.id] ?? 'open';
        return st === 'open' || st === 'sending' || (i.e.mode === 'url' && st === 'accepted');
      })
      .map(i => ({ e: i.e, node: elicitationCard(i.e) }));

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
                title={x.id === other ? `${x.name} is on the other device` : x.title}
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

        <div className={`device device-${pane.device}`}>
          <DeviceView
            pane={pane}
            turns={profiles[p].turns}
            ring={rings[p]}
            interim={interims[p]}
            notices={notices[p]}
            prefs={prefs[p]}
            lang={lang}
            live={live[p]}
            connected={!!health?.mcp.reachable}
            renderItem={(t, it, i) => renderItem(pane, t, it, i)}
            companionQuestions={companionQuestions}
            onDismissNotice={id => dismissNotice(p, id)}
            bodyRef={el => {
              screenBodies.current[index] = el;
            }}
          />
        </div>

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
            <button key={s} type="button" className="suggestion" disabled={busy[p]} onClick={() => void submit(p, s)} lang={isHindi(s) ? 'hi' : undefined}>
              {s}
            </button>
          ))}
        </div>
      </section>
    );
  };

  return (
    <div className="app">
      <TopBar
        health={health}
        layout={layout}
        muted={muted}
        onMute={() => setMuted(m => !m)}
        onLayout={l => {
          setLayout(l);
          // Two different people, so the live updates are visible.
          if (l === 'family') setPanes(all => (all[0].profile === all[1].profile ? [all[0], { ...all[1], profile: all[0].profile === 'sam' ? 'rose' : 'sam' }] : all));
        }}
      />

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
