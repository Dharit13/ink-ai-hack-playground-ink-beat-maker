import type { BoundingBox, Offset, Stroke } from '../../types';
import type { HandleDragPhase, InteractionResult } from '../registry/ElementPlugin';
import type { MidiElement } from './types';
import { getAutomationZoneBounds, getMidiBounds, getMidiLayout, getMidiStepBounds } from './layout';
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
  return (
    boundingBoxesOverlap(getMidiBounds(element), strokeBounds) ||
    boundingBoxesOverlap(getAutomationZoneBounds(element), strokeBounds)
  );
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

export async function acceptInk(
  element: MidiElement,
  strokes: Stroke[]
): Promise<InteractionResult> {
  const layout = getMidiLayout(element);
  const midiMainBounds = getMidiBounds(element);
  const automationZone = getAutomationZoneBounds(element);

  // Check if all strokes are entirely below the main MIDI element (automation creation gesture)
  const allStrokesBelow = strokes.every((stroke) => {
    const bounds = getStrokeBounds(stroke);
    return bounds ? bounds.top >= midiMainBounds.bottom : false;
  });

  if (allStrokesBelow) {
    // Strokes in automation lane (already enabled) → update volumes
    if (element.automationEnabled && layout.automationLaneBounds) {
      const strokesInLane = strokes.filter((stroke) => {
        const bounds = getStrokeBounds(stroke);
        return bounds ? boundingBoxesOverlap(layout.automationLaneBounds!, bounds) : false;
      });

      if (strokesInLane.length > 0) {
        // Reset to flat 1.0 then apply new strokes — only one curve at a time
        const cleared = { ...element, stepVolumes: Array.from({ length: element.steps }, () => 1.0) };
        const updatedVolumes = getStepVolumesFromStrokes(cleared, strokesInLane, layout.automationLaneBounds);
        // Store the actual stroke paths so the user's handwriting is rendered, not computer geometry
        const curvePaths = strokesInLane.map(s => s.inputs.inputs.map(p => ({ x: p.x, y: p.y })));
        return {
          element: { ...element, stepVolumes: updatedVolumes, automationCurvePaths: curvePaths },
          consumed: true,
          strokesConsumed: strokesInLane,
        };
      }
    }

    // Any strokes in the automation zone → enable automation lane
    // Use the bounding box of those strokes as the automation lane bounds
    const strokesInZone = strokes.filter((stroke) => {
      const bounds = getStrokeBounds(stroke);
      return bounds ? boundingBoxesOverlap(automationZone, bounds) : false;
    });

    if (strokesInZone.length > 0) {
      // Compute the height the user intended from the raw stroke bounds
      let strokeTop = Infinity, strokeBottom = -Infinity;
      for (const stroke of strokesInZone) {
        const b = getStrokeBounds(stroke);
        if (!b) continue;
        strokeTop = Math.min(strokeTop, b.top);
        strokeBottom = Math.max(strokeBottom, b.bottom);
      }
      const drawnHeight = strokeBottom - strokeTop;

      // Snap left/right to the MIDI lane edges, and top to the MIDI element's bottom
      // so the box aligns cleanly with the sequencer above it.
      // Height is preserved from what the user drew.
      const snappedTop = midiMainBounds.bottom;
      return {
        element: {
          ...element,
          automationEnabled: true,
          stepVolumes: Array.from({ length: element.steps }, () => 1.0),
          automationTopY: snappedTop,
          automationBottomY: snappedTop + drawnHeight,
          automationLeftX: layout.laneBounds.left,
          automationRightX: layout.laneBounds.right,
          automationUPaths: undefined,
          automationCurvePaths: undefined,
        },
        consumed: true,
        strokesConsumed: strokesInZone,
      };
    }
  }

  if (strokes.length === 1) {
    const center = getStrokeCenter(strokes[0]);
    if (center && pointInBounds(center, layout.playButtonBounds)) {
      await primeMidiAudio();
      return {
        element: togglePlayState(element),
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

    const hasTap = overlappingStrokes.some((stroke) => {
      if (!isTapStroke(stroke)) return false;
      const center = getStrokeCenter(stroke);
      return center ? pointInBounds(center, stepBounds) : false;
    });

    if (hasTap) {
      updatedSteps[stepIndex] = !updatedSteps[stepIndex];
      continue;
    }

    const coverageRatio = getCoverageRatio(overlappingStrokes, stepBounds);
    updatedSteps[stepIndex] = coverageRatio >= 0.5;
  }

  return {
    element: {
      ...element,
      activeSteps: updatedSteps,
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
