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

export type MidiInputMode = 'tap' | 'tick';
export type StepVelocity = 'off' | 'low' | 'normal' | 'high';

export interface MidiLane {
  id: string;
  instrument: MidiInstrument;
  activeSteps: boolean[];
  stepVelocities: StepVelocity[];
}

export interface MidiElement extends TransformableElement {
  type: 'midi';
  width: number;
  height: number;
  steps: number;
  lanes: MidiLane[];
  tempo: number;
  isLooping: boolean;
  inputMode: MidiInputMode;
  automationEnabled: boolean;
  stepVolumes: number[];
  automationTopY?: number;
  automationBottomY?: number;
  automationLeftX?: number;
  automationRightX?: number;
  automationUPaths?: Array<Array<{ x: number; y: number }>>;
  automationCurvePaths?: Array<Array<{ x: number; y: number }>>;
  openInstrumentLaneId?: string | null;
  // Legacy fields kept optional so older saved notes can still load.
  activeSteps?: boolean[];
  stepVelocities?: StepVelocity[];
  instrument?: MidiInstrument;
}

export const DEFAULT_MIDI_STEPS = 16;
export const DEFAULT_MIDI_TEMPO = 120;
export const MIDI_MIN_WIDTH = 520;
export const MIDI_MIN_HEIGHT = 108;
export const MIDI_LANE_HEIGHT = 56;
export const MIDI_HEADER_HEIGHT = 24;
export const MIDI_ADD_BUTTON_SIZE = 24;
export const MIDI_LANE_GAP = 6;
export const MIDI_BODY_TOP_OFFSET = 12;
export const MIDI_FOOTER_GAP = 8;
export const MIDI_BOTTOM_PADDING = 10;
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
    stepVelocities: Array.from({ length: steps }, () => 'off' as StepVelocity),
  };
}

export function getMidiHeightForLaneCount(laneCount: number): number {
  const laneSectionHeight =
    laneCount * MIDI_LANE_HEIGHT + Math.max(0, laneCount - 1) * MIDI_LANE_GAP;
  return (
    MIDI_HEADER_HEIGHT +
    MIDI_BODY_TOP_OFFSET +
    laneSectionHeight +
    MIDI_FOOTER_GAP +
    MIDI_ADD_BUTTON_SIZE +
    MIDI_BOTTOM_PADDING
  );
}

export function normalizeMidiElement(element: MidiElement): MidiElement {
  if (element.lanes && element.lanes.length > 0) {
    return {
      ...element,
      lanes: element.lanes.map((lane) => ({
        ...lane,
        activeSteps: ensureStepLength(lane.activeSteps, element.steps),
        stepVelocities: ensureVelocityLength(lane.stepVelocities, lane.activeSteps, element.steps),
      })),
      height: getMidiHeightForLaneCount(element.lanes.length),
      inputMode: element.inputMode ?? 'tap',
      automationEnabled: element.automationEnabled ?? false,
      stepVolumes: ensureVolumeLength(element.stepVolumes ?? [], element.steps),
      openInstrumentLaneId: element.openInstrumentLaneId ?? null,
    };
  }

  const legacyLane = createMidiLane(element.steps, element.instrument ?? 'snare');
  legacyLane.activeSteps = ensureStepLength(element.activeSteps ?? [], element.steps);
  legacyLane.stepVelocities = ensureVelocityLength(
    element.stepVelocities ?? [],
    legacyLane.activeSteps,
    element.steps
  );

  return {
    ...element,
    lanes: [legacyLane],
    height: getMidiHeightForLaneCount(1),
    inputMode: element.inputMode ?? 'tap',
    automationEnabled: element.automationEnabled ?? false,
    stepVolumes: ensureVolumeLength(element.stepVolumes ?? [], element.steps),
    openInstrumentLaneId: null,
  };
}

function ensureStepLength(activeSteps: boolean[], steps: number): boolean[] {
  return Array.from({ length: steps }, (_, index) => Boolean(activeSteps[index]));
}

function ensureVelocityLength(
  stepVelocities: StepVelocity[],
  activeSteps: boolean[],
  steps: number
): StepVelocity[] {
  return Array.from({ length: steps }, (_, index) => {
    const velocity = stepVelocities[index];
    if (velocity) return velocity;
    return activeSteps[index] ? 'normal' : 'off';
  });
}

function ensureVolumeLength(stepVolumes: number[], steps: number): number[] {
  return Array.from({ length: steps }, (_, index) => stepVolumes[index] ?? 1.0);
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
    inputMode: 'tap',
    automationEnabled: false,
    stepVolumes: Array.from({ length: DEFAULT_MIDI_STEPS }, () => 1.0),
    openInstrumentLaneId: null,
  };
}
