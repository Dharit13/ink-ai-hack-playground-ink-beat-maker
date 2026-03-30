import type { BoundingBox } from '../../types';
import type { MidiElement } from './types';
import {
  MIDI_ADD_BUTTON_SIZE,
  MIDI_BODY_TOP_OFFSET,
  MIDI_FOOTER_GAP,
  MIDI_HEADER_HEIGHT,
  MIDI_LANE_GAP,
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
  toggleModeBounds: BoundingBox;
  headerTextBounds: BoundingBox;
  tempoDisplayBounds: BoundingBox;
  tapTempoButtonBounds: BoundingBox;
  downloadButtonBounds: BoundingBox;
  addLaneBounds: BoundingBox;
  lanes: MidiLaneLayout[];
  headerHeight: number;
  automationLaneBounds?: BoundingBox;
}

const OUTER_PADDING = 10;
const HEADER_INSET_Y = 14;
const PLAY_BUTTON_SIZE = 24;
const CONTROL_GAP = 12;
const LANE_LABEL_WIDTH = 132;
const REMOVE_BUTTON_SIZE = 14;
const MENU_ROW_HEIGHT = 22;
const TOGGLE_BUTTON_WIDTH = 50;
const TEMPO_DISPLAY_WIDTH = 58;
const TAP_TEMPO_BUTTON_WIDTH = 74;
const DOWNLOAD_BUTTON_SIZE = 24;
const HEADER_TAP_TEMPO_GAP = 6;
const HEADER_TEXT_GAP = 16;
export const MIDI_CONTROL_TAP_PADDING = 6;
export const MIDI_STEP_GRID_TAP_PADDING = 4;
const AUTOMATION_GAP = 8;
const AUTOMATION_ZONE_REACH = 220;

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
  const bodyTop = bounds.top + headerHeight + MIDI_BODY_TOP_OFFSET;
  const lanes: MidiLaneLayout[] = [];

  const playButtonBounds: BoundingBox = {
    left: bounds.left + OUTER_PADDING,
    top: bounds.top + HEADER_INSET_Y,
    right: bounds.left + OUTER_PADDING + playButtonSize,
    bottom: bounds.top + HEADER_INSET_Y + playButtonSize,
  };

  const toggleModeBounds: BoundingBox = {
    left: playButtonBounds.right + CONTROL_GAP,
    top: playButtonBounds.top,
    right: playButtonBounds.right + CONTROL_GAP + TOGGLE_BUTTON_WIDTH,
    bottom: playButtonBounds.bottom,
  };

  const headerTextBounds: BoundingBox = {
    left: toggleModeBounds.right + HEADER_TEXT_GAP,
    top: playButtonBounds.top,
    right:
      bounds.right -
      OUTER_PADDING -
      DOWNLOAD_BUTTON_SIZE -
      CONTROL_GAP -
      TAP_TEMPO_BUTTON_WIDTH -
      HEADER_TAP_TEMPO_GAP -
      TEMPO_DISPLAY_WIDTH -
      CONTROL_GAP,
    bottom: playButtonBounds.bottom,
  };

  const tapTempoButtonBounds: BoundingBox = {
    left: bounds.right - OUTER_PADDING - TEMPO_DISPLAY_WIDTH - HEADER_TAP_TEMPO_GAP - TAP_TEMPO_BUTTON_WIDTH,
    top: playButtonBounds.top,
    right: bounds.right - OUTER_PADDING - TEMPO_DISPLAY_WIDTH - HEADER_TAP_TEMPO_GAP,
    bottom: playButtonBounds.bottom,
  };

  const tempoDisplayBounds: BoundingBox = {
    left: tapTempoButtonBounds.right + HEADER_TAP_TEMPO_GAP,
    top: playButtonBounds.top,
    right: tapTempoButtonBounds.right + HEADER_TAP_TEMPO_GAP + TEMPO_DISPLAY_WIDTH,
    bottom: playButtonBounds.bottom,
  };

  const downloadButtonBounds: BoundingBox = {
    left: tempoDisplayBounds.right + CONTROL_GAP,
    top: playButtonBounds.top,
    right: tempoDisplayBounds.right + CONTROL_GAP + DOWNLOAD_BUTTON_SIZE,
    bottom: playButtonBounds.bottom,
  };

  for (let laneIndex = 0; laneIndex < normalized.lanes.length; laneIndex++) {
    const laneTop = bodyTop + laneIndex * (MIDI_LANE_HEIGHT + MIDI_LANE_GAP);
    const instrumentBounds: BoundingBox = {
      left: bounds.left + OUTER_PADDING,
      top: laneTop,
      right: bounds.left + OUTER_PADDING + LANE_LABEL_WIDTH,
      bottom: laneTop + MIDI_LANE_HEIGHT,
    };
    const removeButtonBounds: BoundingBox = {
      left: instrumentBounds.right - REMOVE_BUTTON_SIZE - 10,
      top: instrumentBounds.top + 10,
      right: instrumentBounds.right - 10,
      bottom: instrumentBounds.top + 10 + REMOVE_BUTTON_SIZE,
    };
    const gridBounds: BoundingBox = {
      left: instrumentBounds.right + CONTROL_GAP,
      top: laneTop,
      right: bounds.right - OUTER_PADDING,
      bottom: laneTop + MIDI_LANE_HEIGHT,
    };
    const menuTop = instrumentBounds.bottom + 4;
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
    top: lastLaneBottom + MIDI_FOOTER_GAP,
    right: bounds.left + OUTER_PADDING + MIDI_ADD_BUTTON_SIZE,
    bottom: lastLaneBottom + MIDI_FOOTER_GAP + MIDI_ADD_BUTTON_SIZE,
  };

  const automationLaneBounds: BoundingBox | undefined =
    normalized.automationEnabled && normalized.automationHeight !== undefined
      ? {
          left: lanes[0]?.gridBounds.left ?? bounds.left + OUTER_PADDING,
          top: addLaneBounds.bottom + AUTOMATION_GAP,
          right: lanes[0]?.gridBounds.right ?? bounds.right - OUTER_PADDING,
          bottom: addLaneBounds.bottom + AUTOMATION_GAP + normalized.automationHeight,
        }
      : undefined;

  return {
    bounds,
    playButtonBounds,
    toggleModeBounds,
    headerTextBounds,
    tempoDisplayBounds,
    tapTempoButtonBounds,
    downloadButtonBounds,
    addLaneBounds,
    lanes,
    headerHeight,
    automationLaneBounds,
  };
}

