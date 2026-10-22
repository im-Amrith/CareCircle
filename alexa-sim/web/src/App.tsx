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
  type TurnEvent,
  type VoiceMatch
} from './api';
import { AppView } from './AppView';
import { Backdrop } from './fx/Backdrop';
import { Hero } from './fx/Hero';

import { ControlBar, ProfileSwitcher, suggestionsFor } from './Controls';
import { ResultCard } from './cards/Cards';
import { DeviceView } from './DeviceView';
import { ElicitationCard, type ElicitationState } from './ElicitationCard';
import {
  nameOf,
  PROFILES,
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

/** Each person's colour, for the living backdrop. Matches --rose, --sam, --maya in styles.css. */
const TINT: Record<ProfileId, string> = { rose: '#ff7a6b', sam: '#5e9eff', maya: '#b58cff' };

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
  // Under the hood starts folded away; the device is the hero.
  const [panelCollapsed, setPanelCollapsed] = useState(true);
  /** A pane that just changed person shows "Switching to Sam's device" for a moment. */
  const [switching, setSwitching] = useState<Record<number, ProfileId | null>>({});
  const [health, setHealth] = useState<Health | null>(null);
  const [banner, setBanner] = useState<{ tone: 'warn' | 'error'; text: string } | null>(null);
  const [elicit, setElicit] = useState<Record<string, ElicitationState>>({});
  /** Tool results whose MCP App view failed to load; they fall back to the native card. */
  const [appFailed, setAppFailed] = useState<Record<string, string>>({});
  const listeners = useRef<Partial<Record<ProfileId, { stop: () => void }>>>({});
  /** Server elicitationId -> our elicitation id, to match notifications/elicitation/complete. */
  const urlElicitations = useRef(new Map<string, string>());
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  // Simulated voice match: what the next request on each device carries, and what the last one did.
  const [voices, setVoices] = useState<Record<ProfileId, VoiceMatch>>({ rose: 'high', sam: 'high', maya: 'high' });
  const [heard, setHeard] = useState<Record<ProfileId, VoiceMatch>>({ rose: 'high', sam: 'high', maya: 'high' });
  const voicesRef = useRef(voices);
  voicesRef.current = voices;

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
      // The voice match applies to this one request, then the device is back to matched.
      const voice = voicesRef.current[p];
      setHeard(h => ({ ...h, [p]: voice }));
      setVoices(v => ({ ...v, [p]: 'high' }));

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
        await streamTurn(p, text, onEvent, { slow, voice });
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

  const changeLayout = (l: Layout) => {
    setLayout(l);
    // Two different people, so the live updates are visible.
    if (l === 'family') setPanes(all => (all[0].profile === all[1].profile ? [all[0], { ...all[1], profile: all[0].profile === 'sam' ? 'rose' : 'sam' }] : all));
  };

  /** The hero line steps aside once anyone is talking, so the device moves up. */
  const conversing = shown.some(x => profiles[x.profile].turns.length > 0);

  const renderPane = (pane: Pane, index: number) => {
    const p = pane.profile;
    const lang = langOf(p);
    const other = layout === 'family' ? panes[1 - index].profile : null;
    const isRecipient = live[p]?.viewer.role === 'recipient' || p === 'rose';
    const setPane = (patch: Partial<Pane>) => setPanes(all => all.map((x, i) => (i === index ? { ...x, ...patch } : x)));
    return (
      <section key={index} className="pane" aria-label={`${nameOf(p)}'s device`} onPointerDown={() => setFocus(index)} onFocus={() => setFocus(index)}>
        <ProfileSwitcher
          profile={p}
          other={other}
          busy={busy}
          onPick={x => {
            stopSpeaking();
            setPane({ profile: x });
            setSwitching(all => ({ ...all, [index]: x }));
            setTimeout(() => setSwitching(all => (all[index] === x ? { ...all, [index]: null } : all)), 1300);
          }}
        />

        <div className={`device device-${pane.device}`}>
          {/* The person's tint, softly lit behind the device; crossfades when they change. */}
          <div className="glow" aria-hidden="true">
            {PROFILES.map(x => (
              <span key={x.id} className={`glow-${x.id}${x.id === p ? ' glow-on' : ''}`} />
            ))}
          </div>
          <VoiceBadge profile={p} match={voices[p] !== 'high' ? voices[p] : heard[p]} pending={voices[p] !== 'high'} />
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
            switchingTo={switching[index] ?? null}
            renderItem={(t, it, i) => renderItem(pane, t, it, i)}
            companionQuestions={companionQuestions}
            onDismissNotice={id => dismissNotice(p, id)}
          />
        </div>

        <ControlBar
          profile={p}
          index={index}
          lang={lang}
          ring={rings[p]}
          busy={busy[p]}
          draft={drafts[p]}
          onDraft={text => setDrafts(d => ({ ...d, [p]: text }))}
          onSubmit={text => void submit(p, text)}
          onTalk={() => void talk(p)}
          canListen={canListen()}
          suggestions={suggestionsFor(p, lang, profiles[p].turns)}
          device={pane.device}
          onDevice={device => setPane({ device })}
          layout={layout}
          onLayout={changeLayout}
          muted={muted}
          onMute={() => setMuted(m => !m)}
          onReset={() => void reset(p)}
          onLanguage={l => void changeLanguage(p, l)}
          prefs={prefs[p]}
          onPrefs={next => setPrefs(all => ({ ...all, [p]: next }))}
          onRemind={isRecipient ? () => void remind(p) : undefined}
          remindHint={`Reminders also come by themselves after ${health?.reminders?.idleSeconds ?? 45} seconds of quiet`}
          inboxCount={inbox[p].length}
          voice={voices[p]}
          onVoice={v => setVoices(all => ({ ...all, [p]: v }))}
          onInbox={() => {
            const m = inbox[p][0];
            pushNotice(p, { id: m.id, kind: 'message', title: m.title, text: m.text });
          }}
        />
      </section>
    );
  };

  return (
    <div className="app">
      <Backdrop tint={TINT[panes[focus]?.profile ?? panes[0].profile]} />
      <TopBar health={health} />

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
        <main className={`stage stage-${layout}`}>
          <Hero away={conversing} />
          <div className={`panes panes-${layout}`}>{shown.map(renderPane)}</div>
        </main>

        <ProtocolPanel
          entries={visibleRpc}
          turns={current.turns}
          profileName={nameOf(panelProfile)}
          protocol={health?.mcp.protocol}
          collapsed={panelCollapsed}
          onToggle={() => setPanelCollapsed(c => !c)}
          onClear={() => setProfiles(all => ({ ...all, [panelProfile]: { ...all[panelProfile], clearedAt: all[panelProfile].lastSeq } }))}
        />
      </div>
    </div>
  );
}

/** "Sam · voice matched", or "Not sure who's speaking". The match is simulated; the server enforces what it allows. */
function VoiceBadge({ profile, match, pending }: { profile: ProfileId; match: VoiceMatch; pending: boolean }) {
  const sure = match === 'high';
  const hint =
    match === 'low'
      ? 'Unsure who is speaking: CareCircle asks before changing anything'
      : match === 'unknown'
        ? 'Voice not recognised: CareCircle answers questions but makes no changes'
        : 'The voice matches this profile';
  return (
    <p className={`voice-badge voice-${match}`} role="status" title={pending ? `${hint} (next request)` : hint}>
      <span className="voice-dot" aria-hidden="true" />
      {sure ? `${nameOf(profile)} · voice matched` : "Not sure who's speaking"}
      {pending && <span className="voice-next">next request</span>}
    </p>
  );
}
