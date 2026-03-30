import type { BoundingBox } from '../../types';
import type { HandleDescriptor, RenderOptions } from '../registry/ElementPlugin';
import { getMidiBounds, getMidiInteractionBounds, getMidiLayout } from './layout';
import {
  getRoughCanvas,
  seedFromId,
  sketchAutoBorder,
  sketchButtonActive,
  sketchButtonIdle,
  sketchContainer,
  sketchGridMajor,
  sketchGridMinor,
  sketchTickLine,
  sketchVolBox,
} from './sketchUtils';
import {
  getInstrumentLabel,
  MIDI_LANE_INSTRUMENTS,
  normalizeMidiElement,
  type MidiElement,
  type MidiInputMode,
  type MidiInstrument,
} from './types';
import {
  createMidiOutputNode,
  getStepDurationSeconds,
  getStepVelocity,
  scheduleLaneSoundAtTime,
} from './audio';

interface PlaybackRuntimeState {
  startedAt: number;
  lastTriggeredStep: number;
}

const playbackState = new Map<string, PlaybackRuntimeState>();
let currentFrameTime = 0;
let seenThisFrame = new Set<string>();

let audioContext: AudioContext | null = null;
let masterGainNode: GainNode | null = null;

function applyHeaderMetaTextStyle(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#475569';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 17px "Caveat", cursive';
}

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (audioContext) return audioContext;
  if (!window.AudioContext) return null;
  audioContext = new window.AudioContext();
  return audioContext;
}

function getOutputNode(context: AudioContext): AudioNode {
  if (!masterGainNode) {
    masterGainNode = createMidiOutputNode(context);
  }

  return masterGainNode;
}

export async function primeMidiAudio(): Promise<void> {
  const context = getAudioContext();
  if (!context) return;
  if (context.state === 'suspended') {
    await context.resume();
  }
}

function playLaneSound(instrument: MidiInstrument, velocity: ReturnType<typeof getStepVelocity>, volume = 1): void {
  const context = getAudioContext();
  if (!context || context.state !== 'running') return;
  const outputNode = getOutputNode(context);
  scheduleLaneSoundAtTime(
    context,
    outputNode,
    instrument,
    velocity,
    context.currentTime,
    volume
  );
}

function getStepDurationMs(element: MidiElement): number {
  return getStepDurationSeconds(element) * 1000;
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
      const velocity = getStepVelocity(normalized, lane, stepIndex);
      if (velocity !== 'off') {
        const volume = normalized.automationEnabled ? normalized.stepVolumes[stepIndex] ?? 1 : 1;
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
  const seed = seedFromId(normalized.id);
  const rc = getRoughCanvas(ctx);

  ctx.save();
  ctx.shadowBlur = 5;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.08)';
  rc.rectangle(
    layout.bounds.left,
    layout.bounds.top,
    normalized.width,
    normalized.height,
    sketchContainer(seed)
  );
  ctx.shadowBlur = 0;

  applyHeaderMetaTextStyle(ctx);
  ctx.textAlign = 'left';
  ctx.fillText(
    `${normalized.steps} Steps · ${normalized.lanes.length} Lane${normalized.lanes.length === 1 ? '' : 's'}`,
    layout.headerTextBounds.left,
    (layout.headerTextBounds.top + layout.headerTextBounds.bottom) / 2
  );

  renderPlayButton(ctx, rc, layout.playButtonBounds, normalized.isLooping, seed);
  renderModeToggle(ctx, rc, layout.toggleModeBounds, normalized.inputMode, seed);
  renderTempoDisplay(ctx, layout.tempoDisplayBounds, normalized.tempo);
  renderTapTempoButton(ctx, rc, layout.tapTempoButtonBounds, seed);
  renderDownloadButton(ctx, rc, layout.downloadButtonBounds, normalized.exportMenuOpen, seed);

  for (const laneLayout of layout.lanes) {
    renderLane(ctx, rc, normalized, laneLayout, currentStep, normalized.inputMode, seed);
  }

  renderAddLaneButton(ctx, rc, layout.addLaneBounds, seed);
  renderOpenInstrumentMenu(ctx, rc, normalized, layout, seed);
  renderOpenExportMenu(ctx, rc, normalized, layout, seed);

  if (normalized.automationEnabled && layout.automationLaneBounds) {
    renderAutomationLane(ctx, rc, normalized, layout, seed);
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
    bounds.left,
    bounds.top,
    w,
    h,
    isLooping ? sketchButtonActive('#0f766e', seed + 1) : sketchButtonIdle(seed + 1)
  );

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
    bounds.left,
    bounds.top,
    bounds.right - bounds.left,
    bounds.bottom - bounds.top,
    isTickMode ? sketchButtonActive('#6d28d9', seed + 2) : sketchButtonIdle(seed + 2)
  );

  ctx.fillStyle = isTickMode ? '#ffffff' : '#2f3b52';
  ctx.font = 'bold 15px "Caveat", cursive';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(isTickMode ? 'TICK' : 'TAP', (bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2);
  ctx.restore();
}

