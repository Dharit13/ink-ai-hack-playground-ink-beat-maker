import type { BoundingBox } from '../../types';
import type { MidiElement } from './types';
import {
  MIDI_ADD_BUTTON_SIZE,
  MIDI_HEADER_HEIGHT,
  MIDI_LANE_HEIGHT,
  normalizeMidiElement,
} from './types';

export interface MidiLaneLayout {
  laneIndex: number;
  instrumentBounds: BoundingBox;
  removeButtonBounds: BoundingBox;
  gridBounds: BoundingBox;
  instrumentMenuBounds: BoundingBox;
  stepWidth: number;
  stepHeight: number;
}

export interface MidiLayout {
  bounds: BoundingBox;
  playButtonBounds: BoundingBox;
  addLaneBounds: BoundingBox;
  lanes: MidiLaneLayout[];
  headerHeight: number;
}

const OUTER_PADDING = 10;
const PLAY_BUTTON_SIZE = 22;
const CONTROL_GAP = 10;
const LANE_GAP = 6;
const LANE_LABEL_WIDTH = 102;
const FOOTER_GAP = 8;
const REMOVE_BUTTON_SIZE = 16;
const MENU_ROW_HEIGHT = 22;

export function getMidiBounds(element: MidiElement): BoundingBox {
  const normalized = normalizeMidiElement(element);
  const tx = normalized.transform.values[6];
  const ty = normalized.transform.values[7];

  return {
    left: tx,
    top: ty,
    right: tx + normalized.width,
    bottom: ty + normalized.height,
  };
}

export function getMidiLayout(element: MidiElement): MidiLayout {
  const normalized = normalizeMidiElement(element);
  const bounds = getMidiBounds(normalized);
  const headerHeight = MIDI_HEADER_HEIGHT;
  const playButtonSize = Math.min(PLAY_BUTTON_SIZE, headerHeight);
  const bodyTop = bounds.top + headerHeight + 12;
  const lanes: MidiLaneLayout[] = [];

  const playButtonBounds: BoundingBox = {
    left: bounds.left + OUTER_PADDING,
    top: bounds.top + (headerHeight - playButtonSize) / 2 + 5,
    right: bounds.left + OUTER_PADDING + playButtonSize,
    bottom: bounds.top + (headerHeight - playButtonSize) / 2 + 5 + playButtonSize,
  };

  for (let laneIndex = 0; laneIndex < normalized.lanes.length; laneIndex++) {
    const laneTop = bodyTop + laneIndex * (MIDI_LANE_HEIGHT + LANE_GAP);
    const instrumentBounds: BoundingBox = {
      left: bounds.left + OUTER_PADDING,
      top: laneTop,
      right: bounds.left + OUTER_PADDING + LANE_LABEL_WIDTH,
      bottom: laneTop + MIDI_LANE_HEIGHT,
    };
    const removeButtonBounds: BoundingBox = {
      left: instrumentBounds.right - REMOVE_BUTTON_SIZE - 8,
      top: instrumentBounds.top + 8,
      right: instrumentBounds.right - 8,
      bottom: instrumentBounds.top + 8 + REMOVE_BUTTON_SIZE,
    };
    const gridBounds: BoundingBox = {
      left: instrumentBounds.right + CONTROL_GAP,
      top: laneTop,
      right: bounds.right - OUTER_PADDING,
      bottom: laneTop + MIDI_LANE_HEIGHT,
    };
    const menuHeight = MENU_ROW_HEIGHT * normalized.steps;
    const availableBelow = bounds.bottom - instrumentBounds.bottom - 8;
    const menuTop =
      availableBelow >= MENU_ROW_HEIGHT * normalized.lanes.length
        ? instrumentBounds.bottom + 4
        : Math.max(bounds.top + 30, instrumentBounds.top);
    const instrumentMenuBounds: BoundingBox = {
      left: instrumentBounds.left,
      top: menuTop,
      right: instrumentBounds.right + 34,
      bottom: menuTop + MENU_ROW_HEIGHT * 7,
    };
    lanes.push({
      laneIndex,
      instrumentBounds,
      removeButtonBounds,
      gridBounds,
      instrumentMenuBounds,
      stepWidth: (gridBounds.right - gridBounds.left) / normalized.steps,
      stepHeight: gridBounds.bottom - gridBounds.top,
    });
  }

  const lastLaneBottom = lanes.length > 0 ? lanes[lanes.length - 1].gridBounds.bottom : bodyTop;
  const addLaneBounds: BoundingBox = {
    left: bounds.left + OUTER_PADDING,
    top: lastLaneBottom + FOOTER_GAP,
    right: bounds.left + OUTER_PADDING + MIDI_ADD_BUTTON_SIZE,
    bottom: lastLaneBottom + FOOTER_GAP + MIDI_ADD_BUTTON_SIZE,
  };

  return {
    bounds,
    playButtonBounds,
    addLaneBounds,
    lanes,
    headerHeight,
  };
}

export function getMidiStepBounds(
  element: MidiElement,
  laneIndex: number,
  stepIndex: number
): BoundingBox {
  const layout = getMidiLayout(element);
  const lane = layout.lanes[laneIndex];

  return {
    left: lane.gridBounds.left + stepIndex * lane.stepWidth,
    top: lane.gridBounds.top,
    right: lane.gridBounds.left + (stepIndex + 1) * lane.stepWidth,
    bottom: lane.gridBounds.bottom,
  };
}
