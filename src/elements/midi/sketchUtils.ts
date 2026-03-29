import rough from 'roughjs';
import type { Options } from 'roughjs/bin/core';
import type { RoughCanvas } from 'roughjs/bin/canvas';

const roughCache = new WeakMap<HTMLCanvasElement, RoughCanvas>();

export function getRoughCanvas(ctx: CanvasRenderingContext2D): RoughCanvas {
  const canvas = ctx.canvas;
  if (!roughCache.has(canvas)) {
    roughCache.set(canvas, rough.canvas(canvas));
  }
  return roughCache.get(canvas)!;
}

export function seedFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function sketchContainer(seed: number): Options {
  return {
    roughness: 1.4,
    bowing: 1.2,
    stroke: '#2f3b52',
    strokeWidth: 2,
    fill: '#fffaf0',
    fillStyle: 'solid',
    seed,
  };
}

export function sketchLane(seed: number): Options {
  return {
    roughness: 0.8,
    bowing: 0.6,
    stroke: '#94a3b8',
    strokeWidth: 1,
    fill: '#fffef8',
    fillStyle: 'solid',
    seed,
  };
}

export function sketchButtonIdle(seed: number): Options {
  return {
    roughness: 1.0,
    bowing: 0.8,
    stroke: '#2f3b52',
    strokeWidth: 1.5,
    fill: '#ffffff',
    fillStyle: 'solid',
    seed,
  };
}

export function sketchButtonActive(fillColor: string, seed: number): Options {
  return {
    roughness: 1.0,
    bowing: 0.8,
    stroke: '#2f3b52',
    strokeWidth: 1.5,
    fill: fillColor,
    fillStyle: 'solid',
    seed,
  };
}

export function sketchStepActive(seed: number): Options {
  return {
    roughness: 1.5,
    bowing: 1.0,
    stroke: '#0a5c55',
    strokeWidth: 1,
    fill: '#0f766e',
    fillStyle: 'hachure',
    hachureAngle: -41,
    hachureGap: 4,
    seed,
  };
}

export function sketchGridMajor(seed: number): Options {
  return {
    roughness: 0.4,
    bowing: 0.3,
    stroke: '#94a3b8',
    strokeWidth: 1.5,
    seed,
  };
}

export function sketchGridMinor(seed: number): Options {
  return {
    roughness: 0.3,
    bowing: 0.2,
    stroke: '#dbe3ed',
    strokeWidth: 0.8,
    seed,
  };
}

export function sketchAutoBorder(seed: number): Options {
  return {
    roughness: 1.1,
    bowing: 0.8,
    stroke: '#2f3b52',
    strokeWidth: 1.5,
    seed,
  };
}

export function sketchVolBox(seed: number): Options {
  return {
    roughness: 0.9,
    bowing: 0.5,
    stroke: '#2f3b52',
    strokeWidth: 1,
    fill: '#fffaf0',
    fillStyle: 'solid',
    seed,
  };
}

export function sketchTickLine(color: string, strokeWidth: number, seed: number): Options {
  return {
    roughness: 0.8,
    bowing: 0.5,
    stroke: color,
    strokeWidth,
    seed,
  };
}
