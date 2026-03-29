import type { BoundingBox } from '../../types';
import type { HandleDescriptor, RenderOptions } from '../registry/ElementPlugin';
import type { MidiElement, MidiInputMode, StepVelocity } from './types';
import { getMidiBounds, getMidiLayout } from './layout';
import {
  getRoughCanvas,
  seedFromId,
  sketchContainer,
  sketchLane,
  sketchButtonIdle,
  sketchButtonActive,
  sketchStepActive,
  sketchGridMajor,
  sketchGridMinor,
  sketchAutoBorder,
  sketchVolBox,
  sketchTickLine,
} from './sketchUtils';

interface PlaybackRuntimeState {
  startedAt: number;
  lastTriggeredStep: number;
}

const playbackState = new Map<string, PlaybackRuntimeState>();
let currentFrameTime = 0;
let seenThisFrame = new Set<string>();

let audioContext: AudioContext | null = null;

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
  gainNode.connect(context.destination);

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
  const seed = seedFromId(element.id);
  const rc = getRoughCanvas(ctx);

  ctx.save();

  // Subtle paper shadow
  ctx.shadowBlur = 5;
  ctx.shadowColor = 'rgba(0,0,0,0.08)';
  rc.rectangle(layout.bounds.left, layout.bounds.top, element.width, element.height, sketchContainer(seed));
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#475569';
  ctx.font = '21px "Caveat", cursive';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const textY = (layout.playButtonBounds.top + layout.playButtonBounds.bottom) / 2;
  ctx.fillText(
    `${element.steps} Steps · ${element.tempo} BPM`,
    layout.toggleModeBounds.right + 14,
    textY
  );

  const mode = element.inputMode ?? 'tap';
  const velocities = (element.stepVelocities ?? Array(element.steps).fill('off')) as StepVelocity[];

  renderPlayButton(ctx, rc, layout.playButtonBounds, element.isLooping, seed);
  renderModeToggle(ctx, rc, layout.toggleModeBounds, mode, seed);
  renderLane(ctx, rc, element, layout, currentStep, mode, velocities, seed);

  if (element.automationEnabled && layout.automationLaneBounds) {
    renderAutomationLane(ctx, rc, element, layout, seed);
  }

  ctx.restore();
}

function renderPlayButton(
  ctx: CanvasRenderingContext2D,
  rc: ReturnType<typeof getRoughCanvas>,
  bounds: BoundingBox,
  isLooping: boolean,
  seed: number
): void {
  ctx.save();
  const w = bounds.right - bounds.left;
  const h = bounds.bottom - bounds.top;

  rc.rectangle(
    bounds.left, bounds.top, w, h,
    isLooping ? sketchButtonActive('#0f766e', seed + 1) : sketchButtonIdle(seed + 1)
  );

  // Icon glyph — keep crisp at this scale
  ctx.fillStyle = isLooping ? '#ffffff' : '#2f3b52';
  if (isLooping) {
    const insetX = w * 0.28;
    const insetY = h * 0.24;
    const barWidth = w * 0.14;
    ctx.fillRect(bounds.left + insetX, bounds.top + insetY, barWidth, h - insetY * 2);
    ctx.fillRect(bounds.right - insetX - barWidth, bounds.top + insetY, barWidth, h - insetY * 2);
  } else {
    ctx.beginPath();
    ctx.moveTo(bounds.left + w * 0.34, bounds.top + h * 0.22);
    ctx.lineTo(bounds.right - w * 0.28, (bounds.top + bounds.bottom) / 2);
    ctx.lineTo(bounds.left + w * 0.34, bounds.bottom - h * 0.22);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function renderModeToggle(
  ctx: CanvasRenderingContext2D,
  rc: ReturnType<typeof getRoughCanvas>,
  bounds: BoundingBox,
  mode: MidiInputMode,
  seed: number
): void {
  ctx.save();
  const isTickMode = mode === 'tick';

  rc.rectangle(
    bounds.left, bounds.top,
    bounds.right - bounds.left, bounds.bottom - bounds.top,
    isTickMode ? sketchButtonActive('#6d28d9', seed + 2) : sketchButtonIdle(seed + 2)
  );

  ctx.fillStyle = isTickMode ? '#ffffff' : '#2f3b52';
  ctx.font = 'bold 17px "Caveat", cursive';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(isTickMode ? 'TICK' : 'TAP', (bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2);
  ctx.restore();
}

function renderLane(
  ctx: CanvasRenderingContext2D,
  rc: ReturnType<typeof getRoughCanvas>,
  element: MidiElement,
  layout: ReturnType<typeof getMidiLayout>,
  currentStep: number | null,
  mode: MidiInputMode,
  velocities: StepVelocity[],
  seed: number
): void {
  ctx.save();
  const stepInsetX = Math.min(8, Math.max(5, layout.stepWidth * 0.14));
  const stepInsetY = Math.min(8, Math.max(5, layout.stepHeight * 0.16));

  rc.rectangle(
    layout.laneBounds.left,
    layout.laneBounds.top,
    layout.laneBounds.right - layout.laneBounds.left,
    layout.laneBounds.bottom - layout.laneBounds.top,
    sketchLane(seed + 3)
  );

  for (let i = 0; i < element.steps; i++) {
    const x = layout.laneBounds.left + i * layout.stepWidth;
    const isBarBoundary = i % 4 === 0;

    // Current-step highlight — keep crisp (live animation)
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
        const tickWidth = Math.max(3, layout.stepWidth * 0.25);
        rc.line(
          tickX, tickCenterY - tickHeight / 2,
          tickX, tickCenterY + tickHeight / 2,
          sketchTickLine(colorMap[vel], tickWidth, seed + i * 7 + 10)
        );
      }
    } else {
      if (element.activeSteps[i]) {
        rc.rectangle(
          x + stepInsetX,
          layout.laneBounds.top + stepInsetY,
          Math.max(4, layout.stepWidth - stepInsetX * 2),
          Math.max(8, layout.stepHeight - stepInsetY * 2),
          sketchStepActive(seed + i * 7 + 100)
        );
      }
    }

    if (i > 0) {
      rc.line(
        x, layout.laneBounds.top + 1,
        x, layout.laneBounds.bottom - 1,
        isBarBoundary
          ? sketchGridMajor(seed + i * 3 + 200)
          : sketchGridMinor(seed + i * 3 + 200)
      );
    }
  }

  // Playhead — keep crisp (live animation)
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
  rc: ReturnType<typeof getRoughCanvas>,
  element: MidiElement,
  layout: ReturnType<typeof getMidiLayout>,
  seed: number
): void {
  const lane = layout.automationLaneBounds!;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // U-border as three separate rough lines
  const borderOpts = sketchAutoBorder(seed + 300);
  rc.line(lane.left, lane.top, lane.left, lane.bottom, borderOpts);
  rc.line(lane.left, lane.bottom, lane.right, lane.bottom, borderOpts);
  rc.line(lane.right, lane.bottom, lane.right, lane.top, borderOpts);

  // Replay the user's actual curve stroke exactly as drawn
  if (element.automationCurvePaths) {
    ctx.strokeStyle = '#2f3b52';
    ctx.lineWidth = 1.5;
    replayPaths(ctx, element.automationCurvePaths);
  }

  // VOL indicator
  const indicatorW = 36;
  const indicatorH = 20;
  const indicatorX = lane.left + 4;
  const indicatorY = lane.top + 4;
  rc.rectangle(indicatorX, indicatorY, indicatorW, indicatorH, sketchVolBox(seed + 301));
  ctx.fillStyle = '#2f3b52';
  ctx.font = 'bold 15px "Caveat", cursive';
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
