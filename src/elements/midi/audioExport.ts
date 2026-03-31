import { showToast } from '../../toast/Toast';
import { createMidiOutputNode, getPatternDurationSeconds, scheduleElementPlayback } from './audio';
import { buildDruminkExportBaseName } from './exportFileName';
import type { MidiElement } from './types';
import { clampExportLoopCount, normalizeMidiElement } from './types';

const FALLBACK_SAMPLE_RATE = 44100;
const EXPORT_TAIL_SECONDS = 0.35;

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function encodeWavMono(audioBuffer: AudioBuffer): Blob {
  const channelData = audioBuffer.getChannelData(0);
  const samples = new Int16Array(channelData.length);

  for (let i = 0; i < channelData.length; i++) {
    const clamped = Math.max(-1, Math.min(1, channelData[i]));
    samples[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  const byteRate = audioBuffer.sampleRate * 2;
  const blockAlign = 2;
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, audioBuffer.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const sample of samples) {
    view.setInt16(offset, sample, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export async function exportWavFile(
  element: MidiElement,
  loopCount = 1,
  applyAutomation = true
): Promise<void> {
  if (typeof window === 'undefined' || !window.OfflineAudioContext) {
    showToast('WAV export is not supported in this browser.');
    return;
  }

  const normalized = normalizeMidiElement(element);
  const safeLoopCount = clampExportLoopCount(loopCount);
  const sampleRate = FALLBACK_SAMPLE_RATE;
  const durationSeconds =
    getPatternDurationSeconds(normalized) * safeLoopCount + EXPORT_TAIL_SECONDS;
  const frameCount = Math.ceil(durationSeconds * sampleRate);

  try {
    const context = new window.OfflineAudioContext(1, frameCount, sampleRate);
    const outputNode = createMidiOutputNode(context);
    scheduleElementPlayback(context, outputNode, normalized, safeLoopCount, 0, applyAutomation);

    const rendered = await context.startRendering();
    const wavBlob = encodeWavMono(rendered);
    downloadBlob(wavBlob, `${buildDruminkExportBaseName()}.wav`);
  } catch (error) {
    console.error('WAV export failed', error);
    showToast('WAV export failed.');
  }
}
