const MIDI_FONT_FAMILY = 'Caveat';
const MIDI_FONT_TEST_TEXT = 'BESbpq0123456789';

let midiFontReady = typeof document === 'undefined';
let midiFontReadyPromise: Promise<void> | null = null;

function hasFontLoadingApi(): boolean {
  return typeof document !== 'undefined' && typeof document.fonts !== 'undefined';
}

function areMidiFontWeightsReady(): boolean {
  if (!hasFontLoadingApi()) {
    return midiFontReady;
  }

  return (
    document.fonts.check(`400 1em "${MIDI_FONT_FAMILY}"`, MIDI_FONT_TEST_TEXT) &&
    document.fonts.check(`700 1em "${MIDI_FONT_FAMILY}"`, MIDI_FONT_TEST_TEXT)
  );
}

export function isMidiFontReady(): boolean {
  if (midiFontReady) {
    return true;
  }

  if (!hasFontLoadingApi()) {
    midiFontReady = true;
    return true;
  }

  midiFontReady = areMidiFontWeightsReady();
  return midiFontReady;
}

export function ensureMidiFontReady(): Promise<void> {
  if (isMidiFontReady()) {
    return Promise.resolve();
  }

  if (midiFontReadyPromise) {
    return midiFontReadyPromise;
  }

  midiFontReadyPromise = Promise.all([
    document.fonts.load(`400 1em "${MIDI_FONT_FAMILY}"`, MIDI_FONT_TEST_TEXT),
    document.fonts.load(`700 1em "${MIDI_FONT_FAMILY}"`, MIDI_FONT_TEST_TEXT),
  ])
    .catch(() => undefined)
    .then(() => {
      midiFontReady = areMidiFontWeightsReady();
    })
    .finally(() => {
      midiFontReadyPromise = null;
    });

  return midiFontReadyPromise;
}
