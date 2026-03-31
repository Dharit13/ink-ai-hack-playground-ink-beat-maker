import { buildDruminkExportBaseName } from './exportFileName';
import type { MidiElement, MidiInstrument, MidiLane, StepVelocity } from './types';

const TICKS_PER_QUARTER = 480;
const TICKS_PER_STEP = TICKS_PER_QUARTER / 4; // 16th note = 120 ticks

const VELOCITY_VALUE: Record<StepVelocity, number> = {
  off: 0,
  low: 40,
  normal: 80,
  high: 120,
};

// GM percussion channel (0-indexed channel 9)
const PERCUSSION_CHANNEL = 9;

const GM_NOTE: Record<MidiInstrument, number> = {
  kick: 36,       // Bass Drum 1
  snare: 38,      // Acoustic Snare
  clap: 39,       // Hand Clap
  closedHat: 42,  // Closed Hi-Hat
  openHat: 46,    // Open Hi-Hat
  tom: 45,        // Low Tom
  midTom: 47,     // Low-Mid Tom
  crash: 49,      // Crash Cymbal 1
  cowbell: 56,    // Cowbell
};

function writeVarLen(value: number): number[] {
  const bytes: number[] = [];
  bytes.unshift(value & 0x7f);
  value >>= 7;
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80);
    value >>= 7;
  }
  return bytes;
}

function writeUint32BE(value: number): number[] {
  return [
    (value >> 24) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  ];
}

function writeUint16BE(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function buildLaneTrackEvents(
  element: MidiElement,
  lane: MidiLane,
  isFirstTrack: boolean,
  applyAutomation: boolean
): number[] {
  const events: number[] = [];

  if (isFirstTrack) {
    // Set tempo event: FF 51 03 tt tt tt (only in first track for format 1)
    const microsecondsPerBeat = Math.round(60_000_000 / element.tempo);
    events.push(
      ...writeVarLen(0),
      0xff, 0x51, 0x03,
      ...writeUint32BE(microsecondsPerBeat).slice(1),
    );
  }

  const mode = element.inputMode ?? 'tap';
  const note = GM_NOTE[lane.instrument] ?? 38;
  const noteOnStatus = 0x90 | PERCUSSION_CHANNEL;
  const noteOffStatus = 0x80 | PERCUSSION_CHANNEL;

  let currentTick = 0;

  for (let stepIndex = 0; stepIndex < element.steps; stepIndex++) {
    const stepStartTick = stepIndex * TICKS_PER_STEP;

    let velocityValue = 0;
    if (mode === 'tick') {
      velocityValue = VELOCITY_VALUE[lane.stepVelocities[stepIndex]];
    } else {
      if (lane.activeSteps[stepIndex]) {
        const vel = lane.stepVelocities[stepIndex] !== 'off' ? lane.stepVelocities[stepIndex] : 'normal';
        velocityValue = VELOCITY_VALUE[vel];
      }
    }

    // Scale by automation volume if enabled
    if (velocityValue > 0 && applyAutomation && element.automationEnabled) {
      const vol = element.stepVolumes?.[stepIndex] ?? 1.0;
      velocityValue = Math.max(1, Math.round(velocityValue * vol));
    }

    if (velocityValue > 0) {
      const deltaOn = stepStartTick - currentTick;
      events.push(...writeVarLen(deltaOn), noteOnStatus, note, velocityValue);
      currentTick = stepStartTick;

      const noteOffTick = stepStartTick + TICKS_PER_STEP - 10;
      const deltaOff = noteOffTick - currentTick;
      events.push(...writeVarLen(deltaOff), noteOffStatus, note, 0);
      currentTick = noteOffTick;
    }
  }

  // End of track: FF 2F 00
  events.push(...writeVarLen(0), 0xff, 0x2f, 0x00);
  return events;
}

function buildMidiFile(element: MidiElement, applyAutomation = true): Uint8Array {
  const trackChunks: number[][] = element.lanes.map((lane, i) => {
    const events = buildLaneTrackEvents(element, lane, i === 0, applyAutomation);
    return [
      0x4d, 0x54, 0x72, 0x6b, // MTrk
      ...writeUint32BE(events.length),
      ...events,
    ];
  });

  const numTracks = trackChunks.length;
  const header = [
    0x4d, 0x54, 0x68, 0x64,       // MThd
    ...writeUint32BE(6),            // chunk length = 6
    ...writeUint16BE(numTracks > 1 ? 1 : 0), // format 1 if multi-track, 0 if single
    ...writeUint16BE(numTracks),
    ...writeUint16BE(TICKS_PER_QUARTER),
  ];

  return new Uint8Array([...header, ...trackChunks.flat()]);
}

export function exportMidiFile(element: MidiElement, applyAutomation = true): void {
  const bytes = buildMidiFile(element, applyAutomation);
  const blob = new Blob([bytes], { type: 'audio/midi' });
  const url = URL.createObjectURL(blob);
  const fileName = `${buildDruminkExportBaseName()}.mid`;

  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
