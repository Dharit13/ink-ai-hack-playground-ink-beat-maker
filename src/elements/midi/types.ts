import type { BoundingBox, TransformableElement } from '../../types/primitives';
import { generateId } from '../../types/primitives';

export type MidiInstrument = 'snare';

export interface MidiElement extends TransformableElement {
  type: 'midi';
  width: number;
  height: number;
  steps: number;
  activeSteps: boolean[];
  tempo: number;
  instrument: MidiInstrument;
  isLooping: boolean;
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
    tempo: DEFAULT_MIDI_TEMPO,
    instrument: DEFAULT_MIDI_INSTRUMENT,
    isLooping: false,
  };
}