export function getAutomationZoneBounds(element: MidiElement): BoundingBox {
  const normalized = normalizeMidiElement(element);
  const layout = getMidiLayout(normalized);
  const lastLane = layout.lanes[layout.lanes.length - 1];
  const left = lastLane ? lastLane.gridBounds.left : layout.bounds.left + OUTER_PADDING;
  const right = lastLane ? lastLane.gridBounds.right : layout.bounds.right - OUTER_PADDING;
  const top = layout.addLaneBounds.bottom + AUTOMATION_GAP;

  return {
    left,
    top,
    right,
    bottom: top + AUTOMATION_ZONE_REACH,
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

export function expandBounds(bounds: BoundingBox, padding: number): BoundingBox {
  return {
    left: bounds.left - padding,
    top: bounds.top - padding,
    right: bounds.right + padding,
    bottom: bounds.bottom + padding,
  };
}

export function getMidiPaddedControlBounds(bounds: BoundingBox): BoundingBox {
  return expandBounds(bounds, MIDI_CONTROL_TAP_PADDING);
}

export function getMidiPaddedStepGridBounds(bounds: BoundingBox): BoundingBox {
  return expandBounds(bounds, MIDI_STEP_GRID_TAP_PADDING);
}

export function getMidiInteractionBounds(element: MidiElement): BoundingBox {
  const normalized = normalizeMidiElement(element);
  const layout = getMidiLayout(normalized);

  let left = layout.bounds.left;
  let top = layout.bounds.top;
  let right = layout.bounds.right;
  let bottom = layout.bounds.bottom;

  const controlBounds = [
    getMidiPaddedControlBounds(layout.playButtonBounds),
    getMidiPaddedControlBounds(layout.toggleModeBounds),
    getMidiPaddedControlBounds(layout.tapTempoButtonBounds),
    getMidiPaddedControlBounds(layout.downloadButtonBounds),
    getMidiPaddedControlBounds(layout.addLaneBounds),
    ...layout.lanes.flatMap((lane) => [
      getMidiPaddedControlBounds(lane.instrumentBounds),
      getMidiPaddedControlBounds(lane.removeButtonBounds),
      getMidiPaddedStepGridBounds(lane.gridBounds),
    ]),
  ];

  if (normalized.openInstrumentLaneId) {
    const openLane = layout.lanes.find(
      (lane) => normalized.lanes[lane.laneIndex]?.id === normalized.openInstrumentLaneId
    );
    if (openLane) {
      controlBounds.push(getMidiPaddedControlBounds(openLane.instrumentMenuBounds));
    }
  }

  if (layout.automationLaneBounds) {
    controlBounds.push(getMidiPaddedControlBounds(layout.automationLaneBounds));
  } else {
    controlBounds.push(getMidiPaddedControlBounds(getAutomationZoneBounds(normalized)));
  }

  for (const bounds of controlBounds) {
    left = Math.min(left, bounds.left);
    top = Math.min(top, bounds.top);
    right = Math.max(right, bounds.right);
    bottom = Math.max(bottom, bounds.bottom);
  }

  return { left, top, right, bottom };
}
