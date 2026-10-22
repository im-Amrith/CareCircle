import { useEffect, type RefObject } from 'react';

/**
 * Apple-style "liquid glass" for pills and bars: the backdrop bends at the edges and splits a
 * little into red, green and blue, like real glass. The technique (an SVG displacement map used
 * as a backdrop-filter, per colour channel) follows liquid-glass-js
 * (https://github.com/dashersw/liquid-glass-js, MIT) and React Bits' GlassSurface.
 *
 * Unlike a wrapper component this attaches to an existing element through a ref, so menus that
 * pop out of the control bar are never clipped. Only Chromium supports SVG filters in
 * backdrop-filter; elsewhere (and with ?fx=off) the element keeps its CSS frosted glass.
 */

let counter = 0;

function supportsSvgBackdrop(): boolean {
  const ua = navigator.userAgent;
  if (/Firefox/.test(ua) || (/Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua))) return false;
  const probe = document.createElement('div');
  probe.style.backdropFilter = 'url(#x)';
  return probe.style.backdropFilter !== '';
}

function displacementMap(w: number, h: number, radius: number, edge: number): string {
  const inset = Math.min(w, h) * edge;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs>
<linearGradient id="r" x1="100%" y1="0%" x2="0%" y2="0%"><stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="red"/></linearGradient>
<linearGradient id="b" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="blue"/></linearGradient>
<filter id="s" x="0" y="0" width="${w}" height="${h}" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="${Math.max(4, inset / 3)}"/></filter>
</defs>
<rect width="${w}" height="${h}" fill="black"/>
<rect width="${w}" height="${h}" rx="${radius}" fill="url(#r)"/>
<rect width="${w}" height="${h}" rx="${radius}" fill="url(#b)" style="mix-blend-mode:difference"/>
<rect x="${inset}" y="${inset}" width="${Math.max(0, w - inset * 2)}" height="${Math.max(0, h - inset * 2)}" rx="${radius}" fill="hsl(0 0% 50% / 0.93)" filter="url(#s)"/>
</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export interface LiquidGlassOptions {
  /** How far the edges bend the backdrop, in px */
  strength?: number;
  /** Extra bend per channel for the colour fringe */
  dispersion?: number;
  /** Width of the bending rim, as a share of the shorter side */
  edge?: number;
  blur?: number;
  saturate?: number;
  enabled?: boolean;
}

export function useLiquidGlass(ref: RefObject<HTMLElement | null>, opts: LiquidGlassOptions = {}) {
  const { strength = -60, dispersion = 8, edge = 0.18, blur = 3, saturate = 1.6, enabled = true } = opts;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || !supportsSvgBackdrop()) return;
    const id = `cc-liquid-${++counter}`;
    const ns = 'http://www.w3.org/2000/svg';
    const host = document.createElementNS(ns, 'svg');
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('width', '0');
    host.setAttribute('height', '0');
    host.style.position = 'absolute';
    host.innerHTML = `<defs><filter id="${id}" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">
<feImage x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map"/>
<feDisplacementMap in="SourceGraphic" in2="map" scale="${strength}" xChannelSelector="R" yChannelSelector="B" result="dr"/>
<feColorMatrix in="dr" type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="red"/>
<feDisplacementMap in="SourceGraphic" in2="map" scale="${strength + dispersion}" xChannelSelector="R" yChannelSelector="B" result="dg"/>
<feColorMatrix in="dg" type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0" result="green"/>
<feDisplacementMap in="SourceGraphic" in2="map" scale="${strength + dispersion * 2}" xChannelSelector="R" yChannelSelector="B" result="db"/>
<feColorMatrix in="db" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0" result="blue"/>
<feBlend in="red" in2="green" mode="screen" result="rg"/>
<feBlend in="rg" in2="blue" mode="screen" result="out"/>
<feGaussianBlur in="out" stdDeviation="${blur}"/>
</filter></defs>`;
    document.body.appendChild(host);
    const image = host.querySelector('feImage')!;

    const update = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || Math.min(r.width, r.height) / 2;
      image.setAttribute('href', displacementMap(Math.round(r.width), Math.round(r.height), Math.min(radius, r.height / 2), edge));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);

    const before = el.style.backdropFilter;
    const filter = `url(#${id}) saturate(${saturate})`;
    el.style.backdropFilter = filter;
    el.classList.add('liquid-glass');

    return () => {
      ro.disconnect();
      host.remove();
      el.style.backdropFilter = before;
      el.classList.remove('liquid-glass');
    };
  }, [ref, strength, dispersion, edge, blur, saturate, enabled]);
}
