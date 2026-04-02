import type { BoundingBox, Offset, Stroke } from '../../types';
import type { HandleDragPhase, InteractionResult } from '../registry/ElementPlugin';
import type { HandwritingRecognitionResult } from '../../recognition/RecognitionService';
import { getRecognitionService } from '../../recognition/RecognitionService';
import type { MidiElement, MidiInputMode, MidiLane, MidiLaneSubdivision, StepVelocity } from './types';
import { debugLog } from '../../debug/DebugLogger';
import {
  getAutomationZoneBounds,
  getMidiBounds,
  getMidiInteractionBounds,
  getMidiLayout,
  getMidiPaddedControlBounds,
  getMidiPaddedStepGridBounds,
  getMidiStepBounds,
} from './layout';
import { primeMidiAudio } from './renderer';
import { exportMidiFile } from './midiExport';
import {
  clampMidiWidth,
  clampExportLoopCount,
  createMidiLane,
  getNearestMappedStepIndex,
  getLaneSubdivision,
  getLaneStepCount,
  MIDI_DEFAULT_LANE_SUBDIVISION,
  MIDI_AUTOMATION_MIN_HEIGHT,
  MIDI_LANE_SUBDIVISIONS,
  MIDI_MAX_TEMPO,
  MIDI_LANE_INSTRUMENTS,
  MIDI_MIN_TEMPO,
  MIDI_TEMPO_STEP,
  normalizeMidiElement,
} from './types';
import { exportWavFile } from './audioExport';

const TAP_DISTANCE_THRESHOLD = 12;
const MENU_ROW_HEIGHT = 22;
const TAP_TEMPO_IDLE_RESET_MS = 2500;
const TAP_TEMPO_MIN_INTERVAL_MS = 250;
const TAP_TEMPO_MAX_INTERVAL_MS = 1500;
const TAP_TEMPO_MIN_TAPS = 2;
const TAP_TEMPO_MAX_INTERVAL_SAMPLES = 4;

const tapTempoHistory = new Map<string, number[]>();

export type MidiTempoTapTarget = 'decrementTempo' | 'incrementTempo';

type MidiTapTarget =
  | { kind: MidiTempoTapTarget }
  | { kind: 'tapTempo' }
  | { kind: 'play' }
  | { kind: 'toggleMode' }
  | { kind: 'toggleExportMenu' }
  | { kind: 'exportMenuSurface' }
  | { kind: 'decrementExportLoopCount' }
  | { kind: 'incrementExportLoopCount' }
  | { kind: 'toggleExportAutomation' }
  | { kind: 'exportMidi' }
  | { kind: 'exportWav' }
  | { kind: 'addLane' }
  | { kind: 'removeLane'; laneIndex: number }
  | { kind: 'toggleLaneSubdivision'; laneIndex: number }
  | { kind: 'selectInstrument'; laneIndex: number; clampedCenter: Offset }
  | { kind: 'toggleInstrumentMenu'; laneIndex: number }
  | { kind: 'closeInstrumentMenu' }
  | { kind: 'stepCell'; laneIndex: number; stepIndex: number };

function boundingBoxesOverlap(a: BoundingBox, b: BoundingBox): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

function pointInBounds(point: Offset, bounds: BoundingBox): boolean {
  return (
    point.x >= bounds.left &&
    point.x <= bounds.right &&
    point.y >= bounds.top &&
    point.y <= bounds.bottom
  );
}

function pointInControlBounds(point: Offset, bounds: BoundingBox): boolean {
  return pointInBounds(point, getMidiPaddedControlBounds(bounds));
}

function getStrokeBounds(stroke: Stroke): BoundingBox | null {
  const points = stroke.inputs.inputs;
  if (points.length === 0) return null;

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }

  const halfBrush = stroke.brush.size / 2;
  return {
    left: left - halfBrush,
    top: top - halfBrush,
    right: right + halfBrush,
    bottom: bottom + halfBrush,
  };
}

function getStrokePathLength(stroke: Stroke): number {
  let total = 0;
  for (let i = 1; i < stroke.inputs.inputs.length; i++) {
    const prev = stroke.inputs.inputs[i - 1];
    const current = stroke.inputs.inputs[i];
    total += Math.hypot(current.x - prev.x, current.y - prev.y);
  }
  return total;
}

function isTapStroke(stroke: Stroke): boolean {
  const bounds = getStrokeBounds(stroke);
  if (!bounds) return false;

  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  return (
    width <= TAP_DISTANCE_THRESHOLD &&
    height <= TAP_DISTANCE_THRESHOLD &&
    getStrokePathLength(stroke) <= TAP_DISTANCE_THRESHOLD * 1.5
  );
}

function isHorizontalStroke(stroke: Stroke): boolean {
  const bounds = getStrokeBounds(stroke);
  if (!bounds) return false;
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  return width > height * 2;
}

function getStrokeHeightRatio(stroke: Stroke, stepBounds: BoundingBox): number {
  const bounds = getStrokeBounds(stroke);
  if (!bounds) return 0;
  const stepHeight = stepBounds.bottom - stepBounds.top;
  if (stepHeight === 0) return 0;
  return (bounds.bottom - bounds.top) / stepHeight;
}

function velocityFromHeightRatio(ratio: number): StepVelocity {
  if (ratio < 0.33) return 'low';
  if (ratio < 0.66) return 'normal';
  return 'high';
}

