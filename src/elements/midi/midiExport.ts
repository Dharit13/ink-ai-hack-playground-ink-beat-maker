import type { MidiElement, StepVelocity } from './types';

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
const SNARE_NOTE = 38; // Acoustic Snare

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

function buildTrackEvents(element: MidiElement): number[] {
  const events: number[] = [];

  // Set tempo event: FF 51 03 tt tt tt
  const microsecondsPerBeat = Math.round(60_000_000 / element.tempo);
  events.push(
    ...writeVarLen(0), // delta time 0
    0xff, 0x51, 0x03,
    ...writeUint32BE(microsecondsPerBeat).slice(1), // 3 bytes
  );

  const mode = element.inputMode ?? 'tap';
  const velocities = (element.stepVelocities ?? Array(element.steps).fill('off')) as StepVelocity[];
  const note = SNARE_NOTE;
  const noteOnStatus = 0x90 | PERCUSSION_CHANNEL;
  const noteOffStatus = 0x80 | PERCUSSION_CHANNEL;

  let currentTick = 0;

  for (let stepIndex = 0; stepIndex < element.steps; stepIndex++) {
    const stepStartTick = stepIndex * TICKS_PER_STEP;

    let velocityValue = 0;
    if (mode === 'tick') {
      velocityValue = VELOCITY_VALUE[velocities[stepIndex]];
    } else {
      if (element.activeSteps[stepIndex]) {
        const vel = velocities[stepIndex] !== 'off' ? velocities[stepIndex] : 'normal';
        velocityValue = VELOCITY_VALUE[vel];
      }
    }

    // Scale by automation volume if enabled
    if (velocityValue > 0 && element.automationEnabled) {
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

function buildMidiFile(element: MidiElement): Uint8Array {
  const trackEvents = buildTrackEvents(element);
  const trackLength = trackEvents.length;

  const header = [
    // MThd
    0x4d, 0x54, 0x68, 0x64,
    ...writeUint32BE(6),       // chunk length = 6
    ...writeUint16BE(0),       // format 0 (single track)
    ...writeUint16BE(1),       // 1 track
    ...writeUint16BE(TICKS_PER_QUARTER),
  ];

  const trackChunk = [
    // MTrk
    0x4d, 0x54, 0x72, 0x6b,
    ...writeUint32BE(trackLength),
    ...trackEvents,
  ];

  return new Uint8Array([...header, ...trackChunk]);
}

export function exportMidiFile(element: MidiElement): void {
  const bytes = buildMidiFile(element);
  const blob = new Blob([bytes], { type: 'audio/midi' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `beat-${element.id.slice(0, 8)}.mid`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
