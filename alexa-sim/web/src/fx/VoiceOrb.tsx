import { lazy, Suspense, useMemo } from 'react';
import type { Ring } from '../model';
import { fxEnabled, useMedia } from './support';

const Orb = lazy(() => import('./vendor/react-bits/Orb'));

/**
 * The device's voice, as a living orb (React Bits "Orb", WebGL2). It is the listening light:
 * cyan while listening, violet while thinking, blue-cyan and livelier while speaking, amber for
 * a notification. Without WebGL it falls back to the CSS light ring.
 */
const PALETTE: Record<Exclude<Ring, 'idle'> | 'idle', string[]> = {
  idle: ['#5e9eff', '#64d2ff', '#1b1f3a'],
  listening: ['#64d2ff', '#2fb6ff', '#0a2a5c'],
  thinking: ['#b58cff', '#5e9eff', '#1c1240'],
  speaking: ['#64d2ff', '#7c8cff', '#0b2150'],
  notify: ['#ffb340', '#ff7a6b', '#3a1d05']
};

export function VoiceOrb({ ring, variant }: { ring: Ring; variant: 'screen' | 'dot' }) {
  const on = useMemo(() => fxEnabled(), []);
  const still = useMedia('(prefers-reduced-motion: reduce)');
  const active = ring !== 'idle';
  if (!on) return <span className={`orb-fallback orb-fallback-${ring}`} aria-hidden="true" />;
  return (
    <div className={`voice-orb voice-orb-${variant} voice-orb-${ring}${active ? ' voice-orb-on' : ''}`} aria-hidden="true">
      <Suspense fallback={null}>
        <Orb
          colors={PALETTE[ring]}
          backgroundColor="transparent"
          size={variant === 'dot' ? 0.9 : 0.75}
          glow={ring === 'speaking' ? 1.6 : 1.2}
          wobble={ring === 'thinking' ? 1.6 : 1}
          speed={still ? 0 : ring === 'speaking' ? 1.6 : ring === 'idle' ? 0.4 : 1}
          forceHoverState={ring === 'speaking' || ring === 'listening'}
          followCursor={false}
          rotateOnHover={false}
          clickPulse={false}
          intro
          opacity={variant === 'dot' && !active ? 0.55 : 1}
        />
      </Suspense>
    </div>
  );
}
