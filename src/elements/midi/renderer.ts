import type { BoundingBox } from '../../types';
import type { HandleDescriptor, RenderOptions } from '../registry/ElementPlugin';
import type { MidiElement, MidiInputMode, StepVelocity } from './types';
import { getMidiBounds, getMidiLayout } from './layout';

interface PlaybackRuntimeState {
  startedAt: number;
  lastTriggeredStep: number;
}

const playbackState = new Map<string, PlaybackRuntimeState>();
let currentFrameTime = 0;
let seenThisFrame = new Set<string>();

let audioContext: AudioContext | null = null;

// ── Reverb (FX Knob integration) ─────────────────────────────────────────────
// Maps midiElementId → reverb wet amount (0-1). Written by fxknob plugin.
const midiReverbCache = new Map<string, number>();
let reverbBuffer: AudioBuffer | null = null;

/**
 * Set the reverb amount for a MIDI element (called by the FX knob renderer/interaction).
 */
export function setMidiReverb(midiId: string, amount: number): void {
  midiReverbCache.set(midiId, Math.max(0, Math.min(1, amount)));
}

function getMidiReverb(midiId: string): number {
  return midiReverbCache.get(midiId) ?? 0;
}

/**
 * Generate a synthetic reverb impulse response (exponential-decay white noise).
 */
function getReverbBuffer(context: AudioContext): AudioBuffer {
  if (reverbBuffer) return reverbBuffer;
  const duration = 2.0;
  const decay = 2.0;
  const length = Math.floor(context.sampleRate * duration);
  reverbBuffer = context.createBuffer(2, length, context.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = reverbBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return reverbBuffer;
}

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (audioContext) return audioContext;

  if (!window.AudioContext) return null;
  audioContext = new window.AudioContext();
  return audioContext;
}

export async function primeMidiAudio(): Promise<void> {
  const context = getAudioContext();
  if (!context) return;
  if (context.state === 'suspended') {
    await context.resume();
  }
}

const VELOCITY_GAIN: Record<StepVelocity, number> = {
  off: 0,
  low: 0.08,
  normal: 0.2,
  high: 0.4,
};

function playStepSound(element: MidiElement, velocity: StepVelocity = 'normal', stepIndex = -1): void {
  const context = getAudioContext();
  if (!context || context.state !== 'running') return;

  const peakGain = VELOCITY_GAIN[velocity];
  if (peakGain === 0) return;

  const automationVolume =
    element.automationEnabled && stepIndex >= 0
      ? (element.stepVolumes?.[stepIndex] ?? 1.0)
      : 1.0;
  const effectiveGain = peakGain * automationVolume;

  const now = context.currentTime;
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  const filter = context.createBiquadFilter();

  oscillator.type = 'triangle';
  oscillator.frequency.setValueAtTime(220, now);
  oscillator.frequency.exponentialRampToValueAtTime(130, now + 0.08);

  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(element.instrument === 'snare' ? 1800 : 900, now);
  filter.Q.setValueAtTime(0.8, now);

  gainNode.gain.setValueAtTime(0.0001, now);
  gainNode.gain.exponentialRampToValueAtTime(effectiveGain, now + 0.005);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

  oscillator.connect(filter);
  filter.connect(gainNode);

  // Reverb wet/dry mix — driven by any connected FX knob
  const reverbAmount = getMidiReverb(element.id);
  if (reverbAmount > 0) {
    const convolver = context.createConvolver();
    convolver.buffer = getReverbBuffer(context);
    const wetGain = context.createGain();
    wetGain.gain.setValueAtTime(reverbAmount, now);
    gainNode.connect(context.destination);   // dry path
    gainNode.connect(wetGain);
    wetGain.connect(convolver);
    convolver.connect(context.destination);  // wet path
  } else {
    gainNode.connect(context.destination);
  }

  oscillator.start(now);
  oscillator.stop(now + 0.13);
}

function getStepDurationMs(element: MidiElement): number {
  return 60000 / element.tempo / 4;
}

function getCurrentStepIndex(element: MidiElement, now: number): number {
  const runtime = playbackState.get(element.id);
  if (!runtime) return 0;

  const elapsed = Math.max(0, now - runtime.startedAt);
  return Math.floor(elapsed / getStepDurationMs(element)) % element.steps;
}

