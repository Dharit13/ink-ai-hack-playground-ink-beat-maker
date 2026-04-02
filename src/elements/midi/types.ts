import type { BoundingBox, TransformableElement } from '../../types/primitives';
import { generateId } from '../../types/primitives';

export type MidiInstrument =
  | 'kick'
  | 'snare'
  | 'closedHat'
  | 'openHat'
  | 'tom'
  | 'midTom'
  | 'crash'
  | 'clap'
  | 'cowbell';

export type MidiInputMode = 'tap' | 'tick';
export type MidiLaneSubdivision = 'straight' | 'triplet';
export type StepVelocity = 'off' | 'low' | 'normal' | 'high';

export interface MidiLane {
  id: string;
  instrument: MidiInstrument;
  subdivision?: MidiLaneSubdivision;
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
  automationHeight?: number;
  automationHasData?: boolean;
  // Legacy absolute automation bounds kept optional so older saved notes can still load.
  automationTopY?: number;
  automationBottomY?: number;
  automationLeftX?: number;
  automationRightX?: number;
  // Automation curves are stored as lane-relative points so they follow move/resize.
  automationUPaths?: Array<Array<{ x: number; y: number }>>;
  automationCurvePaths?: Array<Array<{ x: number; y: number }>>;
  openInstrumentLaneId?: string | null;
  exportMenuOpen?: boolean;
  selectedExportLoopCount?: number;
  selectedExportApplyAutomation?: boolean;
  // Legacy fields kept optional so older saved notes can still load.
  activeSteps?: boolean[];
  stepVelocities?: StepVelocity[];
  instrument?: MidiInstrument;
}

export const DEFAULT_MIDI_STEPS = 16;
export const DEFAULT_MIDI_TEMPO = 120;
export const MIDI_TEMPO_STEP = 1;
export const MIDI_MIN_TEMPO = 40;
export const MIDI_MAX_TEMPO = 240;
export const MIDI_MIN_WIDTH = 520;
export const MIDI_MIN_HEIGHT = 132;
export const MIDI_AUTOMATION_MIN_HEIGHT = 80;
export const MIDI_LANE_HEIGHT = 56;
export const MIDI_HEADER_HEIGHT = 40;
export const MIDI_ADD_BUTTON_SIZE = 24;
export const MIDI_LANE_GAP = 6;
export const MIDI_BODY_TOP_OFFSET = 12;
export const MIDI_FOOTER_GAP = 8;
export const MIDI_BOTTOM_PADDING = 10;
export const MIDI_EXPORT_MIN_LOOP_COUNT = 1;
export const MIDI_EXPORT_MAX_LOOP_COUNT = 8;
export const MIDI_DEFAULT_LANE_SUBDIVISION: MidiLaneSubdivision = 'straight';
export const MIDI_LANE_SUBDIVISIONS: MidiLaneSubdivision[] = ['straight', 'triplet'];
export const MIDI_LANE_INSTRUMENTS: MidiInstrument[] = [
  'snare',
  'closedHat',
  'kick',
  'openHat',
  'tom',
  'midTom',
  'crash',
  'clap',
  'cowbell',
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
    case 'clap':
      return 'Clap';
    case 'cowbell':
      return 'Cowbell';
  }
}