function renderTempoDisplay(
  ctx: CanvasRenderingContext2D,
  bounds: BoundingBox,
  tempo: number
): void {
  ctx.save();
  applyHeaderMetaTextStyle(ctx);
  ctx.textAlign = 'center';
  ctx.fillText(`${tempo} BPM`, (bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2 + 1);
  ctx.restore();
}

function renderTapTempoButton(
  ctx: CanvasRenderingContext2D,
  rc: ReturnType<typeof getRoughCanvas>,
  bounds: BoundingBox,
  seed: number
): void {
  ctx.save();
  rc.rectangle(
    bounds.left,
    bounds.top,
    bounds.right - bounds.left,
    bounds.bottom - bounds.top,
    sketchButtonActive(getLaneAccentColor('kick'), seed + 3)
  );

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 14px "Caveat", cursive';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('TAP TEMPO', (bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2);
  ctx.restore();
}

function renderDownloadButton(
  ctx: CanvasRenderingContext2D,
  rc: ReturnType<typeof getRoughCanvas>,
  bounds: BoundingBox,
  isOpen: boolean,
  seed: number
): void {
  ctx.save();
  rc.rectangle(
    bounds.left,
    bounds.top,
    bounds.right - bounds.left,
    bounds.bottom - bounds.top,
    isOpen ? sketchButtonActive('#d7ebe4', seed + 4) : sketchButtonActive('#f3ecdf', seed + 4)
  );

  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  const iconTop = bounds.top + 6;
  const iconBottom = bounds.bottom - 7;

  ctx.strokeStyle = isOpen ? '#1f5d56' : '#2f3b52';
  ctx.fillStyle = isOpen ? '#1f5d56' : '#2f3b52';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(centerX, iconTop);
  ctx.lineTo(centerX, centerY + 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(centerX - 5, centerY - 1);
  ctx.lineTo(centerX, centerY + 5);
  ctx.lineTo(centerX + 5, centerY - 1);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(centerX - 6, iconBottom);
  ctx.lineTo(centerX + 6, iconBottom);
  ctx.stroke();
  ctx.restore();
}

function renderLane(
  ctx: CanvasRenderingContext2D,
  rc: ReturnType<typeof getRoughCanvas>,
  element: MidiElement,
  laneLayout: ReturnType<typeof getMidiLayout>['lanes'][number],
  currentStep: number | null,
  mode: MidiInputMode,
  seed: number
): void {
  const lane = element.lanes[laneLayout.laneIndex];
  const accentColor = getLaneAccentColor(lane.instrument);
  const stepInsetX = Math.min(8, Math.max(5, laneLayout.stepWidth * 0.14));
  const stepInsetY = Math.min(8, Math.max(5, laneLayout.stepHeight * 0.16));
  const labelX = laneLayout.instrumentBounds.left + 26;
  const labelMaxWidth = Math.max(24, laneLayout.removeButtonBounds.left - labelX - 12);

  ctx.save();

  rc.rectangle(
    laneLayout.instrumentBounds.left,
    laneLayout.instrumentBounds.top,
    laneLayout.instrumentBounds.right - laneLayout.instrumentBounds.left,
    laneLayout.instrumentBounds.bottom - laneLayout.instrumentBounds.top,
    {
      roughness: 1.0,
      bowing: 0.7,
      stroke: '#c9b99e',
      strokeWidth: 1,
      fill: '#f4efe4',
      fillStyle: 'solid',
      seed: seed + laneLayout.laneIndex * 37 + 1,
    }
  );

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
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '500 17px "Caveat", cursive';
  ctx.fillText(
    getInstrumentLabel(lane.instrument),
    labelX,
    laneLayout.instrumentBounds.top + 21,
    labelMaxWidth
  );

  ctx.fillStyle = '#64748b';
  ctx.font = '14px "Caveat", cursive';
  ctx.fillText('Instrument', labelX, laneLayout.instrumentBounds.top + 38, labelMaxWidth - 18);

  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 1.5;
  const chevronX = laneLayout.removeButtonBounds.left - 16;
  const chevronY = laneLayout.instrumentBounds.top + 38;
  ctx.beginPath();
  ctx.moveTo(chevronX - 4, chevronY - 3);
  ctx.lineTo(chevronX, chevronY + 1);
  ctx.lineTo(chevronX + 4, chevronY - 3);
  ctx.stroke();

  if (element.lanes.length > 1) {
    renderRemoveButton(ctx, rc, laneLayout.removeButtonBounds, seed + laneLayout.laneIndex * 37 + 5);
  }

  rc.rectangle(
    laneLayout.gridBounds.left,
    laneLayout.gridBounds.top,
    laneLayout.gridBounds.right - laneLayout.gridBounds.left,
    laneLayout.gridBounds.bottom - laneLayout.gridBounds.top,
    {
      roughness: 0.8,
      bowing: 0.6,
      stroke: '#94a3b8',
      strokeWidth: 1,
      fill: '#fffef8',
      fillStyle: 'solid',
      seed: seed + laneLayout.laneIndex * 37 + 9,
    }
  );

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
        const tickWidth = Math.max(3, laneLayout.stepWidth * 0.25);
        rc.line(
          tickX,
          tickCenterY - tickHeight / 2,
          tickX,
          tickCenterY + tickHeight / 2,
          sketchTickLine(colorMap[velocity], tickWidth, seed + laneLayout.laneIndex * 101 + stepIndex + 20)
        );
      }
    } else if (lane.activeSteps[stepIndex]) {
      const alphaMap: Record<StepVelocity, number> = {
        off: 0.5,
        low: 0.55,
        normal: 0.85,
        high: 1,
      };
      const inset = velocity === 'high' ? 2 : velocity === 'low' ? 7 : 4;
      rc.rectangle(
        x + Math.max(inset, stepInsetX * 0.5),
        laneLayout.gridBounds.top + stepInsetY,
        Math.max(4, laneLayout.stepWidth - Math.max(inset, stepInsetX * 0.5) * 2),
        Math.max(8, laneLayout.stepHeight - stepInsetY * 2),
        {
          roughness: 1.4,
          bowing: 1.0,
          stroke: accentColor,
          strokeWidth: 1,
          fill: withAlpha(accentColor, alphaMap[velocity]),
          fillStyle: 'hachure',
          hachureAngle: -41,
          hachureGap: 4,
          seed: seed + laneLayout.laneIndex * 101 + stepIndex + 120,
        }
      );
    }

    if (stepIndex > 0) {
      rc.line(
        x,
        laneLayout.gridBounds.top + 1,
        x,
        laneLayout.gridBounds.bottom - 1,
        isBarBoundary
          ? sketchGridMajor(seed + laneLayout.laneIndex * 101 + stepIndex + 220)
          : sketchGridMinor(seed + laneLayout.laneIndex * 101 + stepIndex + 220)
      );
    }
  }

  if (currentStep !== null) {
    const playheadX =
      laneLayout.gridBounds.left + currentStep * laneLayout.stepWidth + laneLayout.stepWidth / 2;
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, laneLayout.gridBounds.top - 2);
    ctx.lineTo(playheadX, laneLayout.gridBounds.bottom + 2);
    ctx.stroke();
  }

  ctx.restore();
}

