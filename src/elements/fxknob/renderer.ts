// FX Knob renderer
//
// Draws the knob circle, sweep arc, indicator line, "FX" label, and snap dot.
// Each frame, propagates the current effectValue to connected MIDI elements
// via setMidiReverb() so the audio stays in sync with the visual.

import type { BoundingBox } from '../../types/primitives';
import type { RenderOptions } from '../registry/ElementPlugin';
import type { FXKnobElement } from './types';
import { setMidiReverb } from '../midi/renderer';

// Knob sweep: from -135° to +135° (like a standard console knob)
const SWEEP_START_DEG = -135;
const SWEEP_END_DEG = 135;

const DEG = Math.PI / 180;

// Canvas 0° = east (right). Our knob 0° = north (up), clockwise positive.
// Convert knob degrees to canvas radians: subtract 90° to rotate north to up.
function knobToCanvasRad(deg: number): number {
  return (deg - 90) * DEG;
}

export function render(
  ctx: CanvasRenderingContext2D,
  element: FXKnobElement,
  _options?: RenderOptions,
): void {
  const { cx, cy, radius, lineAngle, effectValue, connectedMidiIds } = element;

  // Propagate reverb to connected MIDI elements every frame (keeps audio in sync)
  for (const midiId of connectedMidiIds) {
    setMidiReverb(midiId, effectValue);
  }

  ctx.save();

  // ── 1. Circle body ──────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
  ctx.fillStyle = '#fffaf0';
  ctx.fill();
  ctx.strokeStyle = '#2f3b52';
  ctx.lineWidth = 2;
  ctx.stroke();

  // ── 2. Sweep arc (shows usable range) ──────────────────────────────────────
  const sweepStartRad = knobToCanvasRad(SWEEP_START_DEG);
  const sweepEndRad = knobToCanvasRad(SWEEP_END_DEG);
  const arcRadius = radius - 5;

  ctx.beginPath();
  ctx.arc(cx, cy, arcRadius, sweepStartRad, sweepEndRad);
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.stroke();

  // ── 3. Filled arc up to current value ──────────────────────────────────────
  const currentRad = knobToCanvasRad(lineAngle);
  if (effectValue > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, arcRadius, sweepStartRad, currentRad);
    ctx.strokeStyle = '#0f766e';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // ── 4. Indicator line ───────────────────────────────────────────────────────
  const angleRad = lineAngle * DEG;
  const tipX = cx + radius * Math.sin(angleRad);
  const tipY = cy - radius * Math.cos(angleRad);
  const baseX = cx + (radius * 0.25) * Math.sin(angleRad);
  const baseY = cy - (radius * 0.25) * Math.cos(angleRad);

  ctx.beginPath();
  ctx.moveTo(baseX, baseY);
  ctx.lineTo(tipX, tipY);
  ctx.strokeStyle = '#0f766e';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.stroke();

  // ── 5. "FX" label ──────────────────────────────────────────────────────────
  ctx.fillStyle = '#2f3b52';
  ctx.font = `bold ${Math.max(10, Math.round(radius * 0.45))}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('FX', cx, cy + radius * 0.15);

  // ── 6. Snap point dot (right edge) ─────────────────────────────────────────
  const isConnected = connectedMidiIds.length > 0;
  ctx.beginPath();
  ctx.arc(cx + radius, cy, 5, 0, 2 * Math.PI);
  ctx.fillStyle = isConnected ? '#34d399' : '#0f766e';
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Show effect value % when connected
  if (isConnected) {
    const pct = Math.round(effectValue * 100);
    ctx.fillStyle = '#0f766e';
    ctx.font = `${Math.max(8, Math.round(radius * 0.3))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`${pct}%`, cx, cy + radius + 6);
  }

  ctx.restore();
}

export function getBounds(element: FXKnobElement): BoundingBox {
  const { cx, cy, radius } = element;
  const pad = radius * 0.2 + 10; // Extra padding for snap dot + % label
  return {
    left: cx - radius - pad,
    top: cy - radius - pad,
    right: cx + radius + pad + 10,  // snap dot extends right
    bottom: cy + radius + pad + 20, // % label below
  };
}