export function createMidiLane(
  instrument: MidiInstrument = 'snare',
  subdivision: MidiLaneSubdivision = MIDI_DEFAULT_LANE_SUBDIVISION
): MidiLane {
  const steps = getLaneStepCount(subdivision);
  return {
    id: generateId(),
    instrument,
    subdivision,
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

export function clampMidiWidth(width: number): number {
  return Math.max(MIDI_MIN_WIDTH, width);
}

export function getLaneSubdivision(
  lane: (Pick<MidiLane, 'subdivision'> & { meter?: string }) | undefined
): MidiLaneSubdivision {
  if (lane?.subdivision === 'triplet') {
    return 'triplet';
  }

  if (lane?.meter === '3/4' || lane?.meter === '6/8') {
    return 'triplet';
  }

  return MIDI_DEFAULT_LANE_SUBDIVISION;
}

export function getLaneStepCount(
  laneOrSubdivision:
    | (Pick<MidiLane, 'subdivision'> & { meter?: string })
    | MidiLaneSubdivision
): number {
  const subdivision =
    typeof laneOrSubdivision === 'string'
      ? laneOrSubdivision
      : getLaneSubdivision(laneOrSubdivision);
  switch (subdivision) {
    case 'straight':
      return 16;
    case 'triplet':
      return 12;
  }
}

export function getLaneStepsPerBeat(
  laneOrSubdivision:
    | (Pick<MidiLane, 'subdivision'> & { meter?: string })
    | MidiLaneSubdivision
): number {
  const subdivision =
    typeof laneOrSubdivision === 'string'
      ? laneOrSubdivision
      : getLaneSubdivision(laneOrSubdivision);
  switch (subdivision) {
    case 'straight':
      return 4;
    case 'triplet':
      return 3;
  }
}

export function getLaneBeatStepSpan(
  laneOrSubdivision:
    | (Pick<MidiLane, 'subdivision'> & { meter?: string })
    | MidiLaneSubdivision
): number {
  return getLaneStepsPerBeat(laneOrSubdivision);
}

export function getNearestMappedStepIndex(
  sourceIndex: number,
  sourceLength: number,
  targetLength: number
): number {
  if (sourceLength <= 0 || targetLength <= 0) {
    return 0;
  }

  return Math.max(
    0,
    Math.min(
      targetLength - 1,
      Math.round(((sourceIndex + 0.5) / sourceLength) * targetLength - 0.5)
    )
  );
}

export function getMidiHeaderSummary(element: MidiElement): string {
  const normalized = normalizeMidiElement(element);
  const subdivisions = Array.from(
    new Set(normalized.lanes.map((lane) => getLaneSubdivision(lane)))
  );
  if (subdivisions.length === 1) {
    return `${subdivisions[0] === 'straight' ? 'Straight' : 'Triplet'} Grid`;
  }

  return 'Mixed Grid';
}

export function normalizeMidiElement(element: MidiElement): MidiElement {
  if (element.lanes && element.lanes.length > 0) {
    return {
      ...element,
      width: clampMidiWidth(element.width),
      steps: DEFAULT_MIDI_STEPS,
      lanes: element.lanes.map((lane) => {
        const legacyLane = lane as MidiLane & { meter?: string };
        const subdivision = getLaneSubdivision(legacyLane);
        const stepCount = getLaneStepCount(subdivision);

        return {
          ...lane,
          subdivision,
          activeSteps: ensureStepLength(lane.activeSteps, stepCount),
          stepVelocities: ensureVelocityLength(
            lane.stepVelocities,
            lane.activeSteps,
            stepCount
          ),
        };
      }),
      height: getMidiHeightForLaneCount(element.lanes.length),
      inputMode: element.inputMode ?? 'tap',
      automationEnabled: element.automationEnabled ?? false,
      automationHeight: getAutomationHeight(element),
      automationHasData: getAutomationHasData(element),
      stepVolumes: resizeNumberPattern(element.stepVolumes ?? [], DEFAULT_MIDI_STEPS, 1.0),
      openInstrumentLaneId: element.openInstrumentLaneId ?? null,
      exportMenuOpen: element.exportMenuOpen ?? false,
      selectedExportLoopCount: clampExportLoopCount(element.selectedExportLoopCount),
      selectedExportApplyAutomation: element.selectedExportApplyAutomation ?? true,
    };
  }

  const legacyLane = createMidiLane(element.instrument ?? 'snare');
  legacyLane.activeSteps = ensureStepLength(
    element.activeSteps ?? [],
    getLaneStepCount(legacyLane)
  );
  legacyLane.stepVelocities = ensureVelocityLength(
    element.stepVelocities ?? [],
    legacyLane.activeSteps,
    getLaneStepCount(legacyLane)
  );

  return {
    ...element,
    width: clampMidiWidth(element.width),
    steps: DEFAULT_MIDI_STEPS,
    lanes: [legacyLane],
    height: getMidiHeightForLaneCount(1),
    inputMode: element.inputMode ?? 'tap',
    automationEnabled: element.automationEnabled ?? false,
    automationHeight: getAutomationHeight(element),
    automationHasData: getAutomationHasData(element),
    stepVolumes: resizeNumberPattern(element.stepVolumes ?? [], DEFAULT_MIDI_STEPS, 1.0),
    openInstrumentLaneId: null,
    exportMenuOpen: false,
    selectedExportLoopCount: MIDI_EXPORT_MIN_LOOP_COUNT,
    selectedExportApplyAutomation: true,
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

function resizeNumberPattern(values: number[], targetLength: number, fallback: number): number[] {
  if (values.length === 0) {
    return ensureVolumeLength([], targetLength);
  }

  if (values.length === targetLength) {
    return ensureVolumeLength(values, targetLength);
  }

  return Array.from({ length: targetLength }, (_, index) => {
    const sourceIndex = Math.max(
      0,
      Math.min(values.length - 1, Math.round(((index + 0.5) / targetLength) * values.length - 0.5))
    );
    return values[sourceIndex] ?? fallback;
  });
}

export function clampExportLoopCount(loopCount: number | undefined): number {
  if (typeof loopCount !== 'number' || !Number.isFinite(loopCount)) {
    return MIDI_EXPORT_MIN_LOOP_COUNT;
  }

  return Math.max(
    MIDI_EXPORT_MIN_LOOP_COUNT,
    Math.min(MIDI_EXPORT_MAX_LOOP_COUNT, Math.round(loopCount))
  );
}

function getAutomationHeight(element: MidiElement): number | undefined {
  if (!(element.automationEnabled ?? false)) return undefined;

  if (typeof element.automationHeight === 'number') {
    return Math.max(MIDI_AUTOMATION_MIN_HEIGHT, element.automationHeight);
  }

  if (
    typeof element.automationTopY === 'number' &&
    typeof element.automationBottomY === 'number'
  ) {
    return Math.max(MIDI_AUTOMATION_MIN_HEIGHT, element.automationBottomY - element.automationTopY);
  }

  return MIDI_AUTOMATION_MIN_HEIGHT;
}

function getAutomationHasData(element: MidiElement): boolean {
  if (typeof element.automationHasData === 'boolean') {
    return element.automationHasData;
  }

  if ((element.automationCurvePaths?.length ?? 0) > 0 || (element.automationUPaths?.length ?? 0) > 0) {
    return true;
  }

  return (element.stepVolumes ?? []).some((volume) => volume !== 1.0);
}

export function createMidiElement(bounds: BoundingBox): MidiElement {
  const laneCount = 1;
  const width = clampMidiWidth(bounds.right - bounds.left);
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
    lanes: [createMidiLane('snare')],
    tempo: DEFAULT_MIDI_TEMPO,
    isLooping: false,
    inputMode: 'tap',
    automationEnabled: false,
    stepVolumes: Array.from({ length: DEFAULT_MIDI_STEPS }, () => 1.0),
    openInstrumentLaneId: null,
    exportMenuOpen: false,
    selectedExportLoopCount: MIDI_EXPORT_MIN_LOOP_COUNT,
    selectedExportApplyAutomation: true,
  };
}
