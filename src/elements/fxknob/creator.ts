// FX Knob creator
//
// Handles two creation scenarios:
//   A) 2 strokes → new FX knob (circle + short indicator line)
//   B) 1 straight stroke → connection line linking an FX knob snap point to a MIDI snap point

import type { Stroke } from '../../types';
import type { CreationContext, CreationResult } from '../registry/ElementPlugin';
import type { HandwritingRecognitionResult } from '../../recognition/RecognitionService';
import { offsetDistance } from '../../types/primitives';
import type { Offset } from '../../types/primitives';
import { extractFeatures } from '../../geometry/shapeRecognition';
import { createFXKnobElement } from './types';
import type { FXKnobElement } from './types';
import type { MidiElement } from '../midi/types';
import type { Element } from '../../types/elements';
import { debugLog } from '../../debug/DebugLogger';

// ── Scenario A constants ──────────────────────────────────────────────────────
const CIRCLE_COMPACTNESS_MIN = 0.65;
const CIRCLE_CLOSURE_MAX = 0.20;
const CIRCLE_RADIUS_VARIANCE_MAX = 0.35;
const CIRCLE_MIN_RADIUS = 20;
const CIRCLE_MAX_RADIUS = 120;

// Indicator line must be 0.15–1.2× the circle radius
const LINE_MIN_RATIO = 0.15;
const LINE_MAX_RATIO = 1.2;
// Line midpoint must be within this many radii of the circle center
const LINE_MIDPOINT_RADIUS_MULTIPLIER = 1.8;

// ── Scenario B constants ──────────────────────────────────────────────────────
// A connection stroke must be at least this straight (endpoint dist / path len)
const CONNECTION_STRAIGHTNESS_MIN = 0.70;
// Snap proximity: how close an endpoint must be to a snap point (pixels)
const SNAP_RADIUS = 50;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get all points from a stroke as Offset array.
 */
function strokePoints(stroke: Stroke): Offset[] {
  return stroke.inputs.inputs.map(i => ({ x: i.x, y: i.y }));
}

/**
 * Compute the centroid of an array of points.
 */
function centroid(points: Offset[]): Offset {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

/**
 * Compute path length of an ordered set of points.
 */
function pointsPathLength(points: Offset[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += offsetDistance(points[i - 1], points[i]);
  }
  return len;
}

/**
 * Check if a single stroke looks like a roughly straight line.
 * Returns straightness ratio (endpoint dist / path len), or 0 if degenerate.
 */
function straightness(stroke: Stroke): number {
  const pts = strokePoints(stroke);
  if (pts.length < 2) return 0;
  const endpointDist = offsetDistance(pts[0], pts[pts.length - 1]);
  const len = pointsPathLength(pts);
  if (len < 5) return 0;
  return endpointDist / len;
}

/**
 * Compute the angle (degrees) from `from` to `to`.
 * 0° = north (up), clockwise positive.
 */
function angleDegNorth(from: Offset, to: Offset): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return Math.atan2(dx, -dy) * (180 / Math.PI);
}

// ── Scenario A: detect circle + indicator line ────────────────────────────────

/**
 * Try to recognise a circle from a single stroke using feature extraction.
 * Returns { cx, cy, radius } or null.
 */
function detectCircleStroke(stroke: Stroke): { cx: number; cy: number; radius: number } | null {
  const features = extractFeatures([stroke]);
  if (!features) return null;

  if (features.compactness < CIRCLE_COMPACTNESS_MIN) {
    debugLog.info('FXKnob circle: low compactness', { compactness: features.compactness });
    return null;
  }
  if (features.closureGapRatio > CIRCLE_CLOSURE_MAX) {
    debugLog.info('FXKnob circle: not closed', { gapRatio: features.closureGapRatio });
    return null;
  }
  if (features.radiusVariance > CIRCLE_RADIUS_VARIANCE_MAX) {
    debugLog.info('FXKnob circle: radius variance too high', { variance: features.radiusVariance });
    return null;
  }

  const r = features.averageRadius;
  if (r < CIRCLE_MIN_RADIUS || r > CIRCLE_MAX_RADIUS) {
    debugLog.info('FXKnob circle: radius out of range', { r });
    return null;
  }

  return { cx: features.centroid.x, cy: features.centroid.y, radius: r };
}

/**
 * Try to recognise the indicator line stroke given the circle's center and radius.
 * Returns the initial line angle (degrees, north=0) or null.
 */
function detectIndicatorStroke(
  stroke: Stroke,
  circleCx: number,
  circleCy: number,
  circleRadius: number,
): number | null {
  const pts = strokePoints(stroke);
  if (pts.length < 2) return null;

  // Line must not be too long or too short relative to the circle
  const len = pointsPathLength(pts);
  if (len < circleRadius * LINE_MIN_RATIO || len > circleRadius * LINE_MAX_RATIO * 2) {
    debugLog.info('FXKnob indicator: length out of range', { len, circleRadius });
    return null;
  }

  // Midpoint of the stroke must be within LINE_MIDPOINT_RADIUS_MULTIPLIER * radius of center
  const mid = centroid(pts);
  const distToCenter = offsetDistance(mid, { x: circleCx, y: circleCy });
  if (distToCenter > circleRadius * LINE_MIDPOINT_RADIUS_MULTIPLIER) {
    debugLog.info('FXKnob indicator: midpoint too far from circle center', { distToCenter, limit: circleRadius * LINE_MIDPOINT_RADIUS_MULTIPLIER });
    return null;
  }

  // Compute angle from circle center toward the far end of the line
  const start = pts[0];
  const end = pts[pts.length - 1];
  const distStart = offsetDistance({ x: circleCx, y: circleCy }, start);
  const distEnd = offsetDistance({ x: circleCx, y: circleCy }, end);
  // Tip = whichever end is farther from center
  const tip = distEnd > distStart ? end : start;

  const angle = angleDegNorth({ x: circleCx, y: circleCy }, tip);
  debugLog.info('FXKnob indicator: detected', { angle });
  return angle;
}

