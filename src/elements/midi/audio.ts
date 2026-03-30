import type { MidiElement, MidiInstrument, MidiLane, StepVelocity } from './types';
import { normalizeMidiElement } from './types';

type MidiAudioContext = AudioContext | OfflineAudioContext;

const MASTER_OUTPUT_GAIN = 1.9;

const VELOCITY_GAIN: Record<StepVelocity, number> = {
  off: 0,
  low: 0.12,
  normal: 0.24,
  high: 0.4,
};

const noiseBuffers = new WeakMap<MidiAudioContext, AudioBuffer>();

function getNoiseBuffer(context: MidiAudioContext): AudioBuffer {
  const cached = noiseBuffers.get(context);
  if (cached) return cached;

  const bufferSize = context.sampleRate;
  const buffer = context.createBuffer(1, bufferSize, context.sampleRate);
  const channelData = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    channelData[i] = Math.random() * 2 - 1;
  }
  noiseBuffers.set(context, buffer);
  return buffer;
}

export function createMidiOutputNode(context: MidiAudioContext): GainNode {
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.setValueAtTime(-18, 0);
  compressor.knee.setValueAtTime(12, 0);
  compressor.ratio.setValueAtTime(3, 0);
  compressor.attack.setValueAtTime(0.003, 0);
  compressor.release.setValueAtTime(0.12, 0);

  const masterGain = context.createGain();
  masterGain.gain.setValueAtTime(MASTER_OUTPUT_GAIN, 0);
  masterGain.connect(compressor);
  compressor.connect(context.destination);

  return masterGain;
}

function getInstrumentSoundProfile(instrument: MidiInstrument): {
  frequency: number;
  endFrequency: number;
  filterFrequency: number;
  duration: number;
  type: OscillatorType;
} {
  switch (instrument) {
    case 'kick':
      return { frequency: 120, endFrequency: 48, filterFrequency: 240, duration: 0.18, type: 'sine' };
    case 'snare':
      return { frequency: 220, endFrequency: 130, filterFrequency: 1800, duration: 0.12, type: 'triangle' };
    case 'closedHat':
      return { frequency: 520, endFrequency: 440, filterFrequency: 5000, duration: 0.05, type: 'square' };
    case 'openHat':
      return { frequency: 540, endFrequency: 420, filterFrequency: 4200, duration: 0.12, type: 'square' };
    case 'tom':
      return { frequency: 170, endFrequency: 98, filterFrequency: 700, duration: 0.16, type: 'triangle' };
    case 'midTom':
      return { frequency: 145, endFrequency: 85, filterFrequency: 600, duration: 0.16, type: 'triangle' };
    case 'crash':
      return { frequency: 460, endFrequency: 330, filterFrequency: 3200, duration: 0.2, type: 'sawtooth' };
  }
}

function playNoiseInstrument(
  context: MidiAudioContext,
  outputNode: AudioNode,
  instrument: MidiInstrument,
  effectiveGain: number,
  when: number
): void {
  const noise = context.createBufferSource();
  noise.buffer = getNoiseBuffer(context);

  const noiseFilter = context.createBiquadFilter();
  const noiseGain = context.createGain();

  noiseFilter.type = instrument === 'snare' ? 'highpass' : 'bandpass';

  switch (instrument) {
    case 'snare':
      noiseFilter.frequency.setValueAtTime(1800, when);
      noiseGain.gain.setValueAtTime(0.0001, when);
      noiseGain.gain.exponentialRampToValueAtTime(0.6 * effectiveGain, when + 0.003);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.16);
      break;
    case 'closedHat':
      noiseFilter.frequency.setValueAtTime(7000, when);
      noiseFilter.Q.setValueAtTime(2.5, when);
      noiseGain.gain.setValueAtTime(0.0001, when);
      noiseGain.gain.exponentialRampToValueAtTime(0.34 * effectiveGain, when + 0.002);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
      break;
    case 'openHat':
      noiseFilter.frequency.setValueAtTime(5200, when);
      noiseFilter.Q.setValueAtTime(1.6, when);
      noiseGain.gain.setValueAtTime(0.0001, when);
      noiseGain.gain.exponentialRampToValueAtTime(0.28 * effectiveGain, when + 0.002);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.14);
      break;
    case 'crash':
      noiseFilter.frequency.setValueAtTime(3600, when);
      noiseFilter.Q.setValueAtTime(1.1, when);
      noiseGain.gain.setValueAtTime(0.0001, when);
      noiseGain.gain.exponentialRampToValueAtTime(0.32 * effectiveGain, when + 0.003);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.28);
      break;
    default:
      return;
  }

  noise.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(outputNode);
  noise.start(when);
  noise.stop(when + 0.3);

  if (instrument === 'snare') {
    const snapOsc = context.createOscillator();
    const snapGain = context.createGain();
    snapOsc.type = 'triangle';
    snapOsc.frequency.setValueAtTime(180, when);
    snapOsc.frequency.exponentialRampToValueAtTime(90, when + 0.08);
    snapGain.gain.setValueAtTime(0.0001, when);
    snapGain.gain.exponentialRampToValueAtTime(0.22 * effectiveGain, when + 0.002);
    snapGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.09);
    snapOsc.connect(snapGain);
    snapGain.connect(outputNode);
    snapOsc.start(when);
    snapOsc.stop(when + 0.1);
  }
}