function renderAddLaneButton(
  ctx: CanvasRenderingContext2D,
  rc: ReturnType<typeof getRoughCanvas>,
  bounds: BoundingBox,
  seed: number
): void {
  ctx.save();
  rc.rectangle(
    bounds.left,
    bounds.top,
    bounds.right - bounds.left,
    bounds.bottom - bounds.top,
    sketchButtonIdle(seed + 400)
  );

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

  ctx.fillStyle = '#64748b';
  ctx.font = '16px "Caveat", cursive';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('Add Lane', bounds.right + 8, centerY);
  ctx.restore();
}

function renderRemoveButton(
  ctx: CanvasRenderingContext2D,
  rc: ReturnType<typeof getRoughCanvas>,
  bounds: BoundingBox,
  seed: number
): void {
  ctx.save();
  rc.rectangle(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top, {
    roughness: 1.0,
    bowing: 0.7,
    stroke: '#c2410c',
    strokeWidth: 1.2,
    fill: '#fff7ed',
    fillStyle: 'solid',
    seed,
  });

  ctx.strokeStyle = '#c2410c';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(bounds.left + 3.5, bounds.top + 3.5);
  ctx.lineTo(bounds.right - 3.5, bounds.bottom - 3.5);
  ctx.moveTo(bounds.right - 3.5, bounds.top + 3.5);
  ctx.lineTo(bounds.left + 3.5, bounds.bottom - 3.5);
  ctx.stroke();
  ctx.restore();
}

