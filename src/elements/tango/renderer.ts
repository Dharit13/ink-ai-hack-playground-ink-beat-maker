// Tango element renderer
//
// Renders the grid with circles (○) and crosses (×), constraint signs
// between cells, conflict highlighting, and completion overlay.

import type { BoundingBox } from '../../types';
import type { TangoElement } from './types';
import type { RenderOptions } from '../registry/ElementPlugin';

const CELL_BG = '#f5f5f5';
const CELL_GIVEN_BG = '#e8e8e8';
const GRID_LINE_COLOR = '#cccccc';
const GRID_BORDER_COLOR = '#333333';
const GRID_LINE_WIDTH = 1;
const GRID_BORDER_WIDTH = 2.5;
const CONFLICT_FILL = 'rgba(255, 0, 0, 0.15)';
const SOLVED_FILL = 'rgba(0, 180, 0, 0.10)';

const SUN_FILL = '#FFB300';
const SUN_STROKE = '#F57F17';
const SUN_RAY_COLOR = '#FFA000';
const SYMBOL_LINE_WIDTH = 2.5;

const CONSTRAINT_EQUAL_COLOR = '#666666';
const CONSTRAINT_OPPOSITE_COLOR = '#666666';
const CONSTRAINT_BG = '#ffffff';
const CONSTRAINT_FONT_SIZE = 14;

const COMPLETION_BG = 'rgba(255, 255, 255, 0.85)';
const COMPLETION_TEXT_COLOR = '#16a34a';

export function render(
  ctx: CanvasRenderingContext2D,
  element: TangoElement,
  _options?: RenderOptions,
): void {
  const tx = element.transform.values[6];
  const ty = element.transform.values[7];
  const { gameState } = element;
  const { size } = gameState;
  const cellSize = element.width / size;

  ctx.save();
  ctx.translate(tx, ty);

  // Background
  drawCells(ctx, element, cellSize);

  // Grid lines
  drawGridLines(ctx, element, cellSize, size);

  // Constraints between cells
  drawConstraints(ctx, element, cellSize);

  // Symbols
  drawSymbols(ctx, element, cellSize);

  // Border
  ctx.strokeStyle = GRID_BORDER_COLOR;
  ctx.lineWidth = GRID_BORDER_WIDTH;
  ctx.strokeRect(0, 0, element.width, element.height);

  // Completion overlay
  if (element.isSolved) {
    drawCompletionOverlay(ctx, element);
  }

  ctx.restore();
}

function drawCells(
  ctx: CanvasRenderingContext2D,
  element: TangoElement,
  cellSize: number,
): void {
  const { gameState, conflictCells } = element;
  const { size } = gameState;
  const conflictSet = new Set(conflictCells);
  const givenSet = new Set(gameState.givenCells);

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const idx = r * size + c;
      const x = c * cellSize;
      const y = r * cellSize;

      // Cell background
      if (element.isSolved) {
        ctx.fillStyle = SOLVED_FILL;
      } else if (conflictSet.has(idx)) {
        ctx.fillStyle = CONFLICT_FILL;
      } else if (givenSet.has(idx)) {
        ctx.fillStyle = CELL_GIVEN_BG;
      } else {
        ctx.fillStyle = CELL_BG;
      }
      ctx.fillRect(x, y, cellSize, cellSize);
    }
  }
}

function drawGridLines(
  ctx: CanvasRenderingContext2D,
  element: TangoElement,
  cellSize: number,
  size: number,
): void {
  ctx.strokeStyle = GRID_LINE_COLOR;
  ctx.lineWidth = GRID_LINE_WIDTH;

  for (let i = 1; i < size; i++) {
    ctx.beginPath();
    ctx.moveTo(i * cellSize, 0);
    ctx.lineTo(i * cellSize, element.height);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, i * cellSize);
    ctx.lineTo(element.width, i * cellSize);
    ctx.stroke();
  }
}

