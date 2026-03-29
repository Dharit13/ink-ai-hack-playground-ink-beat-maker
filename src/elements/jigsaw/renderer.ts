// Jigsaw puzzle renderer

import type { BoundingBox } from '../../types';
import type { JigsawElement, JigsawGameState, JigsawPiece } from './types';
import type { RenderOptions } from '../registry/ElementPlugin';

const BORDER_COLOR = '#333333';
const BORDER_WIDTH = 2.5;
const TARGET_OUTLINE = 'rgba(0, 0, 0, 0.08)';
const TARGET_LINE = 'rgba(0, 0, 0, 0.12)';
const PIECE_OUTLINE_COLOR = '#555555';
const PIECE_OUTLINE_WIDTH = 1.5;
const PLACED_GLOW = 'rgba(0, 180, 0, 0.3)';

// Image cache with LRU eviction (max 10 entries)
const MAX_IMAGE_CACHE = 10;
const imageCache = new Map<string, HTMLImageElement>();
const loadPromises = new Map<string, Promise<void>>();

export function preloadJigsawImage(dataUrl: string): Promise<void> {
  if (!dataUrl) return Promise.resolve();
  const existing = imageCache.get(dataUrl);
  if (existing?.complete) return Promise.resolve();
  const pending = loadPromises.get(dataUrl);
  if (pending) return pending;
  const img = new Image();
  // Evict oldest entry if cache is full
  if (imageCache.size >= MAX_IMAGE_CACHE) {
    const oldest = imageCache.keys().next().value!;
    imageCache.delete(oldest);
    loadPromises.delete(oldest);
  }
  imageCache.set(dataUrl, img);
  const promise = new Promise<void>((resolve, reject) => {
    img.onload = () => { loadPromises.delete(dataUrl); resolve(); };
    img.onerror = () => { loadPromises.delete(dataUrl); imageCache.delete(dataUrl); reject(new Error('Failed to preload jigsaw image')); };
    img.src = dataUrl;
  });
  loadPromises.set(dataUrl, promise);
  return promise;
}

function getImage(dataUrl: string): HTMLImageElement | null {
  if (!dataUrl) return null;
  const cached = imageCache.get(dataUrl);
  return cached?.complete ? cached : null;
}

export function render(
  ctx: CanvasRenderingContext2D,
  element: JigsawElement,
  _options?: RenderOptions,
): void {
  const tx = element.transform.values[6];
  const ty = element.transform.values[7];

  ctx.save();
  ctx.translate(tx, ty);

  // Background
  ctx.fillStyle = 'rgba(240, 238, 230, 0.4)';
  ctx.fillRect(0, 0, element.width, element.height);

  if (element.isGenerating) {
    drawLoadingState(ctx, element);
  } else if (!element.gameState) {
    drawErrorState(ctx, element);
  } else if (element.isSolved) {
    drawSolvedState(ctx, element, element.gameState);
  } else {
    drawPlayingState(ctx, element, element.gameState);
  }

  // Border
  ctx.strokeStyle = BORDER_COLOR;
  ctx.lineWidth = BORDER_WIDTH;
  ctx.strokeRect(0, 0, element.width, element.height);

  ctx.restore();
}

function drawLoadingState(ctx: CanvasRenderingContext2D, element: JigsawElement): void {
  const cx = element.width / 2;
  const cy = element.height / 2;

  const time = performance.now() / 1000;
  const angle = time * 3;

  ctx.strokeStyle = '#666';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy - 15, 12, angle, angle + Math.PI * 1.5);
  ctx.stroke();

  ctx.fillStyle = '#666';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('Generating puzzle...', cx, cy + 10);

  if (element.prompt) {
    ctx.fillStyle = '#999';
    ctx.font = '12px sans-serif';
    ctx.fillText(`"${element.prompt}"`, cx, cy + 30);
  }
}

function drawErrorState(ctx: CanvasRenderingContext2D, element: JigsawElement): void {
  const cx = element.width / 2;
  const cy = element.height / 2;

  ctx.fillStyle = '#cc0000';
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Generation failed', cx, cy);

  ctx.fillStyle = '#999';
  ctx.font = '12px sans-serif';
  ctx.fillText('Delete and try again', cx, cy + 24);
}