function renderOpenInstrumentMenu(
  ctx: CanvasRenderingContext2D,
  rc: ReturnType<typeof getRoughCanvas>,
  element: MidiElement,
  layout: ReturnType<typeof getMidiLayout>,
  seed: number
): void {
  if (!element.openInstrumentLaneId) return;

  const laneLayout = layout.lanes.find(
    (lane) => element.lanes[lane.laneIndex]?.id === element.openInstrumentLaneId
  );
  if (!laneLayout) return;

  ctx.save();
  const bounds = laneLayout.instrumentMenuBounds;
  rc.rectangle(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top, {
    roughness: 1.0,
    bowing: 0.7,
    stroke: '#2f3b52',
    strokeWidth: 1.4,
    fill: '#fffaf0',
    fillStyle: 'solid',
    seed: seed + 500 + laneLayout.laneIndex,
  });

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
    ctx.font = '14px "Caveat", cursive';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(getInstrumentLabel(instrument), bounds.left + 20, rowTop + 11);
  });
  ctx.restore();
}

function renderOpenExportMenu(
  ctx: CanvasRenderingContext2D,
  rc: ReturnType<typeof getRoughCanvas>,
  element: MidiElement,
  layout: ReturnType<typeof getMidiLayout>,
  seed: number
): void {
  if (!element.exportMenuOpen || !layout.exportMenuBounds) return;

  ctx.save();
  const bounds = layout.exportMenuBounds;
  rc.rectangle(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top, {
    roughness: 1.0,
    bowing: 0.7,
    stroke: '#2f3b52',
    strokeWidth: 1.4,
    fill: '#fffaf0',
    fillStyle: 'solid',
    seed: seed + 520,
  });

  ctx.fillStyle = '#64748b';
  ctx.font = '17px "Caveat", cursive';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('Audio length (num of loops)', bounds.left + 8, bounds.top + 16);

  if (layout.exportLoopDecrementBounds && layout.exportLoopDisplayBounds && layout.exportLoopIncrementBounds) {
    renderLoopAdjustButton(ctx, rc, layout.exportLoopDecrementBounds, '-', seed + 530);

    rc.rectangle(
      layout.exportLoopDisplayBounds.left,
      layout.exportLoopDisplayBounds.top,
      layout.exportLoopDisplayBounds.right - layout.exportLoopDisplayBounds.left,
      layout.exportLoopDisplayBounds.bottom - layout.exportLoopDisplayBounds.top,
      sketchButtonIdle(seed + 531)
    );
    ctx.fillStyle = '#2f3b52';
    ctx.font = 'bold 17px "Caveat", cursive';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      `${element.selectedExportLoopCount ?? 1}x`,
      (layout.exportLoopDisplayBounds.left + layout.exportLoopDisplayBounds.right) / 2,
      (layout.exportLoopDisplayBounds.top + layout.exportLoopDisplayBounds.bottom) / 2 - 1
    );

    renderLoopAdjustButton(ctx, rc, layout.exportLoopIncrementBounds, '+', seed + 532);
  }

  if (layout.exportAutomationToggleBounds) {
    renderExportAutomationToggle(
      ctx,
      rc,
      layout.exportAutomationToggleBounds,
      element.automationHasData ?? false,
      element.selectedExportApplyAutomation ?? true,
      seed + 545
    );
  }

  if (layout.exportMidiActionBounds) {
    renderExportActionButton(
      ctx,
      rc,
      layout.exportMidiActionBounds,
      'MIDI (.mid)',
      '#475569',
      seed + 560
    );
  }

  if (layout.exportAudioActionBounds) {
    renderExportActionButton(
      ctx,
      rc,
      layout.exportAudioActionBounds,
      'Audio (.wav)',
      '#0f766e',
      seed + 561
    );
  }

  ctx.restore();
}

