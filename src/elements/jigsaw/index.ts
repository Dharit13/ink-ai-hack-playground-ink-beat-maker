// Jigsaw Puzzle Element Plugin

import { generateId } from '../../types';
import type { JigsawElement } from './types';
import type { ElementPlugin, HandleDescriptor, HandleDragPhase } from '../registry/ElementPlugin';
import type { Offset } from '../../types/primitives';
import { registerPlugin } from '../registry/ElementRegistry';
import { registerPaletteEntry } from '../../palette/PaletteRegistry';
import { JigsawIcon } from './icon';
import { render, getBounds, setDragPieceId } from './renderer';
import { getRecognitionService } from '../../recognition/RecognitionService';
import { checkSnap, getTargetPosition, checkAllPlaced } from './gameState';
import type { Element } from '../../types/elements';
import { getElementBounds } from '../registry/ElementRegistry';

import { ELEMENT_WIDTH, ELEMENT_HEIGHT } from './constants';

const ORIGIN_SNAP_GRID = 50;

// Drag state keyed by element ID (supports multiple jigsaw elements)
const dragState = new Map<string, { offsetX: number; offsetY: number }>();

const jigsawPlugin: ElementPlugin<JigsawElement> = {
  elementType: 'jigsaw',
  name: 'Jigsaw',

  getHandles(element: JigsawElement): HandleDescriptor[] {
    if (!element.gameState || element.isSolved || element.isGenerating) return [];

    const { pieces, pieceWidth, pieceHeight } = element.gameState;
    const tx = element.transform.values[6];
    const ty = element.transform.values[7];

    // Only unplaced pieces are draggable
    return pieces
      .filter(p => !p.isPlaced)
      .map(piece => ({
        id: `piece-${piece.id}`,
        position: {
          x: tx + piece.currentX + pieceWidth / 2,
          y: ty + piece.currentY + pieceHeight / 2,
        },
        hitRadius: Math.min(pieceWidth, pieceHeight) / 2,
        cursor: 'grab',
        appearance: {
          shape: 'circle' as const,
          size: 0,  // invisible handle — the piece itself is the visual
          fillColor: 'transparent',
          strokeColor: 'transparent',
          strokeWidth: 0,
          activeFillColor: 'transparent',
        },
      }));
  },

  onHandleDrag(
    element: JigsawElement,
    handleId: string,
    phase: HandleDragPhase,
    point: Offset,
  ): JigsawElement {
    if (!element.gameState) return element;

    const pieceId = parseInt(handleId.replace('piece-', ''), 10);
    const tx = element.transform.values[6];
    const ty = element.transform.values[7];
    const localX = point.x - tx;
    const localY = point.y - ty;

    const pieceIdx = element.gameState.pieces.findIndex(p => p.id === pieceId);
    if (pieceIdx === -1) return element;

    const piece = element.gameState.pieces[pieceIdx];
    const { pieceWidth: _pieceWidth, pieceHeight: _pieceHeight } = element.gameState;

    if (phase === 'start') {
      dragState.set(element.id, {
        offsetX: localX - piece.currentX,
        offsetY: localY - piece.currentY,
      });
      setDragPieceId(element.id, pieceId);
      return element;
    }

    if (phase === 'update') {
      const drag = dragState.get(element.id);
      if (!drag) return element;
      const newX = localX - drag.offsetX;
      const newY = localY - drag.offsetY;

      const newPieces = [...element.gameState.pieces];
      newPieces[pieceIdx] = { ...piece, currentX: newX, currentY: newY };

      return {
        ...element,
        gameState: { ...element.gameState, pieces: newPieces },
      };
    }

    if (phase === 'end') {
      setDragPieceId(element.id, null);
      dragState.delete(element.id);

      const updatedPiece = { ...piece };

      if (checkSnap(updatedPiece, element.gameState)) {
        const target = getTargetPosition(updatedPiece, element.gameState);
        updatedPiece.currentX = target.x;
        updatedPiece.currentY = target.y;
        updatedPiece.isPlaced = true;
      }

      const newPieces = [...element.gameState.pieces];
      newPieces[pieceIdx] = updatedPiece;

      const newGameState = { ...element.gameState, pieces: newPieces };
      const solved = checkAllPlaced(newGameState);

      return {
        ...element,
        gameState: newGameState,
        isSolved: solved,
      };
    }

    return element;
  },

  render,
  getBounds,
};

