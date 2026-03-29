import type { BoundingBox } from '../../types';
import type { MidiElement } from './types';

export interface MidiLayout {
  bounds: BoundingBox;
  playButtonBounds: BoundingBox;
  toggleModeBounds: BoundingBox;
  laneBounds: BoundingBox;
  headerHeight: number;
  stepWidth: number;
  stepHeight: number;
  automationLaneBounds?: BoundingBox;
}

const OUTER_PADDING = 10;
const TOP_PADDING = 8;
const HEADER_HEIGHT = 30;
const PLAY_BUTTON_SIZE = 28;
const CONTROL_GAP = 12;
const BODY_GAP = 8;
const BOTTOM_PADDING = 8;
const TOGGLE_BUTTON_WIDTH = 60;

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
  const headerHeight = Math.min(HEADER_HEIGHT, Math.max(28, element.height * 0.34));
  const playButtonSize = Math.min(PLAY_BUTTON_SIZE, headerHeight);

  const playButtonBounds: BoundingBox = {
    left: bounds.left + OUTER_PADDING,
    top: bounds.top + TOP_PADDING + (headerHeight - playButtonSize) / 2,
    right: bounds.left + OUTER_PADDING + playButtonSize,
    bottom: bounds.top + TOP_PADDING + (headerHeight - playButtonSize) / 2 + playButtonSize,
  };

  const toggleModeBounds: BoundingBox = {
    left: playButtonBounds.right + CONTROL_GAP,
    top: playButtonBounds.top,
    right: playButtonBounds.right + CONTROL_GAP + TOGGLE_BUTTON_WIDTH,
    bottom: playButtonBounds.bottom,
  };

  const bodyTop = bounds.top + TOP_PADDING + headerHeight + BODY_GAP;
  const laneBounds: BoundingBox = {
    left: bounds.left + OUTER_PADDING,
    top: bodyTop,
    right: bounds.right - OUTER_PADDING,
    bottom: bounds.bottom - BOTTOM_PADDING,
  };

  const automationLaneBounds: BoundingBox | undefined =
    element.automationEnabled &&
    element.automationTopY !== undefined &&
    element.automationBottomY !== undefined &&
    element.automationLeftX !== undefined &&
    element.automationRightX !== undefined
      ? {
          left: element.automationLeftX,
          top: element.automationTopY,
          right: element.automationRightX,
          bottom: element.automationBottomY,
        }
      : undefined;

  return {
    bounds,
    playButtonBounds,
    toggleModeBounds,
    laneBounds,
    headerHeight,
    stepWidth: (laneBounds.right - laneBounds.left) / element.steps,
    stepHeight: laneBounds.bottom - laneBounds.top,
    automationLaneBounds,
  };
}

const AUTOMATION_ZONE_REACH = 200;

export function getAutomationZoneBounds(element: MidiElement): BoundingBox {
  const bounds = getMidiBounds(element);
  return {
    left: bounds.left,
    top: bounds.bottom,
    right: bounds.right,
    bottom: bounds.bottom + AUTOMATION_ZONE_REACH,
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