function syncPlayback(element: MidiElement, now: number): number | null {
  if (!element.isLooping) {
    playbackState.delete(element.id);
    return null;
  }

  const runtime = playbackState.get(element.id) ?? {
    startedAt: now,
    lastTriggeredStep: -1,
  };
  playbackState.set(element.id, runtime);

  const stepIndex = getCurrentStepIndex(element, now);
  if (stepIndex !== runtime.lastTriggeredStep) {
    runtime.lastTriggeredStep = stepIndex;
    const mode = element.inputMode ?? 'tap';
    const velocities = (element.stepVelocities ?? Array(element.steps).fill('off')) as StepVelocity[];
    if (mode === 'tick') {
      const vel = velocities[stepIndex];
      if (vel !== 'off') {
        playStepSound(element, vel, stepIndex);
      }
    } else {
      if (element.activeSteps[stepIndex]) {
        const vel = velocities[stepIndex] !== 'off' ? velocities[stepIndex] : 'normal';
        playStepSound(element, vel, stepIndex);
      }
    }
  }

  return stepIndex;
}

export function beginMidiRenderFrame(now: number): void {
  currentFrameTime = now;
  seenThisFrame = new Set<string>();
}

export function endMidiRenderFrame(): void {
  for (const elementId of Array.from(playbackState.keys())) {
    if (!seenThisFrame.has(elementId)) {
      playbackState.delete(elementId);
    }
  }
}

export function hasActiveMidiPlayback(): boolean {
  return playbackState.size > 0;
}

export function getHandles(element: MidiElement): HandleDescriptor[] {
  const bounds = getMidiBounds(element);
  const centerY = (bounds.top + bounds.bottom) / 2;

  return [
    {
      id: 'resizeRight',
      position: { x: bounds.right, y: centerY },
      cursor: 'ew-resize',
      appearance: {
        shape: 'square',
        size: 8,
        fillColor: '#0f766e',
        strokeColor: '#ffffff',
      },
    },
  ];
}

export function render(
  ctx: CanvasRenderingContext2D,
  element: MidiElement,
  _options?: RenderOptions
): void {
  seenThisFrame.add(element.id);

  const layout = getMidiLayout(element);
  const currentStep = syncPlayback(element, currentFrameTime);

  ctx.save();

  ctx.fillStyle = '#fffaf0';
  ctx.strokeStyle = '#2f3b52';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(layout.bounds.left, layout.bounds.top, element.width, element.height, 12);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#667085';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const textY = (layout.playButtonBounds.top + layout.playButtonBounds.bottom) / 2;
  ctx.fillText(`${element.steps} steps · ${element.tempo} BPM · ${element.instrument}`, layout.toggleModeBounds.right + 8, textY);

  const mode = element.inputMode ?? 'tap';
  const velocities = (element.stepVelocities ?? Array(element.steps).fill('off')) as StepVelocity[];

  renderPlayButton(ctx, layout.playButtonBounds, element.isLooping);
  renderModeToggle(ctx, layout.toggleModeBounds, mode);
  renderLane(ctx, element, layout, currentStep, mode, velocities);

  if (element.automationEnabled && layout.automationLaneBounds) {
    renderAutomationLane(ctx, element, layout);
  }

  ctx.restore();
}

function renderPlayButton(ctx: CanvasRenderingContext2D, bounds: BoundingBox, isLooping: boolean): void {
  ctx.save();
  ctx.fillStyle = isLooping ? '#0f766e' : '#ffffff';
  ctx.strokeStyle = '#2f3b52';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top, 6);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = isLooping ? '#ffffff' : '#2f3b52';
  if (isLooping) {
    const insetX = (bounds.right - bounds.left) * 0.28;
    const insetY = (bounds.bottom - bounds.top) * 0.24;
    const barWidth = (bounds.right - bounds.left) * 0.14;
    ctx.fillRect(bounds.left + insetX, bounds.top + insetY, barWidth, bounds.bottom - bounds.top - insetY * 2);
    ctx.fillRect(bounds.right - insetX - barWidth, bounds.top + insetY, barWidth, bounds.bottom - bounds.top - insetY * 2);
  } else {
    ctx.beginPath();
    ctx.moveTo(bounds.left + (bounds.right - bounds.left) * 0.34, bounds.top + (bounds.bottom - bounds.top) * 0.22);
    ctx.lineTo(bounds.right - (bounds.right - bounds.left) * 0.28, (bounds.top + bounds.bottom) / 2);
    ctx.lineTo(bounds.left + (bounds.right - bounds.left) * 0.34, bounds.bottom - (bounds.bottom - bounds.top) * 0.22);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function renderModeToggle(
  ctx: CanvasRenderingContext2D,
  bounds: BoundingBox,
  mode: MidiInputMode
): void {
  ctx.save();
  const isTickMode = mode === 'tick';
  ctx.fillStyle = isTickMode ? '#6d28d9' : '#ffffff';
  ctx.strokeStyle = '#2f3b52';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top, 6);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = isTickMode ? '#ffffff' : '#2f3b52';
  ctx.font = 'bold 8px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(isTickMode ? 'TICK' : 'TAP', (bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2);
  ctx.restore();
}

