import type { BoundingBox, Offset, Stroke } from '../../types';
import type { HandleDragPhase, InteractionResult } from '../registry/ElementPlugin';
import type { MidiElement, MidiInputMode, StepVelocity } from './types';
import {
  getAutomationZoneBounds,
  getMidiBounds,
  getMidiInteractionBounds,
  getMidiLayout,
  getMidiStepBounds,
} from './layout';
import { primeMidiAudio } from './renderer';
import {
  createMidiLane,
  getMidiHeightForLaneCount,
  MIDI_AUTOMATION_MIN_HEIGHT,
  MIDI_LANE_INSTRUMENTS,
  MIDI_MIN_HEIGHT,
  normalizeMidiElement,
} from './types';

const TAP_DISTANCE_THRESHOLD = 12;
const MIN_MIDI_WIDTH = 320;
const MENU_ROW_HEIGHT = 22;
const TAP_TEMPO_IDLE_RESET_MS = 2500;
const TAP_TEMPO_MIN_INTERVAL_MS = 250;
const TAP_TEMPO_MAX_INTERVAL_MS = 1500;
const TAP_TEMPO_MIN_TAPS = 3;
const TAP_TEMPO_MAX_INTERVAL_SAMPLES = 4;
const TAP_TEMPO_MIN_BPM = 40;
const TAP_TEMPO_MAX_BPM = 240;

const tapTempoHistory = new Map<string, number[]>();

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
  const nextTempo = clamp(
    Math.round(60000 / averageInterval),
    TAP_TEMPO_MIN_BPM,
    TAP_TEMPO_MAX_BPM
  );

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

  for (let laneIndex = 0; laneIndex < normalized.lanes.length; laneIndex++) {
    for (let stepIndex = 0; stepIndex < normalized.steps; stepIndex++) {
      const stepBounds = getMidiStepBounds(normalized, laneIndex, stepIndex);
      if (
        strokes.some((stroke) => {
          const strokeBounds = getStrokeBounds(stroke);
          return strokeBounds ? boundingBoxesOverlap(stepBounds, strokeBounds) : false;
        })
      ) {
        targets.push({ laneIndex, stepIndex });
      }
    }
  }

  return targets;
}

function togglePlayState(element: MidiElement): MidiElement {
  return {
    ...element,
    isLooping: !element.isLooping,
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

function addLane(element: MidiElement): MidiElement {
  const normalized = normalizeMidiElement(element);
  const nextInstrument = MIDI_LANE_INSTRUMENTS[normalized.lanes.length % MIDI_LANE_INSTRUMENTS.length];
  const lanes = [...normalized.lanes, createMidiLane(normalized.steps, nextInstrument)];
  const nextHeight = Math.max(MIDI_MIN_HEIGHT, getMidiHeightForLaneCount(lanes.length));

  return {
    ...normalized,
    lanes,
    height: nextHeight,
    openInstrumentLaneId: null,
  };
}

function removeLane(element: MidiElement, laneIndex: number): MidiElement {
  const normalized = normalizeMidiElement(element);
  if (normalized.lanes.length <= 1) return normalized;

  const lanes = normalized.lanes.filter((_, index) => index !== laneIndex);
  const nextHeight = Math.max(MIDI_MIN_HEIGHT, getMidiHeightForLaneCount(lanes.length));

  return {
    ...normalized,
    lanes,
    height: nextHeight,
    openInstrumentLaneId: null,
  };
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
  return (
    boundingBoxesOverlap(getMidiInteractionBounds(normalized), strokeBounds) ||
    boundingBoxesOverlap(getAutomationZoneBounds(normalized), strokeBounds)
  );
}

export async function acceptInk(
  element: MidiElement,
  strokes: Stroke[]
): Promise<InteractionResult> {
  const normalized = normalizeMidiElement(element);
  const layout = getMidiLayout(normalized);
  const mode = normalized.inputMode ?? 'tap';

  if (strokes.length === 1) {
    const stroke = strokes[0];
    const center = getStrokeCenter(stroke);

    if (
      center &&
      isTapStroke(stroke) &&
      pointInBounds(center, layout.tapTempoButtonBounds)
    ) {
      return {
        element: applyTapTempo(normalized, Date.now()),
        consumed: true,
        strokesConsumed: strokes,
      };
    }

    if (center && pointInBounds(center, layout.playButtonBounds)) {
      await primeMidiAudio();
      return {
        element: togglePlayState(normalized),
        consumed: true,
        strokesConsumed: strokes,
      };
    }

    if (center && pointInBounds(center, layout.toggleModeBounds)) {
      return {
        element: toggleMode(normalized),
        consumed: true,
        strokesConsumed: strokes,
      };
    }

    if (center && pointInBounds(center, layout.addLaneBounds)) {
      return {
        element: addLane(normalized),
        consumed: true,
        strokesConsumed: strokes,
      };
    }

    for (const laneLayout of layout.lanes) {
      if (center && pointInBounds(center, laneLayout.removeButtonBounds)) {
        return {
          element: removeLane(normalized, laneLayout.laneIndex),
          consumed: true,
          strokesConsumed: strokes,
        };
      }
    }

    if (center && normalized.openInstrumentLaneId) {
      const openLaneIndex = normalized.lanes.findIndex(
        (lane) => lane.id === normalized.openInstrumentLaneId
      );
      if (openLaneIndex >= 0) {
        const selected = selectInstrumentFromMenu(normalized, openLaneIndex, center);
        if (selected) {
          return {
            element: selected,
            consumed: true,
            strokesConsumed: strokes,
          };
        }

        const openLaneLayout = layout.lanes[openLaneIndex];
        if (pointInBounds(center, openLaneLayout.instrumentBounds)) {
          return {
            element: toggleInstrumentMenu(normalized, openLaneIndex),
            consumed: true,
            strokesConsumed: strokes,
          };
        }

        if (pointInBounds(center, getMidiInteractionBounds(normalized))) {
          return {
            element: {
              ...normalized,
              openInstrumentLaneId: null,
            },
            consumed: true,
            strokesConsumed: strokes,
          };
        }
      }
    }

    for (const laneLayout of layout.lanes) {
      if (center && pointInBounds(center, laneLayout.instrumentBounds)) {
        return {
          element: toggleInstrumentMenu(normalized, laneLayout.laneIndex),
          consumed: true,
          strokesConsumed: strokes,
        };
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

  const midiMainBounds = getMidiBounds(normalized);
  const allStrokesBelowMain = strokes.every((stroke) => {
    const bounds = getStrokeBounds(stroke);
    return bounds ? bounds.top >= midiMainBounds.bottom : false;
  });

  if (allStrokesBelowMain) {
    const automationZone = getAutomationZoneBounds(normalized);
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

    if (mode === 'tick') {
      if (overlappingStrokes.some(isHorizontalStroke)) {
        lane.stepVelocities[target.stepIndex] = 'off';
        lane.activeSteps[target.stepIndex] = false;
        continue;
      }

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
  const bounds = getMidiBounds(normalizeMidiElement(element));
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
    width: Math.max(MIN_MIDI_WIDTH, point.x - left),
  };
}
