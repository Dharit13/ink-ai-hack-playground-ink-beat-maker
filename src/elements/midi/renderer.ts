import type { BoundingBox } from '../../types';
import type { HandleDescriptor, RenderOptions } from '../registry/ElementPlugin';
import {
  getInstrumentLabel,
  MIDI_LANE_INSTRUMENTS,
  normalizeMidiElement,
  type MidiElement,
  type MidiConnectorNodeType,
  type MidiInputMode,
  type MidiInstrument,
  type StepVelocity,
} from './types';
import { getMidiBounds, getMidiInteractionBounds, getMidiLayout } from './layout';

interface PlaybackRuntimeState {
  startedAt: number;
  lastTriggeredStep: number;
}

const playbackState = new Map<string, PlaybackRuntimeState>();
let currentFrameTime = 0;
let seenThisFrame = new Set<string>();

let audioContext: AudioContext | null = null;
let masterGainNode: GainNode | null = null;
let compressorNode: DynamicsCompressorNode | null = null;
let noiseBuffer: AudioBuffer | null = null;

const MASTER_OUTPUT_GAIN = 1.9;
const VELOCITY_GAIN: Record<StepVelocity, number> = {
  off: 0,
  low: 0.12,
  normal: 0.24,
  high: 0.4,
};

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (audioContext) return audioContext;
  if (!window.AudioContext) return null;
  audioContext = new window.AudioContext();
  return audioContext;
}

function getOutputNode(context: AudioContext): AudioNode {
  if (!compressorNode) {
    compressorNode = context.createDynamicsCompressor();
    compressorNode.threshold.setValueAtTime(-18, context.currentTime);
    compressorNode.knee.setValueAtTime(12, context.currentTime);
    compressorNode.ratio.setValueAtTime(3, context.currentTime);
    compressorNode.attack.setValueAtTime(0.003, context.currentTime);
    compressorNode.release.setValueAtTime(0.12, context.currentTime);
  }

  if (!masterGainNode) {
    masterGainNode = context.createGain();
    masterGainNode.gain.setValueAtTime(MASTER_OUTPUT_GAIN, context.currentTime);
  }

  masterGainNode.disconnect();
  compressorNode.disconnect();
  masterGainNode.connect(compressorNode);
  compressorNode.connect(context.destination);

  return masterGainNode;
}

