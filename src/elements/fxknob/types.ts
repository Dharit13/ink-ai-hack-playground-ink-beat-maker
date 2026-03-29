import type { TransformableElement } from '../../types/primitives';
import { generateId, IDENTITY_MATRIX } from '../../types/primitives';

export type FXEffectType = 'reverb';

export interface FXKnobElement extends TransformableElement {
  type: 'fxknob';
  cx: number;          // canvas x of circle center
  cy: number;          // canvas y of circle center
  radius: number;      // circle radius in pixels
  // lineAngle: 0 = straight up (north), clockwise positive, clamped to [-135, 135] degrees
  lineAngle: number;
  // effectValue: 0-1 derived from lineAngle: (lineAngle + 135) / 270
  effectValue: number;
  effectType: FXEffectType;
  connectedMidiIds: string[];
}

export function lineAngleToEffectValue(angle: number): number {
  return (angle + 135) / 270;
}

export function effectValueToLineAngle(value: number): number {
  return value * 270 - 135;
}

export function createFXKnobElement(cx: number, cy: number, radius: number, lineAngle = 0): FXKnobElement {
  return {
    type: 'fxknob',
    id: generateId(),
    transform: IDENTITY_MATRIX,
    cx,
    cy,
    radius,
    lineAngle,
    effectValue: lineAngleToEffectValue(lineAngle),
    effectType: 'reverb',
    connectedMidiIds: [],
  };
}