function renderLane(
  ctx: CanvasRenderingContext2D,
  element: MidiElement,
  layout: ReturnType<typeof getMidiLayout>,
  currentStep: number | null,
  mode: MidiInputMode,
  velocities: StepVelocity[]
): void {
  ctx.save();

  ctx.fillStyle = '#fffef8';
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(
    layout.laneBounds.left,
    layout.laneBounds.top,
    layout.laneBounds.right - layout.laneBounds.left,
    layout.laneBounds.bottom - layout.laneBounds.top,
    8
  );
  ctx.fill();
  ctx.stroke();

  for (let i = 0; i < element.steps; i++) {
    const x = layout.laneBounds.left + i * layout.stepWidth;
    const isBarBoundary = i % 4 === 0;

    if (currentStep === i) {
      ctx.fillStyle = 'rgba(15, 118, 110, 0.10)';
      ctx.fillRect(x, layout.laneBounds.top, layout.stepWidth, layout.stepHeight);
    }

    if (mode === 'tick') {
      const vel = velocities[i];
      if (vel !== 'off') {
        const ratioMap: Record<StepVelocity, number> = { off: 0, low: 0.33, normal: 0.60, high: 0.90 };
        const colorMap: Record<StepVelocity, string> = { off: 'transparent', low: '#5eead4', normal: '#0f766e', high: '#7c3aed' };
        const ratio = ratioMap[vel];
        const tickHeight = layout.stepHeight * ratio;
        const tickCenterY = (layout.laneBounds.top + layout.laneBounds.bottom) / 2;
        const tickX = x + layout.stepWidth / 2;
        ctx.strokeStyle = colorMap[vel];
        ctx.lineWidth = Math.max(3, layout.stepWidth * 0.25);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(tickX, tickCenterY - tickHeight / 2);
        ctx.lineTo(tickX, tickCenterY + tickHeight / 2);
        ctx.stroke();
      }
    } else {
      if (element.activeSteps[i]) {
        ctx.fillStyle = '#0f766e';
        ctx.beginPath();
        ctx.roundRect(x + 4, layout.laneBounds.top + 4, Math.max(4, layout.stepWidth - 8), Math.max(8, layout.stepHeight - 8), 6);
        ctx.fill();
      }
    }

    if (i > 0) {
      ctx.strokeStyle = isBarBoundary ? '#94a3b8' : '#dbe3ed';
      ctx.lineWidth = isBarBoundary ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, layout.laneBounds.top + 1);
      ctx.lineTo(x, layout.laneBounds.bottom - 1);
      ctx.stroke();
    }
  }

  if (currentStep !== null) {
    const playheadX = layout.laneBounds.left + currentStep * layout.stepWidth + layout.stepWidth / 2;
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, layout.laneBounds.top - 2);
    ctx.lineTo(playheadX, layout.laneBounds.bottom + 2);
    ctx.stroke();
  }

  ctx.restore();
}

function replayPaths(
  ctx: CanvasRenderingContext2D,
  paths: Array<Array<{x: number; y: number}>>
): void {
  for (const path of paths) {
    if (path.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
    ctx.stroke();
  }
}

function renderAutomationLane(
  ctx: CanvasRenderingContext2D,
  element: MidiElement,
  layout: ReturnType<typeof getMidiLayout>
): void {
  const lane = layout.automationLaneBounds!;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#2f3b52';
  ctx.lineWidth = 1.5;

  // Snapped U border — left/right/bottom aligned to MIDI lane, clean lines
  ctx.beginPath();
  ctx.moveTo(lane.left, lane.top);
  ctx.lineTo(lane.left, lane.bottom);
  ctx.lineTo(lane.right, lane.bottom);
  ctx.lineTo(lane.right, lane.top);
  ctx.stroke();

  // Replay the user's actual curve stroke exactly as drawn — no snapping on this
  if (element.automationCurvePaths) {
    replayPaths(ctx, element.automationCurvePaths);
  }

  // VOL indicator — sits just inside the top-left corner of the automation lane
  const indicatorW = 36;
  const indicatorH = 20;
  const indicatorX = lane.left + 4;
  const indicatorY = lane.top + 4;
  ctx.strokeStyle = '#2f3b52';
  ctx.lineWidth = 1;
  ctx.strokeRect(indicatorX, indicatorY, indicatorW, indicatorH);
  ctx.fillStyle = '#2f3b52';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('VOL', indicatorX + indicatorW / 2, indicatorY + indicatorH / 2);

  ctx.restore();
}

export function getBounds(element: MidiElement): BoundingBox | null {
  const bounds = getMidiBounds(element);
  if (!element.automationEnabled || element.automationBottomY === undefined) return bounds;
  return {
    ...bounds,
    bottom: element.automationBottomY,
  };
}