function drawSolvedState(
  ctx: CanvasRenderingContext2D,
  element: JigsawElement,
  gameState: JigsawGameState,
): void {
  const img = getImage(element.imageDataUrl);
  const { puzzleLeft, puzzleTop, pieceWidth, pieceHeight, rows, cols } = gameState;
  const puzzleWidth = cols * pieceWidth;
  const puzzleHeight = rows * pieceHeight;

  // Draw completed image
  if (img) {
    ctx.drawImage(img, puzzleLeft, puzzleTop, puzzleWidth, puzzleHeight);
  }

  // Overlay text
  const cx = element.width / 2;
  const cy = element.height / 2;
  const fontSize = 28;
  ctx.font = `bold ${fontSize}px sans-serif`;
  const text = 'Puzzle Complete!';
  const metrics = ctx.measureText(text);
  const pad = 12;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.fillRect(
    cx - metrics.width / 2 - pad,
    cy - fontSize / 2 - pad,
    metrics.width + pad * 2,
    fontSize + pad * 2,
  );
  ctx.fillStyle = '#16a34a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy);
}

function drawPlayingState(
  ctx: CanvasRenderingContext2D,
  element: JigsawElement,
  gameState: JigsawGameState,
): void {
  const { puzzleLeft, puzzleTop, pieceWidth, pieceHeight, rows, cols } = gameState;
  const puzzleWidth = cols * pieceWidth;
  const puzzleHeight = rows * pieceHeight;

  // Draw target area outline
  ctx.fillStyle = TARGET_OUTLINE;
  ctx.fillRect(puzzleLeft, puzzleTop, puzzleWidth, puzzleHeight);

  ctx.strokeStyle = TARGET_LINE;
  ctx.lineWidth = 1;
  for (let r = 0; r <= rows; r++) {
    const y = puzzleTop + r * pieceHeight;
    ctx.beginPath();
    ctx.moveTo(puzzleLeft, y);
    ctx.lineTo(puzzleLeft + puzzleWidth, y);
    ctx.stroke();
  }
  for (let c = 0; c <= cols; c++) {
    const x = puzzleLeft + c * pieceWidth;
    ctx.beginPath();
    ctx.moveTo(x, puzzleTop);
    ctx.lineTo(x, puzzleTop + puzzleHeight);
    ctx.stroke();
  }

  const img = getImage(element.imageDataUrl);
  if (!img) return;

  // Render placed pieces first, then unplaced (so unplaced are on top for dragging)
  const placed = gameState.pieces.filter(p => p.isPlaced);
  const unplaced = gameState.pieces.filter(p => !p.isPlaced);

  // Render dragged piece last (on top)
  const activeDragPieceId = dragPieceIds.get(element.id) ?? null;
  const dragged = unplaced.filter(p => p.id === activeDragPieceId);
  const notDragged = unplaced.filter(p => p.id !== activeDragPieceId);

  for (const piece of placed) {
    drawPiece(ctx, piece, gameState, img, true);
  }
  for (const piece of notDragged) {
    drawPiece(ctx, piece, gameState, img, false);
  }
  for (const piece of dragged) {
    drawPiece(ctx, piece, gameState, img, false);
  }
}

