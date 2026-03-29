// FX Knob interaction — handle-based rotation only
//
// The indicator tip handle lets the user rotate the knob to set the effect value.
// Rotation side-effects propagate the new reverb amount to connected MIDI elements
// immediately via setMidiReverb (a runtime cache in the MIDI renderer).

import type { HandleDescriptor, HandleDragPhase } from '../registry/ElementPlugin';
import type { Offset } from '../../types/primitives';
import type { FXKnobElement } from './types';
import { lineAngleToEffectValue } from './types';
import { setMidiReverb } from '../midi/renderer';

const HANDLE_ID_INDICATOR = 'indicator';
const KNOB_ANGLE_MIN = -135;
const KNOB_ANGLE_MAX = 135;

/**
 * Compute the tip position of the indicator line in canvas coords.
 */
function indicatorTipPosition(element: FXKnobElement): Offset {
  const angleRad = element.lineAngle * (Math.PI / 180);
  return {
    x: element.cx + element.radius * Math.sin(angleRad),
    y: element.cy - element.radius * Math.cos(angleRad),
  };
}

export function getHandles(element: FXKnobElement): HandleDescriptor[] {
  return [
    {
      id: HANDLE_ID_INDICATOR,
      position: indicatorTipPosition(element),
      hitRadius: 14,
      cursor: 'grab',
      appearance: {
        shape: 'circle',
        size: 10,
        fillColor: '#0f766e',
        strokeColor: '#ffffff',
        strokeWidth: 2,
        activeFillColor: '#34d399',
      },
    },
  ];
}

export function onHandleDrag(
  element: FXKnobElement,
  handleId: string,
  _phase: HandleDragPhase,
  point: Offset,
): FXKnobElement {
  if (handleId !== HANDLE_ID_INDICATOR) return element;

  const dx = point.x - element.cx;
  const dy = point.y - element.cy;

  // atan2(dx, -dy): 0° = north, clockwise positive
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI);
  angle = Math.max(KNOB_ANGLE_MIN, Math.min(KNOB_ANGLE_MAX, angle));

  const effectValue = lineAngleToEffectValue(angle);

  // Side effect: propagate reverb value to all connected MIDI elements immediately
  for (const midiId of element.connectedMidiIds) {
    setMidiReverb(midiId, effectValue);
  }

  return { ...element, lineAngle: angle, effectValue };
}