registerPlugin(jigsawPlugin);

registerPaletteEntry({
  id: 'jigsaw',
  label: 'Jigsaw',
  Icon: JigsawIcon,
  category: 'game',
  onSelect: async (bounds, consumeStrokes, context) => {
    const originX = Math.round(bounds.left / ORIGIN_SNAP_GRID) * ORIGIN_SNAP_GRID;
    const originY = Math.round(bounds.top / ORIGIN_SNAP_GRID) * ORIGIN_SNAP_GRID;

    // Try to extract text from elements within bounds.
    // Word strokes may have been recognized as InkText or Glyph elements already,
    // so check those first before falling back to stroke recognition.
    let prompt = '';
    const elementIdsToConsume: string[] = [];

    if (context?.elements) {
      const gestureStrokeSet = new Set(context.gestureStrokes ?? []);

      // 1. Check for InkText / Glyph elements in bounds (already recognized text)
      for (const el of context.elements) {
        if (el.type === 'inkText') {
          if (isElementInBounds(el, bounds)) {
            const text = el.lines.map(l => l.tokens.map(t => t.text).join(' ')).join(' ').trim();
            if (text) {
              prompt = text;
              elementIdsToConsume.push(el.id);
            }
          }
        } else if (el.type === 'glyph') {
          if (isElementInBounds(el, bounds)) {
            if (el.text.trim()) {
              prompt = el.text.trim();
              elementIdsToConsume.push(el.id);
            }
          }
        }
      }

      // 2. If no text found from recognized elements, try stroke recognition
      if (!prompt) {
        const strokeElements = findStrokeElementsInBounds(context.elements, bounds)
          .filter(el => {
            if (el.type !== 'stroke') return false;
            return !el.strokes.some(s => gestureStrokeSet.has(s));
          });
        if (strokeElements.length > 0) {
          const allStrokes = strokeElements.flatMap(el => {
            if (el.type === 'stroke') return el.strokes;
            return [];
          });
          if (allStrokes.length > 0) {
            try {
              const result = await getRecognitionService().recognizeGoogle(allStrokes);
              if (result.rawText.trim()) {
                prompt = result.rawText.trim();
              }
            } catch {
              // Fall back to default
            }
            if (prompt) {
              elementIdsToConsume.push(...strokeElements.map(el => el.id));
            }
          }
        }
      }
    }

    consumeStrokes(...elementIdsToConsume);

    return {
      type: 'jigsaw' as const,
      id: generateId(),
      transform: {
        values: [1, 0, 0, 0, 1, 0, originX, originY, 1] as [number, number, number, number, number, number, number, number, number],
      },
      width: ELEMENT_WIDTH,
      height: ELEMENT_HEIGHT,
      gameState: null,
      isGenerating: true,
      isSolved: false,
      prompt,
      imageDataUrl: '',
    };
  },
});

function findStrokeElementsInBounds(
  elements: Element[],
  bounds: { left: number; top: number; right: number; bottom: number },
): Element[] {
  return elements.filter(el => {
    if (el.type !== 'stroke') return false;
    for (const stroke of el.strokes) {
      for (const input of stroke.inputs.inputs) {
        if (input.x >= bounds.left && input.x <= bounds.right &&
            input.y >= bounds.top && input.y <= bounds.bottom) {
          return true;
        }
      }
    }
    return false;
  });
}

function isElementInBounds(
  el: Element,
  bounds: { left: number; top: number; right: number; bottom: number },
): boolean {
  const elBounds = getElementBounds(el);
  if (!elBounds) return false;
  // Check overlap
  return elBounds.left <= bounds.right && elBounds.right >= bounds.left &&
         elBounds.top <= bounds.bottom && elBounds.bottom >= bounds.top;
}

export { jigsawPlugin };
