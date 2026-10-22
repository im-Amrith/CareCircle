import { ShaderGradient, ShaderGradientCanvas } from '@shadergradient/react';

/**
 * The living stage behind everything: a slow 3D "water plane" gradient from ShaderGradient
 * (https://github.com/ruucm/shadergradient, MIT), rendered with react-three-fiber. One colour
 * is the person who is talking, so the whole room shifts when Sam picks up the device.
 *
 * Loaded lazily (three.js is large) and only when effects are on. Uses ShaderGradient's "3d"
 * lights, never the "env" HDR maps, so nothing is fetched from the network.
 */
export interface ShaderBackdropProps {
  tint: string;
  dark: boolean;
  still: boolean;
}

/** Mix a hex colour toward another; the person's colour is kept deep so the stage stays quiet. */
function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

export default function ShaderBackdrop({ tint, dark, still }: ShaderBackdropProps) {
  const deep = dark ? mix(tint, '#0a0a0d', 0.5) : mix(tint, '#f5f5f7', 0.72);
  return (
    <ShaderGradientCanvas
      className="fx-backdrop-canvas"
      pointerEvents="none"
      pixelDensity={1}
      fov={45}
      lazyLoad={false}
      powerPreference="low-power"
    >
      <ShaderGradient
        control="props"
        type="waterPlane"
        animate={still ? 'off' : 'on'}
        uSpeed={0.08}
        uStrength={1.5}
        uDensity={1.15}
        uFrequency={5.5}
        uAmplitude={0}
        positionX={0}
        positionY={0.6}
        positionZ={0}
        rotationX={50}
        rotationY={0}
        rotationZ={-60}
        color1={dark ? '#09090c' : '#f5f5f7'}
        color2={deep}
        color3={dark ? '#2a1d16' : '#e6e0f0'}
        reflection={0.1}
        cAzimuthAngle={180}
        cPolarAngle={80}
        cDistance={2.8}
        cameraZoom={9.1}
        lightType="3d"
        brightness={dark ? 0.62 : 1.1}
        grain="off"
        enableTransition={false}
      />
    </ShaderGradientCanvas>
  );
}