function cycleVelocity(current: StepVelocity): StepVelocity {
  const cycle: StepVelocity[] = ['off', 'low', 'normal', 'high'];
  return cycle[(cycle.indexOf(current) + 1) % cycle.length];
}

function getStrokeCenter(stroke: Stroke): Offset | null {
  const bounds = getStrokeBounds(stroke);
  if (!bounds) return null;
  return {
    x: (bounds.left + bounds.right) / 2,
    y: (bounds.top + bounds.bottom) / 2,
  };
}

function getCoverageRatio(strokes: Stroke[], bounds: BoundingBox): number {
  if (typeof document === 'undefined') return 0;

  const width = 40;
  const height = 20;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;

  const scaleX = width / (bounds.right - bounds.left);
  const scaleY = height / (bounds.bottom - bounds.top);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#000';

  for (const stroke of strokes) {
    if (stroke.inputs.inputs.length === 0) continue;
    ctx.beginPath();
    stroke.inputs.inputs.forEach((point, index) => {
      const x = (point.x - bounds.left) * scaleX;
      const y = (point.y - bounds.top) * scaleY;
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.lineWidth = Math.max(1, stroke.brush.size * Math.min(scaleX, scaleY));
    ctx.stroke();
  }

  const imageData = ctx.getImageData(0, 0, width, height).data;
  let filledPixels = 0;
  for (let i = 3; i < imageData.length; i += 4) {
    if (imageData[i] > 0) filledPixels += 1;
  }

  return filledPixels / (width * height);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampTempo(tempo: number): number {
  return clamp(Math.round(tempo), MIDI_MIN_TEMPO, MIDI_MAX_TEMPO);
}

function clampPointToBounds(point: Offset, bounds: BoundingBox): Offset {
  return {
    x: clamp(point.x, bounds.left, bounds.right - Number.EPSILON),
    y: clamp(point.y, bounds.top, bounds.bottom - Number.EPSILON),
  };
}

export function adjustTempo(element: MidiElement, delta: number): MidiElement {
  const normalized = normalizeMidiElement(element);
  return {
    ...normalized,
    tempo: clampTempo(normalized.tempo + delta),
  };
}

export function applyTempoTapTarget(
  element: MidiElement,
  target: MidiTempoTapTarget
): MidiElement {
  return adjustTempo(
    element,
    target === 'decrementTempo' ? -MIDI_TEMPO_STEP : MIDI_TEMPO_STEP
  );
}

export function getMidiTempoControlBounds(
  element: MidiElement,
  target: MidiTempoTapTarget
): BoundingBox {
  const layout = getMidiLayout(normalizeMidiElement(element));
  return target === 'decrementTempo'
    ? layout.tempoDecrementBounds
    : layout.tempoIncrementBounds;
}

export function resolveMidiTempoTapTarget(
  element: MidiElement,
  center: Offset
): MidiTempoTapTarget | null {
  const tapTarget = resolveMidiTapTarget(element, center);
  if (tapTarget?.kind === 'decrementTempo' || tapTarget?.kind === 'incrementTempo') {
    return tapTarget.kind;
  }

  return null;
}

function applyTapTempo(element: MidiElement, tapTime: number): MidiElement {
  const previousTaps = tapTempoHistory.get(element.id) ?? [];
  const lastTap = previousTaps[previousTaps.length - 1];

  if (lastTap === undefined || tapTime - lastTap > TAP_TEMPO_IDLE_RESET_MS) {
    tapTempoHistory.set(element.id, [tapTime]);
    return element;
  }

  const interval = tapTime - lastTap;
  if (interval < TAP_TEMPO_MIN_INTERVAL_MS || interval > TAP_TEMPO_MAX_INTERVAL_MS) {
    tapTempoHistory.set(element.id, [tapTime]);
    return element;
  }

  const taps = [...previousTaps, tapTime].slice(-(TAP_TEMPO_MAX_INTERVAL_SAMPLES + 1));
  tapTempoHistory.set(element.id, taps);

  if (taps.length < TAP_TEMPO_MIN_TAPS) {
    return element;
  }

  const intervals = taps.slice(1).map((value, index) => value - taps[index]);
  const averageInterval = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  const nextTempo = clampTempo(60000 / averageInterval);

  return {
    ...element,
    tempo: nextTempo,
  };
}

function getTargetCells(
  element: MidiElement,
  strokes: Stroke[]
): Array<{ laneIndex: number; stepIndex: number }> {
  const normalized = normalizeMidiElement(element);
  const targets: Array<{ laneIndex: number; stepIndex: number }> = [];
  const layout = getMidiLayout(normalized);

  for (const laneLayout of layout.lanes) {
    for (let stepIndex = 0; stepIndex < laneLayout.stepCount; stepIndex++) {
      const stepBounds = getMidiStepBounds(normalized, laneLayout.laneIndex, stepIndex);
      if (
        strokes.some((stroke) => {
          const strokeBounds = getStrokeBounds(stroke);
          return strokeBounds ? boundingBoxesOverlap(stepBounds, strokeBounds) : false;
        })
      ) {
        targets.push({ laneIndex: laneLayout.laneIndex, stepIndex });
      }
    }
  }

  return targets;
}

function togglePlayState(element: MidiElement): MidiElement {
  return {
    ...element,
    isLooping: !element.isLooping,
    openInstrumentLaneId: null,
  };
}

const DOWNLOAD_ZONE_PADDING = 250;

function getDownloadZoneBounds(element: MidiElement): BoundingBox {
  const b = getMidiBounds(element);
  return {
    left: b.left - DOWNLOAD_ZONE_PADDING,
    top: b.top - DOWNLOAD_ZONE_PADDING,
    right: b.right + DOWNLOAD_ZONE_PADDING,
    bottom: b.bottom + DOWNLOAD_ZONE_PADDING,
  };
}

function toggleMode(element: MidiElement): MidiElement {
  const normalized = normalizeMidiElement(element);
  const nextMode: MidiInputMode = normalized.inputMode === 'tap' ? 'tick' : 'tap';
  const lanes = normalized.lanes.map((lane) => {
    const stepVelocities = [...lane.stepVelocities];
    const activeSteps = [...lane.activeSteps];

    if (nextMode === 'tick') {
      for (let i = 0; i < activeSteps.length; i++) {
        if (activeSteps[i] && stepVelocities[i] === 'off') {
          stepVelocities[i] = 'normal';
        }
      }
    } else {
      for (let i = 0; i < stepVelocities.length; i++) {
        activeSteps[i] = stepVelocities[i] !== 'off';
      }
    }

    return {
      ...lane,
      activeSteps,
      stepVelocities,
    };
  });

  return {
    ...normalized,
    lanes,
    inputMode: nextMode,
    openInstrumentLaneId: null,
  };
}

function toggleInstrumentMenu(element: MidiElement, laneIndex: number): MidiElement {
  const normalized = normalizeMidiElement(element);
  const laneId = normalized.lanes[laneIndex]?.id ?? null;
  return {
    ...normalized,
    openInstrumentLaneId: normalized.openInstrumentLaneId === laneId ? null : laneId,
  };
}

function toggleExportMenu(element: MidiElement): MidiElement {
  const normalized = normalizeMidiElement(element);
  return {
    ...normalized,
    openInstrumentLaneId: null,
    exportMenuOpen: !normalized.exportMenuOpen,
  };
}

function openExportMenu(element: MidiElement): MidiElement {
  const normalized = normalizeMidiElement(element);
  return {
    ...normalized,
    openInstrumentLaneId: null,
    exportMenuOpen: true,
  };
}

function selectExportLoopCount(element: MidiElement, loopCount: number): MidiElement {
  const normalized = normalizeMidiElement(element);
  return {
    ...normalized,
    exportMenuOpen: true,
    openInstrumentLaneId: null,
    selectedExportLoopCount: clampExportLoopCount(loopCount),
  };
}

function toggleExportAutomation(element: MidiElement): MidiElement {
  const normalized = normalizeMidiElement(element);
  if (!normalized.automationHasData) {
    return normalized;
  }

  return {
    ...normalized,
    exportMenuOpen: true,
    openInstrumentLaneId: null,
    selectedExportApplyAutomation: !(normalized.selectedExportApplyAutomation ?? true),
  };
}

function addLane(element: MidiElement): MidiElement {
  const normalized = normalizeMidiElement(element);
  const nextInstrument = MIDI_LANE_INSTRUMENTS[normalized.lanes.length % MIDI_LANE_INSTRUMENTS.length];
  return normalizeMidiElement({
    ...normalized,
    lanes: [...normalized.lanes, createMidiLane(nextInstrument)],
    openInstrumentLaneId: null,
  });
}

function removeLane(element: MidiElement, laneIndex: number): MidiElement {
  const normalized = normalizeMidiElement(element);
  if (normalized.lanes.length <= 1) return normalized;

  return normalizeMidiElement({
    ...normalized,
    lanes: normalized.lanes.filter((_, index) => index !== laneIndex),
    openInstrumentLaneId: null,
  });
}

function getNextLaneSubdivision(subdivision: MidiLaneSubdivision | undefined): MidiLaneSubdivision {
  const current = subdivision ?? MIDI_DEFAULT_LANE_SUBDIVISION;
  const currentIndex = MIDI_LANE_SUBDIVISIONS.indexOf(current);
  return MIDI_LANE_SUBDIVISIONS[(currentIndex + 1) % MIDI_LANE_SUBDIVISIONS.length];
}

function remapLaneVelocities(
  sourceVelocities: StepVelocity[],
  sourceActiveSteps: boolean[],
  targetLength: number
): { activeSteps: boolean[]; stepVelocities: StepVelocity[] } {
  const sourceLength = Math.max(sourceVelocities.length, sourceActiveSteps.length);
  const nextActiveSteps = Array.from({ length: targetLength }, () => false);
  const nextStepVelocities = Array.from({ length: targetLength }, () => 'off' as StepVelocity);

  for (let sourceIndex = 0; sourceIndex < sourceLength; sourceIndex++) {
    const sourceVelocity =
      sourceVelocities[sourceIndex] ?? (sourceActiveSteps[sourceIndex] ? 'normal' : 'off');
    const isActive = sourceActiveSteps[sourceIndex] || sourceVelocity !== 'off';
    if (!isActive) {
      continue;
    }

    const targetIndex = getNearestMappedStepIndex(sourceIndex, sourceLength, targetLength);
    const velocity = sourceVelocity === 'off' ? 'normal' : sourceVelocity;

    nextActiveSteps[targetIndex] = true;
    if (
      nextStepVelocities[targetIndex] === 'off' ||
      (nextStepVelocities[targetIndex] === 'low' && velocity !== 'low') ||
      (nextStepVelocities[targetIndex] === 'normal' && velocity === 'high')
    ) {
      nextStepVelocities[targetIndex] = velocity;
    }
  }

  return {
    activeSteps: nextActiveSteps,
    stepVelocities: nextStepVelocities,
  };
}

function setLaneSubdivision(lane: MidiLane, subdivision: MidiLaneSubdivision): MidiLane {
  const nextStepCount = getLaneStepCount(subdivision);
  const remapped = remapLaneVelocities(lane.stepVelocities, lane.activeSteps, nextStepCount);
  return {
    ...lane,
    subdivision,
    activeSteps: remapped.activeSteps,
    stepVelocities: remapped.stepVelocities,
  };
}

function toggleLaneSubdivision(element: MidiElement, laneIndex: number): MidiElement {
  const normalized = normalizeMidiElement(element);
  return normalizeMidiElement({
    ...normalized,
    lanes: normalized.lanes.map((lane, index) =>
      index === laneIndex
        ? setLaneSubdivision(lane, getNextLaneSubdivision(getLaneSubdivision(lane)))
        : lane
    ),
    openInstrumentLaneId: null,
  });
}

function selectInstrumentFromMenu(
  element: MidiElement,
  laneIndex: number,
  center: Offset
): MidiElement | null {
  const normalized = normalizeMidiElement(element);
  const layout = getMidiLayout(normalized);
  const laneLayout = layout.lanes[laneIndex];
  if (!laneLayout || !pointInBounds(center, laneLayout.instrumentMenuBounds)) return null;

  const rowIndex = Math.floor((center.y - laneLayout.instrumentMenuBounds.top) / MENU_ROW_HEIGHT);
  const instrument = MIDI_LANE_INSTRUMENTS[rowIndex];
  if (!instrument) return null;

  const lanes = normalized.lanes.map((lane, index) =>
    index === laneIndex ? { ...lane, instrument } : lane
  );

  return {
    ...normalized,
    lanes,
    openInstrumentLaneId: null,
  };
}

function getStepTargetFromPoint(element: MidiElement, center: Offset): MidiTapTarget | null {
  const normalized = normalizeMidiElement(element);
  const layout = getMidiLayout(normalized);

  for (const laneLayout of layout.lanes) {
    if (!pointInBounds(center, getMidiPaddedStepGridBounds(laneLayout.gridBounds))) {
      continue;
    }

    const gridWidth = laneLayout.gridBounds.right - laneLayout.gridBounds.left;
    if (gridWidth <= 0) {
      return null;
    }

    const clampedX = clamp(center.x, laneLayout.gridBounds.left, laneLayout.gridBounds.right - Number.EPSILON);
    const stepIndex = clamp(
      Math.floor(((clampedX - laneLayout.gridBounds.left) / gridWidth) * laneLayout.stepCount),
      0,
      laneLayout.stepCount - 1
    );

    return {
      kind: 'stepCell',
      laneIndex: laneLayout.laneIndex,
      stepIndex,
    };
  }

  return null;
}

export function resolveMidiTapTarget(element: MidiElement, center: Offset): MidiTapTarget | null {
  const normalized = normalizeMidiElement(element);
  const layout = getMidiLayout(normalized);

  if (normalized.exportMenuOpen && layout.exportMenuBounds) {
    if (pointInControlBounds(center, layout.downloadButtonBounds)) {
      return { kind: 'toggleExportMenu' };
    }

    if (pointInControlBounds(center, layout.exportMenuBounds)) {
      if (layout.exportLoopDecrementBounds && pointInBounds(center, layout.exportLoopDecrementBounds)) {
        return { kind: 'decrementExportLoopCount' };
      }

      if (layout.exportLoopIncrementBounds && pointInBounds(center, layout.exportLoopIncrementBounds)) {
        return { kind: 'incrementExportLoopCount' };
      }

      if (layout.exportAutomationToggleBounds && pointInBounds(center, layout.exportAutomationToggleBounds)) {
        return { kind: 'toggleExportAutomation' };
      }

      if (layout.exportMidiActionBounds && pointInBounds(center, layout.exportMidiActionBounds)) {
        return { kind: 'exportMidi' };
      }

      if (layout.exportAudioActionBounds && pointInBounds(center, layout.exportAudioActionBounds)) {
        return { kind: 'exportWav' };
      }

      return { kind: 'exportMenuSurface' };
    }
  }

  if (pointInControlBounds(center, layout.tempoDecrementBounds)) {
    return { kind: 'decrementTempo' };
  }

  if (pointInControlBounds(center, layout.tempoIncrementBounds)) {
    return { kind: 'incrementTempo' };
  }

  if (pointInControlBounds(center, layout.tapTempoButtonBounds)) {
    return { kind: 'tapTempo' };
  }

  if (pointInControlBounds(center, layout.playButtonBounds)) {
    return { kind: 'play' };
  }

  if (pointInControlBounds(center, layout.toggleModeBounds)) {
    return { kind: 'toggleMode' };
  }

  if (pointInControlBounds(center, layout.downloadButtonBounds)) {
    return { kind: 'toggleExportMenu' };
  }

  if (pointInControlBounds(center, layout.addLaneBounds)) {
    return { kind: 'addLane' };
  }

  for (const laneLayout of layout.lanes) {
    if (pointInControlBounds(center, laneLayout.removeButtonBounds)) {
      return {
        kind: 'removeLane',
        laneIndex: laneLayout.laneIndex,
      };
    }
  }

  for (const laneLayout of layout.lanes) {
    if (pointInControlBounds(center, laneLayout.subdivisionBounds)) {
      return {
        kind: 'toggleLaneSubdivision',
        laneIndex: laneLayout.laneIndex,
      };
    }
  }

  if (normalized.openInstrumentLaneId) {
    const openLaneIndex = normalized.lanes.findIndex(
      (lane) => lane.id === normalized.openInstrumentLaneId
    );
    if (openLaneIndex >= 0) {
      const openLaneLayout = layout.lanes[openLaneIndex];
      if (pointInControlBounds(center, openLaneLayout.instrumentMenuBounds)) {
        return {
          kind: 'selectInstrument',
          laneIndex: openLaneIndex,
          clampedCenter: clampPointToBounds(center, openLaneLayout.instrumentMenuBounds),
        };
      }

      if (pointInControlBounds(center, openLaneLayout.instrumentBounds)) {
        return {
          kind: 'toggleInstrumentMenu',
          laneIndex: openLaneIndex,
        };
      }

      if (pointInBounds(center, getMidiInteractionBounds(normalized))) {
        return { kind: 'closeInstrumentMenu' };
      }
    }
  }

  for (const laneLayout of layout.lanes) {
    if (pointInControlBounds(center, laneLayout.instrumentBounds)) {
      return {
        kind: 'toggleInstrumentMenu',
        laneIndex: laneLayout.laneIndex,
      };
    }
  }

  return getStepTargetFromPoint(normalized, center);
}

function getStepVolumesFromStrokes(
  element: MidiElement,
  strokes: Stroke[],
  automationLaneBounds: BoundingBox
): number[] {
  const laneTop = automationLaneBounds.top;
  const laneHeight = automationLaneBounds.bottom - laneTop;
  const laneWidth = automationLaneBounds.right - automationLaneBounds.left;
  const stepWidth = laneWidth / element.steps;
  const updatedVolumes = [...element.stepVolumes];

  for (let stepIndex = 0; stepIndex < element.steps; stepIndex++) {
    const stepLeft = automationLaneBounds.left + stepIndex * stepWidth;
    const stepRight = stepLeft + stepWidth;

    let minY: number | null = null;
    for (const stroke of strokes) {
      for (const point of stroke.inputs.inputs) {
        if (point.x >= stepLeft && point.x < stepRight) {
          if (minY === null || point.y < minY) {
            minY = point.y;
          }
        }
      }
    }

    if (minY !== null) {
      const volume = Math.max(0, Math.min(1, 1.0 - (minY - laneTop) / laneHeight));
      updatedVolumes[stepIndex] = volume;
    }
  }

  return updatedVolumes;
}

/**
 * Simple Levenshtein distance for fuzzy matching.
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[a.length][b.length];
}

/**
 * Check if text looks like "download" using fuzzy matching.
 * Allows up to 3 edit-distance for handwriting recognition errors.
 */
function looksLikeDownload(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!normalized) return false;

  // Exact or substring matches
  if (normalized.includes('download') || normalized === 'dl') return true;

  // Fuzzy match for "dl" (short text, allow 1 edit)
  if (normalized.length <= 3 && levenshteinDistance(normalized, 'dl') <= 1) return true;

  // Common handwriting misrecognitions
  const variants = [
    'downlod', 'downlond', 'downlood', 'downlaod', 'downliad',
    'downbad', 'downloa', 'downlo', 'dwnload', 'donwload',
    'dounload', 'dwonload', 'downloed', 'downloud',
  ];
  if (variants.includes(normalized)) return true;

  // Fuzzy match: Levenshtein distance ≤ 3 from "download"
  if (normalized.length >= 4 && levenshteinDistance(normalized, 'download') <= 3) return true;

  return false;
}

function isDownloadGesture(recognitionResult?: HandwritingRecognitionResult): boolean {
  if (!recognitionResult) return false;

  // Check rawText
  const raw = recognitionResult.rawText.trim().toLowerCase();
  debugLog.info('[MIDI] isDownloadGesture checking', { rawText: raw });
  if (looksLikeDownload(raw)) {
    debugLog.info('[MIDI] Download gesture matched via rawText', { raw });
    return true;
  }

  // Also check all token candidates (recognition may pick a wrong top candidate)
  for (const line of recognitionResult.lines) {
    for (const token of line.tokens) {
      for (const candidate of token.candidates) {
        const c = candidate.text.trim().toLowerCase();
        if (looksLikeDownload(c)) {
          debugLog.info('[MIDI] Download gesture matched via candidate', { candidate: c });
          return true;
        }
      }
    }
  }

  debugLog.info('[MIDI] Download gesture NOT matched', {
    rawText: raw,
    candidates: recognitionResult.lines
      .flatMap(l => l.tokens)
      .flatMap(t => t.candidates)
      .map(c => c.text)
      .slice(0, 10),
  });
  return false;
}

function normalizeAutomationCurvePaths(
  strokes: Stroke[],
  automationLaneBounds: BoundingBox
): Array<Array<{ x: number; y: number }>> {
  const width = automationLaneBounds.right - automationLaneBounds.left;
  const height = automationLaneBounds.bottom - automationLaneBounds.top;
  if (width <= 0 || height <= 0) return [];

  return strokes
    .map((stroke) =>
      stroke.inputs.inputs.map((point) => ({
        x: Math.max(0, Math.min(1, (point.x - automationLaneBounds.left) / width)),
        y: Math.max(0, Math.min(1, (point.y - automationLaneBounds.top) / height)),
      }))
    )
    .filter((path) => path.length > 1);
}

export function isInterestedIn(
  element: MidiElement,
  _strokes: Stroke[],
  strokeBounds: BoundingBox
): boolean {
  const normalized = normalizeMidiElement(element);
  if (normalized.exportMenuOpen) {
    debugLog.info('[MIDI] isInterestedIn', {
      result: true,
      exportMenuOpen: true,
    });
    return true;
  }

  const downloadZone = getDownloadZoneBounds(element);
  const interactionBounds = getMidiInteractionBounds(normalized);
  const automationBounds = getAutomationZoneBounds(normalized);
  const inInteraction = boundingBoxesOverlap(interactionBounds, strokeBounds);
  const inAutomation = boundingBoxesOverlap(automationBounds, strokeBounds);
  const inDownload = boundingBoxesOverlap(downloadZone, strokeBounds);
  const result = inInteraction || inAutomation || inDownload;
  debugLog.info('[MIDI] isInterestedIn', {
    result,
    inInteraction,
    inAutomation,
    inDownload,
    exportMenuOpen: false,
  });
  return result;
}

export async function acceptInk(
  element: MidiElement,
  strokes: Stroke[],
  recognitionResult?: HandwritingRecognitionResult
): Promise<InteractionResult> {
  debugLog.info('[MIDI] acceptInk called', { strokeCount: strokes.length });

  const normalized = normalizeMidiElement(element);
  const midiMainBounds = getMidiBounds(normalized);
  const downloadZone = getDownloadZoneBounds(element);
  const layout = getMidiLayout(normalized);
  const automationZone = getAutomationZoneBounds(normalized);
  const mode = normalized.inputMode ?? 'tap';

  const strokesInDownloadZone = strokes.some((stroke) => {
    const bounds = getStrokeBounds(stroke);
    return bounds ? boundingBoxesOverlap(downloadZone, bounds) : false;
  });

  const strokesInAutomationZone = strokes.some((stroke) => {
    const bounds = getStrokeBounds(stroke);
    return bounds ? boundingBoxesOverlap(automationZone, bounds) : false;
  });

  // Check if ALL strokes are outside the main MIDI element bounds
  const allStrokesOutsideMain = strokes.every((stroke) => {
    const bounds = getStrokeBounds(stroke);
    if (!bounds) return true;
    return !boundingBoxesOverlap(midiMainBounds, bounds);
  });

  debugLog.info('[MIDI] acceptInk zone checks', {
    strokesInDownloadZone,
    strokesInAutomationZone,
    allStrokesOutsideMain,
    strokeCount: strokes.length,
  });

  if (strokes.length === 1) {
    const stroke = strokes[0];
    const center = getStrokeCenter(stroke);
    const tapTarget = center ? resolveMidiTapTarget(normalized, center) : null;
    const canUseTapTarget =
      tapTarget !== null &&
      (isTapStroke(stroke) || tapTarget.kind !== 'stepCell');

    if (tapTarget && canUseTapTarget) {
      switch (tapTarget.kind) {
        case 'decrementTempo':
        case 'incrementTempo':
          return {
            element: applyTempoTapTarget(normalized, tapTarget.kind),
            consumed: true,
            strokesConsumed: strokes,
          };
        case 'tapTempo':
          return {
            element: applyTapTempo(normalized, Date.now()),
            consumed: true,
            strokesConsumed: strokes,
          };
        case 'play':
          await primeMidiAudio();
          return {
            element: togglePlayState(normalized),
            consumed: true,
            strokesConsumed: strokes,
          };
        case 'toggleMode':
          return {
            element: toggleMode(normalized),
            consumed: true,
            strokesConsumed: strokes,
          };
        case 'toggleExportMenu':
          return {
            element: toggleExportMenu(normalized),
            consumed: true,
            strokesConsumed: strokes,
          };
        case 'exportMenuSurface':
          return {
            element: normalized,
            consumed: true,
            strokesConsumed: strokes,
          };
        case 'decrementExportLoopCount':
          return {
            element: selectExportLoopCount(
              normalized,
              (normalized.selectedExportLoopCount ?? 1) - 1
            ),
            consumed: true,
            strokesConsumed: strokes,
          };
        case 'incrementExportLoopCount':
          return {
            element: selectExportLoopCount(
              normalized,
              (normalized.selectedExportLoopCount ?? 1) + 1
            ),
            consumed: true,
            strokesConsumed: strokes,
          };
        case 'toggleExportAutomation':
          return {
            element: toggleExportAutomation(normalized),
            consumed: true,
            strokesConsumed: strokes,
          };
        case 'exportMidi':
          exportMidiFile(
            normalized,
            normalized.selectedExportLoopCount,
            normalized.selectedExportApplyAutomation ?? true
          );
          return {
            element: normalized,
            consumed: true,
            strokesConsumed: strokes,
          };
        case 'exportWav':
          await exportWavFile(
            normalized,
            normalized.selectedExportLoopCount,
            normalized.selectedExportApplyAutomation ?? true
          );
          return {
            element: normalized,
            consumed: true,
            strokesConsumed: strokes,
          };
        case 'addLane':
          return {
            element: addLane(normalized),
            consumed: true,
            strokesConsumed: strokes,
          };
        case 'removeLane':
          return {
            element: removeLane(normalized, tapTarget.laneIndex),
            consumed: true,
            strokesConsumed: strokes,
          };
        case 'toggleLaneSubdivision':
          return {
            element: toggleLaneSubdivision(normalized, tapTarget.laneIndex),
            consumed: true,
            strokesConsumed: strokes,
          };
        case 'selectInstrument': {
          const selected = selectInstrumentFromMenu(
            normalized,
            tapTarget.laneIndex,
            tapTarget.clampedCenter
          );
          if (selected) {
            return {
              element: selected,
              consumed: true,
              strokesConsumed: strokes,
            };
          }
          break;
        }
        case 'toggleInstrumentMenu':
          return {
            element: toggleInstrumentMenu(normalized, tapTarget.laneIndex),
            consumed: true,
            strokesConsumed: strokes,
          };
        case 'closeInstrumentMenu':
          return {
            element: {
              ...normalized,
              openInstrumentLaneId: null,
            },
            consumed: true,
            strokesConsumed: strokes,
          };
        case 'stepCell': {
          const lanes = normalized.lanes.map((lane) => ({
            ...lane,
            activeSteps: [...lane.activeSteps],
            stepVelocities: [...lane.stepVelocities],
          }));
          const lane = lanes[tapTarget.laneIndex];

          if (mode === 'tick') {
            const nextVelocity = cycleVelocity(lane.stepVelocities[tapTarget.stepIndex]);
            lane.stepVelocities[tapTarget.stepIndex] = nextVelocity;
            lane.activeSteps[tapTarget.stepIndex] = nextVelocity !== 'off';
          } else {
            const willBeActive = !lane.activeSteps[tapTarget.stepIndex];
            lane.activeSteps[tapTarget.stepIndex] = willBeActive;
            lane.stepVelocities[tapTarget.stepIndex] = willBeActive
              ? lane.stepVelocities[tapTarget.stepIndex] === 'off'
                ? 'normal'
                : lane.stepVelocities[tapTarget.stepIndex]
              : 'off';
          }

          return {
            element: {
              ...normalized,
              lanes,
              openInstrumentLaneId: null,
            },
            consumed: true,
            strokesConsumed: strokes,
          };
        }
      }
    }
  }

  if (normalized.automationEnabled && layout.automationLaneBounds) {
    const strokesInLane = strokes.filter((stroke) => {
      const bounds = getStrokeBounds(stroke);
      return bounds ? boundingBoxesOverlap(layout.automationLaneBounds!, bounds) : false;
    });

    if (strokesInLane.length > 0) {
      const updatedVolumes = getStepVolumesFromStrokes(normalized, strokesInLane, layout.automationLaneBounds);
      const automationCurvePaths = normalizeAutomationCurvePaths(
        strokesInLane,
        layout.automationLaneBounds
      );
      return {
        element: {
          ...normalized,
          stepVolumes: updatedVolumes,
          automationHasData: true,
          automationUPaths: undefined,
          automationCurvePaths,
          openInstrumentLaneId: null,
        },
        consumed: true,
        strokesConsumed: strokesInLane,
      };
    }
  }


  const allStrokesBelowMain = strokes.every((stroke) => {
    const bounds = getStrokeBounds(stroke);
    return bounds ? bounds.top >= midiMainBounds.bottom : false;
  });

  if (allStrokesBelowMain) {
    const strokesInZone = strokes.filter((stroke) => {
      const bounds = getStrokeBounds(stroke);
      return bounds ? boundingBoxesOverlap(automationZone, bounds) : false;
    });

    if (strokesInZone.length > 0) {
      let strokeTop = Infinity;
      let strokeBottom = -Infinity;
      for (const stroke of strokesInZone) {
        const bounds = getStrokeBounds(stroke);
        if (!bounds) continue;
        strokeTop = Math.min(strokeTop, bounds.top);
        strokeBottom = Math.max(strokeBottom, bounds.bottom);
      }
      const drawnHeight = Math.max(MIDI_AUTOMATION_MIN_HEIGHT, strokeBottom - strokeTop);
      return {
        element: {
          ...normalized,
          automationEnabled: true,
          automationHeight: drawnHeight,
          automationHasData: false,
          stepVolumes: [...normalized.stepVolumes],
          automationTopY: undefined,
          automationBottomY: undefined,
          automationLeftX: undefined,
          automationRightX: undefined,
          automationUPaths: undefined,
          automationCurvePaths: undefined,
          openInstrumentLaneId: null,
        },
        consumed: true,
        strokesConsumed: strokesInZone,
      };
    }
  }

  if (strokesInDownloadZone && !strokesInAutomationZone && strokes.length >= 2) {
    // Only attempt download recognition with 2+ strokes (a single stroke can't form "dl" or "download")
    debugLog.info('[MIDI] Attempting download recognition', {
      strokeCount: strokes.length,
    });
    let recog = recognitionResult;
    if (!recog) {
      try {
        recog = await getRecognitionService().recognizeGoogle(strokes);
        debugLog.info('[MIDI] Recognition result for download', {
          rawText: recog?.rawText,
          lineCount: recog?.lines?.length,
        });
      } catch (err) {
        debugLog.warn('[MIDI] Recognition FAILED for download check', err);
      }
    }
    const isDownload = isDownloadGesture(recog);
    debugLog.info('[MIDI] Download gesture check', { isDownload, rawText: recog?.rawText });
    if (isDownload) {
      debugLog.info('[MIDI] OPENING EXPORT MENU');
      return {
        element: openExportMenu(normalized),
        consumed: true,
        strokesConsumed: strokes,
      };
    }
  }

  // Let nearby download handwriting continue buffering, but never suppress automation gestures.
  if (allStrokesOutsideMain && strokesInDownloadZone && !strokesInAutomationZone) {
    debugLog.info('[MIDI] Strokes outside main bounds, not consuming (buffering for text recognition)');
    return { element: normalized, consumed: false, strokesConsumed: [] };
  }

  const targets = getTargetCells(normalized, strokes);
  if (targets.length === 0) {
    return { element: normalized, consumed: false, strokesConsumed: [] };
  }

  const lanes = normalized.lanes.map((lane) => ({
    ...lane,
    activeSteps: [...lane.activeSteps],
    stepVelocities: [...lane.stepVelocities],
  }));

  for (const target of targets) {
    const lane = lanes[target.laneIndex];
    const stepBounds = getMidiStepBounds(normalized, target.laneIndex, target.stepIndex);
    const overlappingStrokes = strokes.filter((stroke) => {
      const strokeBounds = getStrokeBounds(stroke);
      return strokeBounds ? boundingBoxesOverlap(stepBounds, strokeBounds) : false;
    });

    if (overlappingStrokes.some(isHorizontalStroke)) {
      lane.stepVelocities[target.stepIndex] = 'off';
      lane.activeSteps[target.stepIndex] = false;
      continue;
    }

    if (mode === 'tick') {
      const hasTap = overlappingStrokes.some((stroke) => {
        if (!isTapStroke(stroke)) return false;
        const center = getStrokeCenter(stroke);
        return center ? pointInBounds(center, stepBounds) : false;
      });

      if (hasTap) {
        const nextVelocity = cycleVelocity(lane.stepVelocities[target.stepIndex]);
        lane.stepVelocities[target.stepIndex] = nextVelocity;
        lane.activeSteps[target.stepIndex] = nextVelocity !== 'off';
        continue;
      }

      let maxRatio = 0;
      for (const stroke of overlappingStrokes) {
        const ratio = getStrokeHeightRatio(stroke, stepBounds);
        if (ratio > maxRatio) maxRatio = ratio;
      }
      if (maxRatio > 0) {
        const velocity = velocityFromHeightRatio(maxRatio);
        lane.stepVelocities[target.stepIndex] = velocity;
        lane.activeSteps[target.stepIndex] = velocity !== 'off';
      }
      continue;
    }

    const hasTap = overlappingStrokes.some((stroke) => {
      if (!isTapStroke(stroke)) return false;
      const center = getStrokeCenter(stroke);
      return center ? pointInBounds(center, stepBounds) : false;
    });

    if (hasTap) {
      const willBeActive = !lane.activeSteps[target.stepIndex];
      lane.activeSteps[target.stepIndex] = willBeActive;
      lane.stepVelocities[target.stepIndex] = willBeActive
        ? lane.stepVelocities[target.stepIndex] === 'off'
          ? 'normal'
          : lane.stepVelocities[target.stepIndex]
        : 'off';
      continue;
    }

    const verticalStrokes = overlappingStrokes.filter((stroke) => !isTapStroke(stroke));
    if (verticalStrokes.length > 0) {
      let maxRatio = 0;
      for (const stroke of verticalStrokes) {
        const ratio = getStrokeHeightRatio(stroke, stepBounds);
        if (ratio > maxRatio) maxRatio = ratio;
      }
      if (maxRatio > 0) {
        lane.activeSteps[target.stepIndex] = true;
        lane.stepVelocities[target.stepIndex] = velocityFromHeightRatio(maxRatio);
        continue;
      }
    }

    const coverageRatio = getCoverageRatio(overlappingStrokes, stepBounds);
    lane.activeSteps[target.stepIndex] = coverageRatio >= 0.5;
    lane.stepVelocities[target.stepIndex] = coverageRatio >= 0.5 ? 'normal' : 'off';
  }

  return {
    element: {
      ...normalized,
      lanes,
      openInstrumentLaneId: null,
    },
    consumed: true,
    strokesConsumed: strokes,
  };
}

export function getHandles(element: MidiElement) {
  const normalized = normalizeMidiElement(element);
  if (normalized.exportMenuOpen) {
    return [];
  }

  const bounds = getMidiBounds(normalized);
  return [
    {
      id: 'resizeRight',
      position: { x: bounds.right, y: (bounds.top + bounds.bottom) / 2 },
      cursor: 'ew-resize',
      appearance: {
        shape: 'square' as const,
        size: 8,
        fillColor: '#0f766e',
        strokeColor: '#ffffff',
      },
    },
  ];
}

export function onHandleDrag(
  element: MidiElement,
  handleId: string,
  phase: HandleDragPhase,
  point: Offset
): MidiElement {
  const normalized = normalizeMidiElement(element);
  if (phase === 'start' || handleId !== 'resizeRight') {
    return normalized;
  }

  const left = normalized.transform.values[6];
  return {
    ...normalized,
    width: clampMidiWidth(point.x - left),
    openInstrumentLaneId: null,
  };
}
