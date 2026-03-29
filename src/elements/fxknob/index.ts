import type { FXKnobElement } from './types';
import type { ElementPlugin } from '../registry/ElementPlugin';
import { registerPlugin } from '../registry/ElementRegistry';
import { canCreate, createFromInk } from './creator';
import { getHandles, onHandleDrag } from './interaction';
import { render, getBounds } from './renderer';

const fxKnobPlugin: ElementPlugin<FXKnobElement> = {
  elementType: 'fxknob',
  name: 'FX Knob',

  canCreate,
  createFromInk,

  getHandles,
  onHandleDrag,

  render,
  getBounds,
};

registerPlugin(fxKnobPlugin);

export { fxKnobPlugin };