export function scheduleLaneSoundAtTime(
  context: MidiAudioContext,
  outputNode: AudioNode,
  instrument: MidiInstrument,
  velocity: StepVelocity,
  when: number,
  volume = 1
): void {
  const velocityGain = VELOCITY_GAIN[velocity];
  if (velocityGain <= 0) return;
  const effectiveGain = velocityGain * volume;

  if (
    instrument === 'snare' ||
    instrument === 'closedHat' ||
    instrument === 'openHat' ||
    instrument === 'crash'
  ) {
    playNoiseInstrument(context, outputNode, instrument, effectiveGain, when);
    return;
  }

  const profile = getInstrumentSoundProfile(instrument);
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  const filter = context.createBiquadFilter();

  oscillator.type = profile.type;
  oscillator.frequency.setValueAtTime(profile.frequency, when);
  oscillator.frequency.exponentialRampToValueAtTime(
    profile.endFrequency,
    when + profile.duration * 0.75
  );

  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(profile.filterFrequency, when);
  filter.Q.setValueAtTime(0.8, when);

  gainNode.gain.setValueAtTime(0.0001, when);
  gainNode.gain.exponentialRampToValueAtTime(effectiveGain, when + 0.005);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, when + profile.duration);

  oscillator.connect(filter);
  filter.connect(gainNode);
  gainNode.connect(outputNode);

  oscillator.start(when);
  oscillator.stop(when + profile.duration + 0.02);
}

export function getStepDurationSeconds(element: MidiElement): number {
  return 60 / normalizeMidiElement(element).tempo / 4;
}

export function getPatternDurationSeconds(element: MidiElement): number {
  const normalized = normalizeMidiElement(element);
  return getStepDurationSeconds(normalized) * normalized.steps;
}

export function getStepVelocity(
  element: MidiElement,
  lane: MidiLane,
  stepIndex: number
): StepVelocity {
  const normalized = normalizeMidiElement(element);
  if (normalized.inputMode === 'tick') {
    return lane.stepVelocities[stepIndex];
  }

  if (!lane.activeSteps[stepIndex]) {
    return 'off';
  }

  return lane.stepVelocities[stepIndex] === 'off'
    ? 'normal'
    : lane.stepVelocities[stepIndex];
}

export function getStepVolume(element: MidiElement, stepIndex: number): number {
  const normalized = normalizeMidiElement(element);
  return normalized.automationEnabled ? normalized.stepVolumes[stepIndex] ?? 1 : 1;
}

export function scheduleElementPlayback(
  context: MidiAudioContext,
  outputNode: AudioNode,
  element: MidiElement,
  loopCount = 1,
  startTime = 0
): void {
  const normalized = normalizeMidiElement(element);
  const stepDuration = getStepDurationSeconds(normalized);
  const patternDuration = stepDuration * normalized.steps;

  for (let loopIndex = 0; loopIndex < loopCount; loopIndex++) {
    const loopOffset = startTime + loopIndex * patternDuration;
    for (let stepIndex = 0; stepIndex < normalized.steps; stepIndex++) {
      const when = loopOffset + stepIndex * stepDuration;
      const volume = getStepVolume(normalized, stepIndex);
      for (const lane of normalized.lanes) {
        const velocity = getStepVelocity(normalized, lane, stepIndex);
        if (velocity === 'off') continue;
        scheduleLaneSoundAtTime(
          context,
          outputNode,
          lane.instrument,
          velocity,
          when,
          volume
        );
      }
    }
  }
}