function renderExportAutomationToggle(
  ctx: CanvasRenderingContext2D,
  rc: ReturnType<typeof getRoughCanvas>,
  bounds: BoundingBox,
  hasAutomation: boolean,
  applyAutomation: boolean,
  seed: number
): void {
  const stateLabel = hasAutomation ? (applyAutomation ? ' ON' : 'OFF') : 'No curve';
  const fillColor = !hasAutomation
    ? '#eee7da'
    : applyAutomation
      ? '#0f766e'
      : '#d7e1ec';
  const textColor = !hasAutomation
    ? '#94a3b8'
    : applyAutomation
      ? '#ffffff'
      : '#2f3b52';
  const iconCurveColor = hasAutomation ? '#0f766e' : '#64748b';
  const centerY = (bounds.top + bounds.bottom) / 2;
  const iconWidth = 28;
  const iconHeight = 16;
  const stateInset = 10;
  const labelInset = 10;
  const labelIconGap = 12;
  const stateIconGap = 18;

  rc.rectangle(
    bounds.left,
    bounds.top,
    bounds.right - bounds.left,
    bounds.bottom - bounds.top,
    hasAutomation ? sketchButtonActive(fillColor, seed) : sketchButtonIdle(seed)
  );

  ctx.save();
  ctx.fillStyle = textColor;
  ctx.font = 'bold 17px "Caveat", cursive';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const labelX = bounds.left + labelInset;
  const label = 'Apply VOL curve';
  ctx.fillText(
    label,
    labelX,
    centerY
  );

  ctx.font = 'bold 15px "Caveat", cursive';
  const stateWidth = ctx.measureText(stateLabel).width;
  ctx.font = 'bold 17px "Caveat", cursive';
  const labelWidth = ctx.measureText(label).width;
  ctx.font = 'bold 15px "Caveat", cursive';
  const stateX = bounds.right - stateInset;
  const preferredIconLeft = labelX + labelWidth + labelIconGap;
  const maxIconLeft = stateX - stateWidth - stateIconGap - iconWidth;
  const iconLeft = Math.min(preferredIconLeft, maxIconLeft);
  const iconTop = centerY - iconHeight / 2;

  ctx.shadowBlur = 0;
  rc.rectangle(iconLeft, iconTop, iconWidth, iconHeight, sketchVolBox(seed + 1));

  ctx.strokeStyle = iconCurveColor;
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(iconLeft + 3, iconTop + iconHeight - 4);
  ctx.quadraticCurveTo(
    iconLeft + iconWidth * 0.38,
    iconTop + iconHeight * 0.25,
    iconLeft + iconWidth * 0.58,
    iconTop + iconHeight * 0.58
  );
  ctx.quadraticCurveTo(
    iconLeft + iconWidth * 0.76,
    iconTop + iconHeight * 0.9,
    iconLeft + iconWidth - 3,
    iconTop + 4
  );
  ctx.stroke();

  ctx.textAlign = 'right';
  ctx.fillText(stateLabel, stateX, centerY);
  ctx.restore();
}

function renderExportActionButton(
  ctx: CanvasRenderingContext2D,
  rc: ReturnType<typeof getRoughCanvas>,
  bounds: BoundingBox,
  label: string,
  color: string,
  seed: number
): void {
  rc.rectangle(
    bounds.left,
    bounds.top,
    bounds.right - bounds.left,
    bounds.bottom - bounds.top,
    sketchButtonActive(color, seed)
  );

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 17px "Caveat", cursive';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, (bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2);
}