function drawConstraints(
  ctx: CanvasRenderingContext2D,
  element: TangoElement,
  cellSize: number,
): void {
  const { constraints } = element.gameState;

  for (const constraint of constraints) {
    const x1 = constraint.col1 * cellSize + cellSize / 2;
    const y1 = constraint.row1 * cellSize + cellSize / 2;
    const x2 = constraint.col2 * cellSize + cellSize / 2;
    const y2 = constraint.row2 * cellSize + cellSize / 2;

    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;

    // White circle background for the sign
    const radius = CONSTRAINT_FONT_SIZE * 0.6;
    ctx.fillStyle = CONSTRAINT_BG;
    ctx.beginPath();
    ctx.arc(mx, my, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#dddddd';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Draw sign
    ctx.font = `bold ${CONSTRAINT_FONT_SIZE}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (constraint.type === 'equal') {
      ctx.fillStyle = CONSTRAINT_EQUAL_COLOR;
      ctx.fillText('=', mx, my);
    } else {
      ctx.fillStyle = CONSTRAINT_OPPOSITE_COLOR;
      ctx.fillText('×', mx, my);
    }
  }
}

function drawSymbols(
  ctx: CanvasRenderingContext2D,
  element: TangoElement,
  cellSize: number,
): void {
  const { gameState } = element;
  const { size, grid } = gameState;
  const padding = cellSize * 0.22;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const sym = grid[r * size + c];
      if (sym === null) continue;

      const cx = c * cellSize + cellSize / 2;
      const cy = r * cellSize + cellSize / 2;
      const halfSize = (cellSize - padding * 2) / 2;

      if (sym === 'circle') {
        // Full moon with craters
        const r = halfSize * 0.8;

        // Base moon with gradient
        const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
        grad.addColorStop(0, '#F5F5F0');   // bright silvery highlight
        grad.addColorStop(0.5, '#E0DDD5'); // pale grey
        grad.addColorStop(1, '#C8C4B8');   // warm grey edge

        ctx.fillStyle = grad;
        ctx.strokeStyle = '#A8A498';
        ctx.lineWidth = SYMBOL_LINE_WIDTH;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Craters
        ctx.fillStyle = 'rgba(160, 155, 140, 0.4)';
        ctx.beginPath();
        ctx.arc(cx - r * 0.25, cy - r * 0.15, r * 0.18, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx + r * 0.3, cy + r * 0.25, r * 0.14, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx + r * 0.05, cy + r * 0.45, r * 0.1, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Sun (circle with rays)
        const coreRadius = halfSize * 0.5;
        const rayInner = halfSize * 0.6;
        const rayOuter = halfSize * 0.95;
        const rayCount = 8;

        ctx.fillStyle = SUN_FILL;
        ctx.strokeStyle = SUN_STROKE;
        ctx.lineWidth = SYMBOL_LINE_WIDTH;
        ctx.beginPath();
        ctx.arc(cx, cy, coreRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.strokeStyle = SUN_RAY_COLOR;
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        for (let i = 0; i < rayCount; i++) {
          const angle = (Math.PI * 2 * i) / rayCount;
          const cosA = Math.cos(angle);
          const sinA = Math.sin(angle);
          ctx.beginPath();
          ctx.moveTo(cx + rayInner * cosA, cy + rayInner * sinA);
          ctx.lineTo(cx + rayOuter * cosA, cy + rayOuter * sinA);
          ctx.stroke();
        }
        ctx.lineCap = 'butt';
      }
    }
  }
}

function drawCompletionOverlay(
  ctx: CanvasRenderingContext2D,
  element: TangoElement,
): void {
  const text = 'Puzzle Complete!';
  const fontSize = 24;
  ctx.font = `bold ${fontSize}px sans-serif`;

  const metrics = ctx.measureText(text);
  const textWidth = metrics.width;
  const textHeight = fontSize;

  const cx = element.width / 2;
  const cy = element.height / 2;
  const padding = 12;

  ctx.fillStyle = COMPLETION_BG;
  ctx.fillRect(
    cx - textWidth / 2 - padding,
    cy - textHeight / 2 - padding,
    textWidth + padding * 2,
    textHeight + padding * 2,
  );

  ctx.fillStyle = COMPLETION_TEXT_COLOR;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy);
}

export function getBounds(element: TangoElement): BoundingBox | null {
  const tx = element.transform.values[6];
  const ty = element.transform.values[7];

  return {
    left: tx,
    top: ty,
    right: tx + element.width,
    bottom: ty + element.height,
  };
}