function getNoiseBuffer(context: AudioContext): AudioBuffer {
  if (noiseBuffer) return noiseBuffer;

  const bufferSize = context.sampleRate;
  noiseBuffer = context.createBuffer(1, bufferSize, context.sampleRate);
  const channelData = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    channelData[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

export async function primeMidiAudio(): Promise<void> {
  const context = getAudioContext();
  if (!context) return;
  if (context.state === 'suspended') {
    await context.resume();
  }
}

function getInstrumentSoundProfile(instrument: MidiInstrument): {
  frequency: number;
  endFrequency: number;
  filterFrequency: number;
  duration: number;
  type: OscillatorType;
} {
  switch (instrument) {
    case 'kick':
      return { frequency: 120, endFrequency: 48, filterFrequency: 240, duration: 0.18, type: 'sine' };
    case 'snare':
      return { frequency: 220, endFrequency: 130, filterFrequency: 1800, duration: 0.12, type: 'triangle' };
    case 'closedHat':
      return { frequency: 520, endFrequency: 440, filterFrequency: 5000, duration: 0.05, type: 'square' };
    case 'openHat':
      return { frequency: 540, endFrequency: 420, filterFrequency: 4200, duration: 0.12, type: 'square' };
    case 'tom':
      return { frequency: 170, endFrequency: 98, filterFrequency: 700, duration: 0.16, type: 'triangle' };
    case 'midTom':
      return { frequency: 145, endFrequency: 85, filterFrequency: 600, duration: 0.16, type: 'triangle' };
    case 'crash':
      return { frequency: 460, endFrequency: 330, filterFrequency: 3200, duration: 0.2, type: 'sawtooth' };
  }
}

function playNoiseInstrument(
  context: AudioContext,
  instrument: MidiInstrument,
  effectiveGain: number
): void {
  const noise = context.createBufferSource();
  noise.buffer = getNoiseBuffer(context);

  const noiseFilter = context.createBiquadFilter();
  const noiseGain = context.createGain();
  const outputNode = getOutputNode(context);
  const now = context.currentTime;

  noiseFilter.type = instrument === 'snare' ? 'highpass' : 'bandpass';

  switch (instrument) {
    case 'snare':
      noiseFilter.frequency.setValueAtTime(1800, now);
      noiseGain.gain.setValueAtTime(0.0001, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.6 * effectiveGain, now + 0.003);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
      break;
    case 'closedHat':
      noiseFilter.frequency.setValueAtTime(7000, now);
      noiseFilter.Q.setValueAtTime(2.5, now);
      noiseGain.gain.setValueAtTime(0.0001, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.34 * effectiveGain, now + 0.002);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
      break;
    case 'openHat':
      noiseFilter.frequency.setValueAtTime(5200, now);
      noiseFilter.Q.setValueAtTime(1.6, now);
      noiseGain.gain.setValueAtTime(0.0001, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.28 * effectiveGain, now + 0.002);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
      break;
    case 'crash':
      noiseFilter.frequency.setValueAtTime(3600, now);
      noiseFilter.Q.setValueAtTime(1.1, now);
      noiseGain.gain.setValueAtTime(0.0001, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.32 * effectiveGain, now + 0.003);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
      break;
  }

  noise.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(outputNode);
  noise.start(now);
  noise.stop(now + 0.3);

  if (instrument === 'snare') {
    const snapOsc = context.createOscillator();
    const snapGain = context.createGain();
    snapOsc.type = 'triangle';
    snapOsc.frequency.setValueAtTime(180, now);
    snapOsc.frequency.exponentialRampToValueAtTime(90, now + 0.08);
    snapGain.gain.setValueAtTime(0.0001, now);
    snapGain.gain.exponentialRampToValueAtTime(0.22 * effectiveGain, now + 0.002);
    snapGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    snapOsc.connect(snapGain);
    snapGain.connect(outputNode);
    snapOsc.start(now);
    snapOsc.stop(now + 0.1);
  }
}

function playLaneSound(
  instrument: MidiInstrument,
  velocity: StepVelocity,
  volume = 1,
): void {
  const context = getAudioContext();
  if (!context || context.state !== 'running') return;

  const velocityGain = VELOCITY_GAIN[velocity];
  if (velocityGain <= 0) return;
  const effectiveGain = velocityGain * volume;

  if (instrument === 'snare' || instrument === 'closedHat' || instrument === 'openHat' || instrument === 'crash') {
    playNoiseInstrument(context, instrument, effectiveGain);
    return;
  }

  const profile = getInstrumentSoundProfile(instrument);
  const now = context.currentTime;
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  const filter = context.createBiquadFilter();
  const outputNode = getOutputNode(context);

  oscillator.type = profile.type;
  oscillator.frequency.setValueAtTime(profile.frequency, now);
  oscillator.frequency.exponentialRampToValueAtTime(profile.endFrequency, now + profile.duration * 0.75);

  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(profile.filterFrequency, now);
  filter.Q.setValueAtTime(0.8, now);

  gainNode.gain.setValueAtTime(0.0001, now);
  gainNode.gain.exponentialRampToValueAtTime(effectiveGain, now + 0.005);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, now + profile.duration);

  oscillator.connect(filter);
  filter.connect(gainNode);
  gainNode.connect(outputNode);

  oscillator.start(now);
  oscillator.stop(now + profile.duration + 0.02);
}

function getStepDurationMs(element: MidiElement): number {
  return 60000 / normalizeMidiElement(element).tempo / 4;
}

function getCurrentStepIndex(element: MidiElement, now: number): number {
  const runtime = playbackState.get(element.id);
  if (!runtime) return 0;

  const elapsed = Math.max(0, now - runtime.startedAt);
  return Math.floor(elapsed / getStepDurationMs(element)) % normalizeMidiElement(element).steps;
}

function syncPlayback(element: MidiElement, now: number): number | null {
  const normalized = normalizeMidiElement(element);
  if (!normalized.isLooping) {
    playbackState.delete(normalized.id);
    return null;
  }

  const runtime = playbackState.get(normalized.id) ?? {
    startedAt: now,
    lastTriggeredStep: -1,
  };
  playbackState.set(normalized.id, runtime);

  const stepIndex = getCurrentStepIndex(normalized, now);
  if (stepIndex !== runtime.lastTriggeredStep) {
    runtime.lastTriggeredStep = stepIndex;
    for (const lane of normalized.lanes) {
      const velocity = normalized.inputMode === 'tick'
        ? lane.stepVelocities[stepIndex]
        : lane.activeSteps[stepIndex]
          ? lane.stepVelocities[stepIndex] === 'off'
            ? 'normal'
            : lane.stepVelocities[stepIndex]
          : 'off';
      if (velocity !== 'off') {
        const automationVolume = normalized.automationEnabled ? normalized.stepVolumes[stepIndex] ?? 1 : 1;
        const volume = automationVolume * (normalized.masterVolume ?? 0.85);
        playLaneSound(lane.instrument, velocity, volume);
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
  const bounds = getMidiBounds(normalizeMidiElement(element));
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
  const normalized = normalizeMidiElement(element);
  seenThisFrame.add(normalized.id);

  const layout = getMidiLayout(normalized);
  const currentStep = syncPlayback(normalized, currentFrameTime);

  ctx.save();

  ctx.fillStyle = '#fffaf0';
  ctx.strokeStyle = '#2f3b52';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(layout.bounds.left, layout.bounds.top, normalized.width, normalized.height, 12);
  ctx.fill();
  ctx.stroke();

  const textY = (layout.playButtonBounds.top + layout.playButtonBounds.bottom) / 2;
  ctx.fillStyle = '#2f3b52';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('Midi', layout.bounds.left + 12, layout.bounds.top + 16);

  ctx.fillStyle = '#667085';
  ctx.font = '10px sans-serif';
  ctx.fillText(
    `${normalized.steps} steps · ${normalized.tempo} BPM · ${normalized.lanes.length} lane${normalized.lanes.length === 1 ? '' : 's'}`,
    layout.toggleModeBounds.right + 8,
    textY
  );

  renderPlayButton(ctx, layout.playButtonBounds, normalized.isLooping);
  renderModeToggle(ctx, layout.toggleModeBounds, normalized.inputMode);
  for (const laneLayout of layout.lanes) {
    renderLane(ctx, normalized, laneLayout, currentStep, normalized.inputMode);
  }

  renderAddLaneButton(ctx, layout.addLaneBounds);
  renderOpenInstrumentMenu(ctx, normalized, layout);
  renderConnectorNodes(ctx, normalized, layout);

  if (normalized.automationEnabled && layout.automationLaneBounds) {
    renderAutomationLane(ctx, normalized, layout);
  }

  ctx.restore();
}

function renderPlayButton(
  ctx: CanvasRenderingContext2D,
  bounds: BoundingBox,
  isLooping: boolean
): void {
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
  laneLayout: ReturnType<typeof getMidiLayout>['lanes'][number],
  currentStep: number | null,
  mode: MidiInputMode
): void {
  const lane = element.lanes[laneLayout.laneIndex];
  const accentColor = getLaneAccentColor(lane.instrument);

  ctx.save();

  ctx.fillStyle = '#f4efe4';
  ctx.strokeStyle = '#c9b99e';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(
    laneLayout.instrumentBounds.left,
    laneLayout.instrumentBounds.top,
    laneLayout.instrumentBounds.right - laneLayout.instrumentBounds.left,
    laneLayout.instrumentBounds.bottom - laneLayout.instrumentBounds.top,
    8
  );
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.roundRect(
    laneLayout.instrumentBounds.left + 6,
    laneLayout.instrumentBounds.top + 6,
    6,
    laneLayout.instrumentBounds.bottom - laneLayout.instrumentBounds.top - 12,
    4
  );
  ctx.fill();

  ctx.fillStyle = '#2f3b52';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(getInstrumentLabel(lane.instrument), laneLayout.instrumentBounds.left + 18, laneLayout.instrumentBounds.top + 22);

  ctx.fillStyle = '#667085';
  ctx.font = '9px sans-serif';
  ctx.fillText('Instrument', laneLayout.instrumentBounds.left + 18, laneLayout.instrumentBounds.top + 36);

  ctx.strokeStyle = '#667085';
  ctx.lineWidth = 1.5;
  const chevronX = laneLayout.instrumentBounds.right - 24;
  const chevronY = laneLayout.instrumentBounds.top + 38;
  ctx.beginPath();
  ctx.moveTo(chevronX - 4, chevronY - 3);
  ctx.lineTo(chevronX, chevronY + 1);
  ctx.lineTo(chevronX + 4, chevronY - 3);
  ctx.stroke();

  if (element.lanes.length > 1) {
    renderRemoveButton(ctx, laneLayout.removeButtonBounds);
  }

  ctx.fillStyle = '#fffef8';
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(
    laneLayout.gridBounds.left,
    laneLayout.gridBounds.top,
    laneLayout.gridBounds.right - laneLayout.gridBounds.left,
    laneLayout.gridBounds.bottom - laneLayout.gridBounds.top,
    8
  );
  ctx.fill();
  ctx.stroke();

  for (let stepIndex = 0; stepIndex < element.steps; stepIndex++) {
    const x = laneLayout.gridBounds.left + stepIndex * laneLayout.stepWidth;
    const isBarBoundary = stepIndex % 4 === 0;
    const velocity = lane.stepVelocities[stepIndex];

    if (currentStep === stepIndex) {
      ctx.fillStyle = 'rgba(15, 118, 110, 0.10)';
      ctx.fillRect(x, laneLayout.gridBounds.top, laneLayout.stepWidth, laneLayout.stepHeight);
    }

    if (mode === 'tick') {
      if (velocity !== 'off') {
        const ratioMap: Record<StepVelocity, number> = {
          off: 0,
          low: 0.33,
          normal: 0.6,
          high: 0.9,
        };
        const colorMap: Record<StepVelocity, string> = {
          off: 'transparent',
          low: '#5eead4',
          normal: accentColor,
          high: '#7c3aed',
        };
        const ratio = ratioMap[velocity];
        const tickHeight = laneLayout.stepHeight * ratio;
        const tickCenterY = (laneLayout.gridBounds.top + laneLayout.gridBounds.bottom) / 2;
        const tickX = x + laneLayout.stepWidth / 2;
        ctx.strokeStyle = colorMap[velocity];
        ctx.lineWidth = Math.max(3, laneLayout.stepWidth * 0.25);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(tickX, tickCenterY - tickHeight / 2);
        ctx.lineTo(tickX, tickCenterY + tickHeight / 2);
        ctx.stroke();
      }
    } else if (lane.activeSteps[stepIndex]) {
      const alphaMap: Record<StepVelocity, number> = {
        off: 0.5,
        low: 0.55,
        normal: 0.85,
        high: 1,
      };
      const inset = velocity === 'high' ? 2 : velocity === 'low' ? 7 : 4;
      ctx.fillStyle = withAlpha(accentColor, alphaMap[velocity]);
      ctx.beginPath();
      ctx.roundRect(
        x + inset,
        laneLayout.gridBounds.top + 4,
        Math.max(4, laneLayout.stepWidth - inset * 2),
        Math.max(8, laneLayout.stepHeight - 8),
        6
      );
      ctx.fill();
    }

    if (stepIndex > 0) {
      ctx.strokeStyle = isBarBoundary ? '#94a3b8' : '#dbe3ed';
      ctx.lineWidth = isBarBoundary ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, laneLayout.gridBounds.top + 1);
      ctx.lineTo(x, laneLayout.gridBounds.bottom - 1);
      ctx.stroke();
    }
  }

  if (currentStep !== null) {
    const playheadX = laneLayout.gridBounds.left + currentStep * laneLayout.stepWidth + laneLayout.stepWidth / 2;
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, laneLayout.gridBounds.top - 2);
    ctx.lineTo(playheadX, laneLayout.gridBounds.bottom + 2);
    ctx.stroke();
  }

  ctx.restore();
}

function renderAddLaneButton(ctx: CanvasRenderingContext2D, bounds: BoundingBox): void {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#2f3b52';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top, 8);
  ctx.fill();
  ctx.stroke();

  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  ctx.strokeStyle = '#0f766e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(centerX - 6, centerY);
  ctx.lineTo(centerX + 6, centerY);
  ctx.moveTo(centerX, centerY - 6);
  ctx.lineTo(centerX, centerY + 6);
  ctx.stroke();

  ctx.fillStyle = '#667085';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('Add lane', bounds.right + 8, centerY);
  ctx.restore();
}

function renderRemoveButton(ctx: CanvasRenderingContext2D, bounds: BoundingBox): void {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#c2410c';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top, 5);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = '#c2410c';
  ctx.beginPath();
  ctx.moveTo(bounds.left + 4, bounds.top + 4);
  ctx.lineTo(bounds.right - 4, bounds.bottom - 4);
  ctx.moveTo(bounds.right - 4, bounds.top + 4);
  ctx.lineTo(bounds.left + 4, bounds.bottom - 4);
  ctx.stroke();
  ctx.restore();
}

function renderOpenInstrumentMenu(
  ctx: CanvasRenderingContext2D,
  element: MidiElement,
  layout: ReturnType<typeof getMidiLayout>
): void {
  if (!element.openInstrumentLaneId) return;

  const laneLayout = layout.lanes.find((lane) => element.lanes[lane.laneIndex]?.id === element.openInstrumentLaneId);
  if (!laneLayout) return;

  ctx.save();
  const bounds = laneLayout.instrumentMenuBounds;
  ctx.fillStyle = 'rgba(255, 250, 240, 0.98)';
  ctx.strokeStyle = '#2f3b52';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.roundRect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top, 8);
  ctx.fill();
  ctx.stroke();

  MIDI_LANE_INSTRUMENTS.forEach((instrument, index) => {
    const rowTop = bounds.top + index * 22;
    const isActive = element.lanes[laneLayout.laneIndex].instrument === instrument;
    if (isActive) {
      ctx.fillStyle = 'rgba(15, 118, 110, 0.10)';
      ctx.fillRect(bounds.left + 1, rowTop + 1, bounds.right - bounds.left - 2, 20);
    }

    ctx.fillStyle = getLaneAccentColor(instrument);
    ctx.beginPath();
    ctx.roundRect(bounds.left + 8, rowTop + 5, 6, 12, 3);
    ctx.fill();

    ctx.fillStyle = '#2f3b52';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(getInstrumentLabel(instrument), bounds.left + 20, rowTop + 11);
  });
  ctx.restore();
}

function renderAutomationLane(
  ctx: CanvasRenderingContext2D,
  element: MidiElement,
  layout: ReturnType<typeof getMidiLayout>
): void {
  if (!layout.automationLaneBounds) return;

  const lane = layout.automationLaneBounds;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#2f3b52';
  ctx.lineWidth = 1.5;

  ctx.beginPath();
  ctx.moveTo(lane.left, lane.top);
  ctx.lineTo(lane.left, lane.bottom);
  ctx.lineTo(lane.right, lane.bottom);
  ctx.lineTo(lane.right, lane.top);
  ctx.stroke();

  if (element.automationCurvePaths) {
    ctx.strokeStyle = '#0f766e';
    for (const path of element.automationCurvePaths) {
      if (path.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x, path[i].y);
      }
      ctx.stroke();
    }
  }

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

function renderConnectorNodes(
  ctx: CanvasRenderingContext2D,
  element: MidiElement,
  layout: ReturnType<typeof getMidiLayout>
): void {
  const portCenter = {
    x: layout.bounds.right - 6,
    y: layout.bounds.top + 38,
  };

  for (const connectorLayout of layout.connectorNodes) {
    const node = element.connectorNodes?.find((entry) => entry.id === connectorLayout.nodeId);
    if (!node) continue;

    const centerX = (connectorLayout.anchorBounds.left + connectorLayout.anchorBounds.right) / 2;
    const centerY = (connectorLayout.anchorBounds.top + connectorLayout.anchorBounds.bottom) / 2;

    ctx.save();
    ctx.strokeStyle = '#475467';
    ctx.lineWidth = 2;
    renderConnectorPath(ctx, node.pathPoints ?? [], portCenter, { x: centerX, y: centerY });

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#2f3b52';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(
      connectorLayout.anchorBounds.left,
      connectorLayout.anchorBounds.top,
      connectorLayout.anchorBounds.right - connectorLayout.anchorBounds.left,
      connectorLayout.anchorBounds.bottom - connectorLayout.anchorBounds.top,
      12
    );
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#0f766e';
    renderConnectorNodeFace(ctx, node.nodeType ?? null, node.value ?? element.masterVolume ?? 0.85, connectorLayout.anchorBounds);

    if (node.menuOpen || !node.nodeType) {
      renderConnectorBubble(ctx, connectorLayout, node.nodeType ?? undefined);
    }

    ctx.restore();
  }
}

