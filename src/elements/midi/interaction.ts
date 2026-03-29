import type { BoundingBox, Offset, Stroke } from '../../types';
import type { HandleDragPhase, InteractionResult } from '../registry/ElementPlugin';
import type { MidiElement } from './types';
import { getMidiInteractionBounds, getMidiLayout, getMidiStepBounds } from './layout';
import { primeMidiAudio } from './renderer';
import {
  createMidiLane,
  getMidiHeightForLaneCount,
  MIDI_LANE_INSTRUMENTS,
  MIDI_MIN_HEIGHT,
  normalizeMidiElement,
} from './types';

const TAP_DISTANCE_THRESHOLD = 12;
const MIN_MIDI_WIDTH = 320;

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
    stroke.inputs.inputs.length <= 3 ||
    (width <= TAP_DISTANCE_THRESHOLD &&
      height <= TAP_DISTANCE_THRESHOLD &&
      getStrokePathLength(stroke) <= TAP_DISTANCE_THRESHOLD * 1.5)
  );
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
    if (imageData[i] > 0) {
      filledPixels += 1;
    }
  }

  return filledPixels / (width * height);
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

function cycleLaneInstrument(element: MidiElement, laneIndex: number): MidiElement {
  const normalized = normalizeMidiElement(element);
  const lanes = normalized.lanes.map((lane, index) => {
    if (index !== laneIndex) return lane;
    const currentIndex = MIDI_LANE_INSTRUMENTS.indexOf(lane.instrument);
    return {
      ...lane,
      instrument: MIDI_LANE_INSTRUMENTS[(currentIndex + 1) % MIDI_LANE_INSTRUMENTS.length],
    };
  });

  return {
    ...normalized,
    lanes,
  };
}

function toggleInstrumentMenu(element: MidiElement, laneIndex: number): MidiElement {
  const normalized = normalizeMidiElement(element);
  const laneId = normalized.lanes[laneIndex]?.id ?? null;
  return {
    ...normalized,
    openInstrumentLaneId:
      normalized.openInstrumentLaneId === laneId ? null : laneId,
  };
}

function addLane(element: MidiElement): MidiElement {
  const normalized = normalizeMidiElement(element);
  const nextInstrument = MIDI_LANE_INSTRUMENTS[normalized.lanes.length % MIDI_LANE_INSTRUMENTS.length];
  const lanes = [...normalized.lanes, createMidiLane(normalized.steps, nextInstrument)];

  return {
    ...normalized,
    lanes,
    height: Math.max(MIDI_MIN_HEIGHT, getMidiHeightForLaneCount(lanes.length)),
    openInstrumentLaneId: null,
  };
}

function removeLane(element: MidiElement, laneIndex: number): MidiElement {
  const normalized = normalizeMidiElement(element);
  if (normalized.lanes.length <= 1) return normalized;

  const lanes = normalized.lanes.filter((_, index) => index !== laneIndex);
  return {
    ...normalized,
    lanes,
    height: Math.max(MIDI_MIN_HEIGHT, getMidiHeightForLaneCount(lanes.length)),
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

  const rowIndex = Math.floor((center.y - laneLayout.instrumentMenuBounds.top) / 22);
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

export function isInterestedIn(
  element: MidiElement,
  _strokes: Stroke[],
  strokeBounds: BoundingBox
): boolean {
  return boundingBoxesOverlap(getMidiInteractionBounds(normalizeMidiElement(element)), strokeBounds);
}

export async function acceptInk(
  element: MidiElement,
  strokes: Stroke[]
): Promise<InteractionResult> {
  const normalized = normalizeMidiElement(element);
  const layout = getMidiLayout(normalized);

  if (strokes.length === 1) {
    const center = getStrokeCenter(strokes[0]);
    if (center && pointInBounds(center, layout.playButtonBounds)) {
      await primeMidiAudio();
      return {
        element: togglePlayState(normalized),
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

        const openLayout = layout.lanes[openLaneIndex];
        if (!pointInBounds(center, openLayout.instrumentBounds)) {
          return {
            element: {
              ...normalized,
              openInstrumentLaneId: null,
            },
            consumed: false,
            strokesConsumed: [],
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

  const targets = getTargetCells(normalized, strokes);
  if (targets.length === 0) {
    return { element, consumed: false, strokesConsumed: [] };
  }

  const lanes = normalized.lanes.map((lane) => ({
    ...lane,
    activeSteps: [...lane.activeSteps],
  }));

  for (const target of targets) {
    const stepBounds = getMidiStepBounds(normalized, target.laneIndex, target.stepIndex);
    const overlappingStrokes = strokes.filter((stroke) => {
      const strokeBounds = getStrokeBounds(stroke);
      return strokeBounds ? boundingBoxesOverlap(stepBounds, strokeBounds) : false;
    });

    const hasTap = overlappingStrokes.some((stroke) => {
      if (!isTapStroke(stroke)) return false;
      const center = getStrokeCenter(stroke);
      return center ? pointInBounds(center, stepBounds) : false;
    });

    if (hasTap) {
      lanes[target.laneIndex].activeSteps[target.stepIndex] =
        !lanes[target.laneIndex].activeSteps[target.stepIndex];
      continue;
    }

    const coverageRatio = getCoverageRatio(overlappingStrokes, stepBounds);
    lanes[target.laneIndex].activeSteps[target.stepIndex] = coverageRatio >= 0.5;
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
