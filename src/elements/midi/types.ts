import type { BoundingBox, TransformableElement } from '../../types/primitives';
import { generateId } from '../../types/primitives';

export type MidiInstrument = 'snare';
export type MidiInputMode = 'tap' | 'tick';
export type StepVelocity = 'off' | 'low' | 'normal' | 'high';

export interface MidiElement extends TransformableElement {
  type: 'midi';
  width: number;
  height: number;
  steps: number;
  activeSteps: boolean[];
  stepVelocities: StepVelocity[];
  inputMode: MidiInputMode;
  tempo: number;
  instrument: MidiInstrument;
  isLooping: boolean;
  automationEnabled: boolean;
  stepVolumes: number[];
  // Bounds derived from the drawn U stroke
  automationTopY?: number;
  automationBottomY?: number;
  automationLeftX?: number;
  automationRightX?: number;
  // Actual stroke paths stored so the user's handwriting is what gets rendered (not computer geometry)
  automationUPaths?: Array<Array<{x: number; y: number}>>;
  automationCurvePaths?: Array<Array<{x: number; y: number}>>;
}

export const DEFAULT_MIDI_STEPS = 16;
export const DEFAULT_MIDI_TEMPO = 120;
export const DEFAULT_MIDI_INSTRUMENT: MidiInstrument = 'snare';
export const MIDI_MIN_WIDTH = 520;
export const MIDI_MIN_HEIGHT = 72;

export function createMidiElement(bounds: BoundingBox): MidiElement {
  const width = Math.max(MIDI_MIN_WIDTH, bounds.right - bounds.left);
  const height = Math.max(MIDI_MIN_HEIGHT, bounds.bottom - bounds.top);

  return {
    type: 'midi',
    id: generateId(),
    transform: {
      values: [1, 0, 0, 0, 1, 0, bounds.left, bounds.top, 1],
    },
    width,
    height,
    steps: DEFAULT_MIDI_STEPS,
    activeSteps: Array.from({ length: DEFAULT_MIDI_STEPS }, () => false),
    stepVelocities: Array.from({ length: DEFAULT_MIDI_STEPS }, () => 'off' as StepVelocity),
    inputMode: 'tap' as MidiInputMode,
    tempo: DEFAULT_MIDI_TEMPO,
    instrument: DEFAULT_MIDI_INSTRUMENT,
    isLooping: false,
    automationEnabled: false,
    stepVolumes: Array.from({ length: DEFAULT_MIDI_STEPS }, () => 1.0),
  };
}
