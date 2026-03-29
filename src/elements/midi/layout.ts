import type { BoundingBox } from '../../types';
import type { MidiElement } from './types';

export interface MidiLayout {
  bounds: BoundingBox;
  playButtonBounds: BoundingBox;
  laneBounds: BoundingBox;
  headerHeight: number;
  stepWidth: number;
  stepHeight: number;
}

const OUTER_PADDING = 10;
const HEADER_HEIGHT = 24;
const PLAY_BUTTON_SIZE = 22;
const CONTROL_GAP = 10;
const BOTTOM_PADDING = 10;

export function getMidiBounds(element: MidiElement): BoundingBox {
  const tx = element.transform.values[6];
  const ty = element.transform.values[7];

  return {
    left: tx,
    top: ty,
    right: tx + element.width,
    bottom: ty + element.height,
  };
}

export function getMidiLayout(element: MidiElement): MidiLayout {
  const bounds = getMidiBounds(element);
  const headerHeight = Math.min(HEADER_HEIGHT, Math.max(18, element.height * 0.35));
  const playButtonSize = Math.min(PLAY_BUTTON_SIZE, headerHeight);

  const playButtonBounds: BoundingBox = {
    left: bounds.left + OUTER_PADDING,
    top: bounds.top + (headerHeight - playButtonSize) / 2 + 5,
    right: bounds.left + OUTER_PADDING + playButtonSize,
    bottom: bounds.top + (headerHeight - playButtonSize) / 2 + 5 + playButtonSize,
  };

  const bodyTop = bounds.top + headerHeight + 8;
  const laneBounds: BoundingBox = {
    left: playButtonBounds.right + CONTROL_GAP,
    top: bodyTop,
    right: bounds.right - OUTER_PADDING,
    bottom: bounds.bottom - BOTTOM_PADDING,
  };

  return {
    bounds,
    playButtonBounds,
    laneBounds,
    headerHeight,
    stepWidth: (laneBounds.right - laneBounds.left) / element.steps,
    stepHeight: laneBounds.bottom - laneBounds.top,
  };
}

export function getMidiStepBounds(element: MidiElement, stepIndex: number): BoundingBox {
  const layout = getMidiLayout(element);
  return {
    left: layout.laneBounds.left + stepIndex * layout.stepWidth,
    top: layout.laneBounds.top,
    right: layout.laneBounds.left + (stepIndex + 1) * layout.stepWidth,
    bottom: layout.laneBounds.bottom,
  };
}