function drawPiece(
  ctx: CanvasRenderingContext2D,
  piece: JigsawPiece,
  gameState: JigsawGameState,
  img: HTMLImageElement,
  isPlaced: boolean,
): void {
  const { pieceWidth, pieceHeight, cols, rows } = gameState;
  const tabSize = Math.min(pieceWidth, pieceHeight) * 0.17;

  ctx.save();
  ctx.translate(piece.currentX, piece.currentY);

  // Build clip path
  ctx.beginPath();
  // Top edge (left to right)
  ctx.moveTo(0, 0);
  drawJigsawEdge(ctx, 0, 0, pieceWidth, 0, piece.edges.top, { x: 0, y: -1 }, tabSize);
  // Right edge (top to bottom)
  drawJigsawEdge(ctx, pieceWidth, 0, pieceWidth, pieceHeight, piece.edges.right, { x: 1, y: 0 }, tabSize);
  // Bottom edge (right to left)
  drawJigsawEdge(ctx, pieceWidth, pieceHeight, 0, pieceHeight, piece.edges.bottom, { x: 0, y: 1 }, tabSize);
  // Left edge (bottom to top)
  drawJigsawEdge(ctx, 0, pieceHeight, 0, 0, piece.edges.left, { x: -1, y: 0 }, tabSize);
  ctx.closePath();

  // Shadow for unplaced pieces
  if (!isPlaced) {
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
  }

  // Clip and draw image portion
  ctx.save();
  ctx.clip();

  // The image maps to the puzzle area. This piece shows the region at (col*pw, row*ph).
  const srcX = piece.col * (img.width / cols);
  const srcY = piece.row * (img.height / rows);
  const srcW = img.width / cols;
  const srcH = img.height / rows;

  ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, pieceWidth, pieceHeight);

  if (isPlaced) {
    ctx.fillStyle = PLACED_GLOW;
    // Fill beyond base rect to cover tab protrusions (clip path constrains it)
    ctx.fillRect(-tabSize, -tabSize, pieceWidth + tabSize * 2, pieceHeight + tabSize * 2);
  }

  ctx.restore();

  // Piece outline
  ctx.strokeStyle = PIECE_OUTLINE_COLOR;
  ctx.lineWidth = PIECE_OUTLINE_WIDTH;
  ctx.stroke();

  ctx.restore();
}

/**
 * Draw one jigsaw edge with a tab or blank.
 * outDir is the unit vector pointing outward from the piece for this edge.
 */
function drawJigsawEdge(
  ctx: CanvasRenderingContext2D,
  sx: number, sy: number,
  ex: number, ey: number,
  type: -1 | 0 | 1,
  outDir: { x: number; y: number },
  tabSize: number,
): void {
  if (type === 0) {
    ctx.lineTo(ex, ey);
    return;
  }

  const dx = ex - sx;
  const dy = ey - sy;
  // Perpendicular outward direction, scaled by tab type
  const px = outDir.x * type * tabSize;
  const py = outDir.y * type * tabSize;

  // Straight to 38%
  ctx.lineTo(sx + dx * 0.38, sy + dy * 0.38);

  // Neck → tab head → neck
  ctx.bezierCurveTo(
    sx + dx * 0.38 + px * 0.05, sy + dy * 0.38 + py * 0.05,
    sx + dx * 0.32 + px * 0.8,  sy + dy * 0.32 + py * 0.8,
    sx + dx * 0.38 + px,        sy + dy * 0.38 + py,
  );
  ctx.bezierCurveTo(
    sx + dx * 0.44 + px * 1.2,  sy + dy * 0.44 + py * 1.2,
    sx + dx * 0.56 + px * 1.2,  sy + dy * 0.56 + py * 1.2,
    sx + dx * 0.62 + px,        sy + dy * 0.62 + py,
  );
  ctx.bezierCurveTo(
    sx + dx * 0.68 + px * 0.8,  sy + dy * 0.68 + py * 0.8,
    sx + dx * 0.62 + px * 0.05, sy + dy * 0.62 + py * 0.05,
    sx + dx * 0.62,             sy + dy * 0.62,
  );

  // Straight to end
  ctx.lineTo(ex, ey);
}

// Drag state per element (used by renderer for z-ordering)
const dragPieceIds = new Map<string, number>();
export function setDragPieceId(elementId: string, pieceId: number | null): void {
  if (pieceId === null) {
    dragPieceIds.delete(elementId);
  } else {
    dragPieceIds.set(elementId, pieceId);
  }
}

export function getBounds(element: JigsawElement): BoundingBox | null {
  const tx = element.transform.values[6];
  const ty = element.transform.values[7];
  return {
    left: tx,
    top: ty,
    right: tx + element.width,
    bottom: ty + element.height,
  };
}