function renderConnectorNodeFace(
  ctx: CanvasRenderingContext2D,
  nodeType: MidiConnectorNodeType | null,
  value: number,
  bounds: BoundingBox
): void {
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;

  if (nodeType === 'slider') {
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(bounds.left + 8, centerY);
    ctx.lineTo(bounds.right - 8, centerY);
    ctx.stroke();

    const handleX = bounds.left + 8 + (bounds.right - bounds.left - 16) * value;
    ctx.fillStyle = '#0f766e';
    ctx.beginPath();
    ctx.roundRect(handleX - 5, centerY - 10, 10, 20, 4);
    ctx.fill();
    return;
  }

  if (nodeType === 'knob') {
    const radius = Math.min(bounds.right - bounds.left, bounds.bottom - bounds.top) * 0.34;
    const centerX = (bounds.left + bounds.right) / 2;
    const centerY = (bounds.top + bounds.bottom) / 2;

    ctx.fillStyle = '#f5efe3';
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius + 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#8b6f47';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.fillStyle = '#d6c2a1';
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#7a5e3b';
    ctx.lineWidth = 2;
    ctx.stroke();

    const angle = -Math.PI * 0.75 + value * Math.PI * 1.5;
    ctx.strokeStyle = '#245c54';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(centerX + Math.cos(angle) * (radius - 6), centerY + Math.sin(angle) * (radius - 6));
    ctx.stroke();

    ctx.fillStyle = '#245c54';
    ctx.beginPath();
    ctx.arc(centerX, centerY, 4, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  if (nodeType === 'wave') {
    ctx.strokeStyle = '#0f766e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const x = bounds.left + 6 + t * (bounds.right - bounds.left - 12);
      const y = centerY + Math.sin(t * Math.PI * 2) * 6;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    return;
  }

  ctx.fillStyle = '#0f766e';
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('?', centerX, centerY);
}

function renderConnectorPath(
  ctx: CanvasRenderingContext2D,
  pathPoints: Array<{ x: number; y: number }>,
  fallbackStart: { x: number; y: number },
  fallbackEnd: { x: number; y: number }
): void {
  const points = pathPoints.length >= 2 ? pathPoints : [fallbackStart, fallbackEnd];
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();
}

function renderConnectorBubble(
  ctx: CanvasRenderingContext2D,
  connectorLayout: ReturnType<typeof getMidiLayout>['connectorNodes'][number],
  selectedType?: MidiConnectorNodeType | null
): void {
  ctx.save();
  ctx.fillStyle = 'rgba(255, 250, 240, 0.98)';
  ctx.strokeStyle = '#2f3b52';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.roundRect(
    connectorLayout.bubbleBounds.left,
    connectorLayout.bubbleBounds.top,
    connectorLayout.bubbleBounds.right - connectorLayout.bubbleBounds.left,
    connectorLayout.bubbleBounds.bottom - connectorLayout.bubbleBounds.top,
    10
  );
  ctx.fill();
  ctx.stroke();

  (['knob', 'slider', 'wave'] as const).forEach((option) => {
    const bounds = connectorLayout.optionBounds[option];
    if (selectedType === option) {
      ctx.fillStyle = 'rgba(15, 118, 110, 0.12)';
      ctx.fillRect(bounds.left + 1, bounds.top + 1, bounds.right - bounds.left - 2, bounds.bottom - bounds.top - 2);
    }
    ctx.fillStyle = '#2f3b52';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(option === 'wave' ? 'Wave Visual' : option[0].toUpperCase() + option.slice(1), bounds.left + 12, (bounds.top + bounds.bottom) / 2);
  });

  ctx.restore();
}

function getLaneAccentColor(instrument: MidiInstrument): string {
  const index = MIDI_LANE_INSTRUMENTS.indexOf(instrument);
  const colors = ['#0f766e', '#0b7285', '#b45309', '#7c3aed', '#1d4ed8', '#be185d', '#c2410c'];
  return colors[Math.max(0, index) % colors.length];
}

function withAlpha(hexColor: string, alpha: number): string {
  const safeAlpha = Math.max(0, Math.min(1, alpha));
  const alphaHex = Math.round(safeAlpha * 255).toString(16).padStart(2, '0');
  return `${hexColor}${alphaHex}`;
}

export function getBounds(element: MidiElement): BoundingBox | null {
  return getMidiInteractionBounds(normalizeMidiElement(element));
}
