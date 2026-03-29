// Element union type and cross-cutting utilities
//
// Element-specific types live in their directories (src/elements/<type>/types.ts).
// This file defines the union and utilities that operate across multiple element types.

import type { StrokeElement } from '../elements/stroke/types';
import type { ShapeElement } from '../elements/shape/types';
import type { GlyphElement } from '../elements/glyph/types';
import type { InkTextElement } from '../elements/inktext/types';
import type { TicTacToeElement } from '../elements/tictactoe/types';
import type { CoordinatePlaneElement } from '../elements/coordinateplane/types';
import type { SketchableImageElement } from '../elements/sketchableimage/types';
import type { ImageElement } from '../elements/image/types';
import type { SudokuElement } from '../elements/sudoku/types';
import type { BridgesElement } from '../elements/bridges/types';
import type { MinesweeperElement } from '../elements/minesweeper/types';
import type { MidiElement } from '../elements/midi/types';
import type { NonogramElement } from '../elements/nonogram/types';
import type { TangoElement } from '../elements/tango/types';
import type { QueensElement } from '../elements/queens/types';
import type { JigsawElement } from '../elements/jigsaw/types';
import type { ColorConnectElement } from '../elements/colorconnect/types';
import type { FXKnobElement } from '../elements/fxknob/types';

// Union type for all elements
export type Element =
  | StrokeElement
  | ShapeElement
  | GlyphElement
  | InkTextElement
  | TicTacToeElement
  | CoordinatePlaneElement
  | SketchableImageElement
  | ImageElement
  | SudokuElement
  | BridgesElement
  | MinesweeperElement
  | MidiElement
  | NonogramElement
  | TangoElement
  | QueensElement
  | JigsawElement
  | ColorConnectElement
  | FXKnobElement;

// Check if element supports background color
export function supportsBackgroundColor(element: Element): boolean {
  return element.type === 'shape';
}

// Get stroke color from element (returns undefined if not applicable or mixed)
export function getElementStrokeColor(element: Element): number | undefined {
  if (element.type === 'shape') {
    if (element.paths.length === 0) return undefined;
    const firstColor = element.paths[0].strokeColor;
    const allSame = element.paths.every(p => p.strokeColor === firstColor);
    return allSame ? firstColor : undefined;
  }
  if (element.type === 'stroke') {
    if (element.strokes.length === 0) return undefined;
    const firstColor = element.strokes[0].brush.color;
    const allSame = element.strokes.every(s => s.brush.color === firstColor);
    return allSame ? firstColor : undefined;
  }
  if (element.type === 'glyph') {
    return element.color;
  }
  return undefined;
}

// Get background/fill color from element
export function getElementBackgroundColor(element: Element): number | undefined {
  if (element.type === 'shape') {
    if (element.paths.length === 0) return undefined;
    const firstColor = element.paths[0].fillColor;
    const allSame = element.paths.every(p => p.fillColor === firstColor);
    return allSame ? firstColor : undefined;
  }
  return undefined;
}

// Set stroke color on element (returns new element)
export function setElementStrokeColor(element: Element, color: number): Element {
  if (element.type === 'shape') {
    return {
      ...element,
      paths: element.paths.map(path => ({ ...path, strokeColor: color })),
    };
  }
  if (element.type === 'stroke') {
    return {
      ...element,
      strokes: element.strokes.map(stroke => ({
        ...stroke,
        brush: { ...stroke.brush, color },
      })),
    };
  }
  if (element.type === 'glyph') {
    return { ...element, color };
  }
  return element;
}

// Set background color on element (returns new element)
export function setElementBackgroundColor(element: Element, color: number | undefined): Element {
  if (element.type === 'shape') {
    return {
      ...element,
      paths: element.paths.map(path => ({ ...path, fillColor: color })),
    };
  }
  return element;
}
