import type { BoundingBox, TransformableElement } from '../../types/primitives';
import { generateId } from '../../types/primitives';

export type MidiInstrument =
  | 'kick'
  | 'snare'
  | 'closedHat'
  | 'openHat'
  | 'tom'
  | 'midTom'
  | 'crash';

export interface MidiLane {
  id: string;
  instrument: MidiInstrument;
  activeSteps: boolean[];
}

export interface MidiElement extends TransformableElement {
  type: 'midi';
  width: number;
  height: number;
  steps: number;
  lanes: MidiLane[];
  tempo: number;
  isLooping: boolean;
  openInstrumentLaneId?: string | null;
  activeSteps?: boolean[];
  instrument?: MidiInstrument;
}

export const DEFAULT_MIDI_STEPS = 16;
export const DEFAULT_MIDI_TEMPO = 120;
export const MIDI_MIN_WIDTH = 520;
export const MIDI_MIN_HEIGHT = 108;
export const MIDI_LANE_HEIGHT = 56;
export const MIDI_HEADER_HEIGHT = 24;
export const MIDI_ADD_BUTTON_SIZE = 24;
export const MIDI_LANE_INSTRUMENTS: MidiInstrument[] = [
  'snare',
  'closedHat',
  'kick',
  'openHat',
  'tom',
  'midTom',
  'crash',
];

export function getInstrumentLabel(instrument: MidiInstrument): string {
  switch (instrument) {
    case 'kick':
      return 'Kick';
    case 'snare':
      return 'Snare';
    case 'closedHat':
      return 'Closed Hat';
    case 'openHat':
      return 'Open Hat';
    case 'tom':
      return 'Tom';
    case 'midTom':
      return 'Mid Tom';
    case 'crash':
      return 'Crash';
  }
}

export function createMidiLane(
  steps = DEFAULT_MIDI_STEPS,
  instrument: MidiInstrument = 'snare'
): MidiLane {
  return {
    id: generateId(),
    instrument,
    activeSteps: Array.from({ length: steps }, () => false),
  };
}

export function getMidiHeightForLaneCount(laneCount: number): number {
  return MIDI_HEADER_HEIGHT + laneCount * MIDI_LANE_HEIGHT + MIDI_ADD_BUTTON_SIZE + 24;
}

export function normalizeMidiElement(element: MidiElement): MidiElement {
  if (element.lanes && element.lanes.length > 0) {
    return {
      ...element,
      lanes: element.lanes.map((lane) => ({
        ...lane,
        activeSteps: ensureStepLength(lane.activeSteps, element.steps),
      })),
      height: getMidiHeightForLaneCount(element.lanes.length),
      openInstrumentLaneId: element.openInstrumentLaneId ?? null,
    };
  }

  const legacyLane = createMidiLane(
    element.steps,
    element.instrument ?? 'snare'
  );
  legacyLane.activeSteps = ensureStepLength(element.activeSteps ?? [], element.steps);

  return {
    ...element,
    lanes: [legacyLane],
    height: getMidiHeightForLaneCount(1),
    openInstrumentLaneId: null,
  };
}

function ensureStepLength(activeSteps: boolean[], steps: number): boolean[] {
  return Array.from({ length: steps }, (_, index) => Boolean(activeSteps[index]));
}

export function createMidiElement(bounds: BoundingBox): MidiElement {
  const laneCount = 1;
  const width = Math.max(MIDI_MIN_WIDTH, bounds.right - bounds.left);
  const height = Math.max(MIDI_MIN_HEIGHT, getMidiHeightForLaneCount(laneCount));

  return {
    type: 'midi',
    id: generateId(),
    transform: {
      values: [1, 0, 0, 0, 1, 0, bounds.left, bounds.top, 1],
    },
    width,
    height,
    steps: DEFAULT_MIDI_STEPS,
    lanes: [createMidiLane(DEFAULT_MIDI_STEPS, 'snare')],
    tempo: DEFAULT_MIDI_TEMPO,
    isLooping: false,
    openInstrumentLaneId: null,
  };
}
