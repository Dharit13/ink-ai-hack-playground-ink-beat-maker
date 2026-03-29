import type { MidiElement } from './types';
import { createMidiElement } from './types';
import type { ElementPlugin } from '../registry/ElementPlugin';
import { registerPlugin } from '../registry/ElementRegistry';
import { registerPaletteEntry } from '../../palette/PaletteRegistry';
import { MidiIcon } from './icon';
import { render, getBounds } from './renderer';
import { isInterestedIn, acceptInk, getHandles, onHandleDrag } from './interaction';

const midiPlugin: ElementPlugin<MidiElement> = {
  elementType: 'midi',
  name: 'Midi',
  triesEagerInteractions: true,

  isInterestedIn,
  acceptInk,
  getHandles,
  onHandleDrag,
  render,
  getBounds,
};

registerPlugin(midiPlugin);

registerPaletteEntry({
  id: 'midi',
  label: 'Midi',
  Icon: MidiIcon,
  category: 'game',
  onSelect: async (bounds, consumeStrokes) => {
    consumeStrokes();
    return createMidiElement(bounds);
  },
});

export { midiPlugin };