function renderLoopAdjustButton(
  ctx: CanvasRenderingContext2D,
  rc: ReturnType<typeof getRoughCanvas>,
  bounds: BoundingBox,
  label: string,
  seed: number
): void {
  rc.rectangle(
    bounds.left,
    bounds.top,
    bounds.right - bounds.left,
    bounds.bottom - bounds.top,
    sketchButtonIdle(seed)
  );

  ctx.fillStyle = '#2f3b52';
  ctx.font = 'bold 18px "Caveat", cursive';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, (bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2);
}

function renderAutomationCurve(
  ctx: CanvasRenderingContext2D,
  element: MidiElement,
  lane: BoundingBox
): void {
  if (!element.automationHasData) return;

  const innerLeft = lane.left + 8;
  const innerRight = lane.right - 8;
  const innerTop = lane.top + 8;
  const innerBottom = lane.bottom - 8;
  const innerHeight = innerBottom - innerTop;
  const drawableWidth = innerRight - innerLeft;
  if (innerHeight <= 0 || drawableWidth <= 0) return;

  ctx.save();
  ctx.strokeStyle = '#0f766e';
  ctx.lineWidth = 2;
  const curvePaths = element.automationCurvePaths ?? [];

  if (curvePaths.length > 0) {
    for (const path of curvePaths) {
      if (path.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(
        innerLeft + path[0].x * drawableWidth,
        innerTop + path[0].y * innerHeight
      );
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(
          innerLeft + path[i].x * drawableWidth,
          innerTop + path[i].y * innerHeight
        );
      }
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  if (element.steps > 0) {
    const stepWidth = drawableWidth / element.steps;
    const points = Array.from({ length: element.steps }, (_, index) => {
      const volume = Math.max(0, Math.min(1, element.stepVolumes[index] ?? 1));
      return {
        x: innerLeft + stepWidth * index + stepWidth / 2,
        y: innerBottom - volume * innerHeight,
      };
    });

    if (points.length > 0) {
      ctx.beginPath();
      ctx.moveTo(innerLeft, points[0].y);
      for (const point of points) {
        ctx.lineTo(point.x, point.y);
      }
      ctx.lineTo(innerRight, points[points.length - 1].y);
      ctx.stroke();
    }
  }

  ctx.restore();
}

function renderAutomationLane(
  ctx: CanvasRenderingContext2D,
  rc: ReturnType<typeof getRoughCanvas>,
  element: MidiElement,
  layout: ReturnType<typeof getMidiLayout>,
  seed: number
): void {
  if (!layout.automationLaneBounds) return;

  const lane = layout.automationLaneBounds;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const borderOpts = sketchAutoBorder(seed + 600);
  rc.line(lane.left, lane.top, lane.left, lane.bottom, borderOpts);
  rc.line(lane.left, lane.bottom, lane.right, lane.bottom, borderOpts);
  rc.line(lane.right, lane.bottom, lane.right, lane.top, borderOpts);

  const indicatorW = 36;
  const indicatorH = 20;
  const indicatorX = lane.left + 4;
  const indicatorY = lane.top + 4;
  rc.rectangle(indicatorX, indicatorY, indicatorW, indicatorH, sketchVolBox(seed + 601));
  ctx.fillStyle = '#2f3b52';
  ctx.font = 'bold 15px "Caveat", cursive';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('VOL', indicatorX + indicatorW / 2, indicatorY + indicatorH / 2);

  renderAutomationCurve(ctx, element, lane);

  ctx.restore();
}

function getLaneAccentColor(instrument: MidiInstrument): string {
  const index = MIDI_LANE_INSTRUMENTS.indexOf(instrument);
  const colors = [
    '#0f766e',
    '#0b7285',
    '#b45309',
    '#7c3aed',
    '#1d4ed8',
    '#be185d',
    '#c2410c',
    '#dc2626',
    '#4d7c0f',
  ];
  return colors[Math.max(0, index) % colors.length];
}

function withAlpha(hexColor: string, alpha: number): string {
  const safeAlpha = Math.max(0, Math.min(1, alpha));
  const alphaHex = Math.round(safeAlpha * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hexColor}${alphaHex}`;
}

export function getBounds(element: MidiElement): BoundingBox | null {
  return getMidiInteractionBounds(normalizeMidiElement(element));
}