// ── Scenario B: detect connection line ────────────────────────────────────────

/**
 * Get the snap point of an FX knob in canvas coordinates (right edge of circle).
 */
function fxKnobSnapPoint(knob: FXKnobElement): Offset {
  return { x: knob.cx + knob.radius, y: knob.cy };
}

/**
 * Get the snap point of a MIDI element in canvas coordinates (left edge, vertically centered).
 * Transform values: column-major, values[6]=transX, values[7]=transY.
 */
function midiSnapPoint(midi: MidiElement): Offset {
  return {
    x: midi.transform.values[6],
    y: midi.transform.values[7] + midi.height / 2,
  };
}

/**
 * Try to detect a connection line from an FX knob to a MIDI element.
 * Returns { updatedKnob, updatedMidi } or null.
 */
function detectConnection(
  stroke: Stroke,
  existingElements: Element[],
): { updatedKnob: FXKnobElement; updatedMidi: MidiElement } | null {
  const pts = strokePoints(stroke);
  if (pts.length < 2) return null;

  const strokeStart = pts[0];
  const strokeEnd = pts[pts.length - 1];

  const fxKnobs = existingElements.filter((e): e is FXKnobElement => e.type === 'fxknob');
  const midiElements = existingElements.filter((e): e is MidiElement => e.type === 'midi');

  if (fxKnobs.length === 0 || midiElements.length === 0) return null;

  // Try both orientations of the stroke (start→knob/end→midi or start→midi/end→knob)
  for (const knob of fxKnobs) {
    const knobSnap = fxKnobSnapPoint(knob);

    for (const midi of midiElements) {
      // Skip if already connected
      if (knob.connectedMidiIds.includes(midi.id)) continue;

      const midiSnap = midiSnapPoint(midi);

      const startToKnob = offsetDistance(strokeStart, knobSnap);
      const endToMidi = offsetDistance(strokeEnd, midiSnap);
      const startToMidi = offsetDistance(strokeStart, midiSnap);
      const endToKnob = offsetDistance(strokeEnd, knobSnap);

      const orientation1 = startToKnob <= SNAP_RADIUS && endToMidi <= SNAP_RADIUS;
      const orientation2 = startToMidi <= SNAP_RADIUS && endToKnob <= SNAP_RADIUS;

      if (orientation1 || orientation2) {
        debugLog.info('FXKnob connection: detected', {
          knobId: knob.id,
          midiId: midi.id,
          orientation: orientation1 ? 'knob→midi' : 'midi→knob',
        });
        const updatedKnob: FXKnobElement = {
          ...knob,
          connectedMidiIds: [...knob.connectedMidiIds, midi.id],
        };
        // MIDI element is returned unchanged — reverb is applied via runtime cache
        return { updatedKnob, updatedMidi: { ...midi } };
      }
    }
  }

  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function canCreate(strokes: Stroke[]): boolean {
  // Scenario A: exactly 2 strokes
  if (strokes.length === 2) {
    // Rough check: combined bounding box should be reasonably sized
    const allPoints = strokes.flatMap(strokePoints);
    if (allPoints.length < 4) return false;
    const xs = allPoints.map(p => p.x);
    const ys = allPoints.map(p => p.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    return w >= CIRCLE_MIN_RADIUS * 2 && h >= CIRCLE_MIN_RADIUS * 2;
  }

  // Scenario B: exactly 1 stroke that looks like a straight line
  if (strokes.length === 1) {
    return straightness(strokes[0]) >= CONNECTION_STRAIGHTNESS_MIN;
  }

  return false;
}

export async function createFromInk(
  strokes: Stroke[],
  context: CreationContext,
  _recognitionResult?: HandwritingRecognitionResult,
): Promise<CreationResult | null> {

  // ── Scenario A: knob creation ───────────────────────────────────────────────
  if (strokes.length === 2) {
    debugLog.info('FXKnob createFromInk: trying knob creation (2 strokes)');

    // Try each stroke as the circle and the other as the indicator line
    for (const [circleIdx, lineIdx] of [[0, 1], [1, 0]]) {
      const circleResult = detectCircleStroke(strokes[circleIdx]);
      if (!circleResult) continue;

      const { cx, cy, radius } = circleResult;
      const angle = detectIndicatorStroke(strokes[lineIdx], cx, cy, radius);
      if (angle === null) continue;

      // Clamp to valid knob range
      const clampedAngle = Math.max(-135, Math.min(135, angle));
      const element = createFXKnobElement(cx, cy, radius, clampedAngle);

      debugLog.info('FXKnob: created knob', { cx, cy, radius, angle: clampedAngle });
      return {
        elements: [element],
        consumedStrokes: strokes,
        confidence: 0.88,
      };
    }

    debugLog.info('FXKnob: 2-stroke knob creation failed');
    return null;
  }

  // ── Scenario B: connection line ─────────────────────────────────────────────
  if (strokes.length === 1) {
    const s = strokes[0];
    if (straightness(s) < CONNECTION_STRAIGHTNESS_MIN) return null;

    debugLog.info('FXKnob createFromInk: trying connection detection (1 stroke)');
    const result = detectConnection(s, context.existingElements);
    if (!result) return null;

    const { updatedKnob, updatedMidi } = result;
    return {
      elements: [updatedKnob, updatedMidi],
      consumedStrokes: strokes,
      consumedElementIds: [updatedKnob.id, updatedMidi.id],
      confidence: 0.90,
    };
  }

  return null;
}
