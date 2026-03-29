import type { BoundingBox, Offset, Stroke } from '../../types';
import type { HandleDragPhase, InteractionResult } from '../registry/ElementPlugin';
import type { MidiElement, MidiInputMode, StepVelocity } from './types';
import { getMidiBounds, getMidiLayout, getMidiStepBounds } from './layout';
import { primeMidiAudio } from './renderer';

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
    width <= TAP_DISTANCE_THRESHOLD &&
    height <= TAP_DISTANCE_THRESHOLD &&
    getStrokePathLength(stroke) <= TAP_DISTANCE_THRESHOLD * 1.5
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

function isHorizontalStroke(stroke: Stroke): boolean {
  const bounds = getStrokeBounds(stroke);
  if (!bounds) return false;
  const w = bounds.right - bounds.left;
  const h = bounds.bottom - bounds.top;
  // Only treat as horizontal if clearly wider than tall (2:1 ratio)
  return w > h * 2;
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

function getTargetStepIndices(element: MidiElement, strokes: Stroke[]): number[] {
  const indices = new Set<number>();

  for (let stepIndex = 0; stepIndex < element.steps; stepIndex++) {
    const stepBounds = getMidiStepBounds(element, stepIndex);
    for (const stroke of strokes) {
      const strokeBounds = getStrokeBounds(stroke);
      if (strokeBounds && boundingBoxesOverlap(stepBounds, strokeBounds)) {
        indices.add(stepIndex);
        break;
      }
    }
  }

  return Array.from(indices).sort((a, b) => a - b);
}

function togglePlayState(element: MidiElement): MidiElement {
  return {
    ...element,
    isLooping: !element.isLooping,
  };
}

export function isInterestedIn(
  element: MidiElement,
  _strokes: Stroke[],
  strokeBounds: BoundingBox
): boolean {
  return boundingBoxesOverlap(getMidiBounds(element), strokeBounds);
}

export async function acceptInk(
  element: MidiElement,
  strokes: Stroke[]
): Promise<InteractionResult> {
  const layout = getMidiLayout(element);
  const mode: MidiInputMode = element.inputMode ?? 'tap';
  const velocities = [...((element.stepVelocities ?? Array(element.steps).fill('off')) as StepVelocity[])];

  if (strokes.length === 1) {
    const center = getStrokeCenter(strokes[0]);

    // Play button
    if (center && pointInBounds(center, layout.playButtonBounds)) {
      await primeMidiAudio();
      return {
        element: togglePlayState(element),
        consumed: true,
        strokesConsumed: strokes,
      };
    }

    // Mode toggle button
    if (center && pointInBounds(center, layout.toggleModeBounds)) {
      const newMode: MidiInputMode = mode === 'tap' ? 'tick' : 'tap';
      let syncedSteps = [...element.activeSteps];
      let syncedVelocities = [...velocities];
      if (newMode === 'tick') {
        // Promote active tap steps to normal velocity if not already set
        syncedVelocities = syncedVelocities.map((v, i) =>
          v === 'off' && element.activeSteps[i] ? 'normal' : v
        );
      } else {
        // Mark any non-off velocity step as active
        syncedSteps = syncedVelocities.map((v) => v !== 'off');
      }
      return {
        element: { ...element, inputMode: newMode, activeSteps: syncedSteps, stepVelocities: syncedVelocities },
        consumed: true,
        strokesConsumed: strokes,
      };
    }
  }

  const targetStepIndices = getTargetStepIndices(element, strokes);
  if (targetStepIndices.length === 0) {
    return { element, consumed: false, strokesConsumed: [] };
  }

  const updatedSteps = [...element.activeSteps];

  for (const stepIndex of targetStepIndices) {
    const stepBounds = getMidiStepBounds(element, stepIndex);
    const overlappingStrokes = strokes.filter((stroke) => {
      const strokeBounds = getStrokeBounds(stroke);
      return strokeBounds ? boundingBoxesOverlap(stepBounds, strokeBounds) : false;
    });

    if (mode === 'tick') {
      // Horizontal stroke across step = erase
      if (overlappingStrokes.some(isHorizontalStroke)) {
        velocities[stepIndex] = 'off';
        continue;
      }

      const hasTap = overlappingStrokes.some((stroke) => {
        if (!isTapStroke(stroke)) return false;
        const center = getStrokeCenter(stroke);
        return center ? pointInBounds(center, stepBounds) : false;
      });

      if (hasTap) {
        velocities[stepIndex] = cycleVelocity(velocities[stepIndex]);
      } else {
        // Use tallest overlapping stroke to determine velocity (redraw = reset)
        let maxRatio = 0;
        for (const stroke of overlappingStrokes) {
          const ratio = getStrokeHeightRatio(stroke, stepBounds);
          if (ratio > maxRatio) maxRatio = ratio;
        }
        if (maxRatio > 0) {
          velocities[stepIndex] = velocityFromHeightRatio(maxRatio);
        }
      }
    } else {
      // Tap mode
      const hasTap = overlappingStrokes.some((stroke) => {
        if (!isTapStroke(stroke)) return false;
        const center = getStrokeCenter(stroke);
        return center ? pointInBounds(center, stepBounds) : false;
      });

      if (hasTap) {
        const willBeActive = !updatedSteps[stepIndex];
        updatedSteps[stepIndex] = willBeActive;
        if (willBeActive && velocities[stepIndex] === 'off') {
          velocities[stepIndex] = 'normal';
        }
        continue;
      }

      // Drag on a step (non-tap, non-horizontal) = set velocity by height
      const verticalStrokes = overlappingStrokes.filter(
        (stroke) => !isTapStroke(stroke)
      );
      if (verticalStrokes.length > 0) {
        let maxRatio = 0;
        for (const stroke of verticalStrokes) {
          const ratio = getStrokeHeightRatio(stroke, stepBounds);
          if (ratio > maxRatio) maxRatio = ratio;
        }
        if (maxRatio > 0) {
          updatedSteps[stepIndex] = true;
          velocities[stepIndex] = velocityFromHeightRatio(maxRatio);
          continue;
        }
      }

      const coverageRatio = getCoverageRatio(overlappingStrokes, stepBounds);
      updatedSteps[stepIndex] = coverageRatio >= 0.5;
    }
  }

  return {
    element: {
      ...element,
      activeSteps: updatedSteps,
      stepVelocities: velocities,
    },
    consumed: true,
    strokesConsumed: strokes,
  };
}

export function getHandles(element: MidiElement) {
  const bounds = getMidiBounds(element);
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
  if (phase === 'start' || handleId !== 'resizeRight') {
    return element;
  }

  const left = element.transform.values[6];
  return {
    ...element,
    width: Math.max(MIN_MIDI_WIDTH, point.x - left),
  };
}
