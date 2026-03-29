// Queens game state: puzzle generation, cell cycling, conflict detection, win check

import type { QueenCellState, QueensGameState } from './types';

// ─── Seeded RNG (Mulberry32) ────────────────────────────────────────────────

function createRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ─── Queen Placement (backtracking) ─────────────────────────────────────────
// Constraints: one per row, one per column, no chebyshev-adjacent queens.

function isValidPlacement(
  queens: [number, number][],
  row: number,
  col: number,
): boolean {
  for (const [r, c] of queens) {
    if (c === col) return false; // same column
    if (Math.abs(r - row) <= 1 && Math.abs(c - col) <= 1) return false; // adjacent
  }
  return true;
}

function findQueenPlacement(
  n: number,
  rng: () => number,
): [number, number][] | null {
  const queens: [number, number][] = [];
  const usedCols = new Set<number>();

  function bt(row: number): boolean {
    if (row === n) return true;
    const cols = shuffle(
      Array.from({ length: n }, (_, i) => i).filter((c) => !usedCols.has(c)),
      rng,
    );
    for (const col of cols) {
      if (isValidPlacement(queens, row, col)) {
        queens.push([row, col]);
        usedCols.add(col);
        if (bt(row + 1)) return true;
        queens.pop();
        usedCols.delete(col);
      }
    }
    return false;
  }

  return bt(0) ? queens : null;
}

// ─── Region Generation (multi-source BFS) ───────────────────────────────────
// Grows blob-shaped connected regions outward from each queen's cell.

function buildRegions(
  n: number,
  queens: [number, number][],
  rng: () => number,
): number[] {
  const regions = new Array<number>(n * n).fill(-1);
  type QEntry = [number, number, number]; // [row, col, regionId]

  // Seed all queens simultaneously, shuffled for random tie-breaking
  const initial: QEntry[] = shuffle(
    queens.map(([r, c], i) => [r, c, i] as QEntry),
    rng,
  );
  for (const [r, c, id] of initial) regions[r * n + c] = id;

  const queue: QEntry[] = [...initial];
  const dirs: [number, number][] = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
    [-1, -1], [-1, 1], [1, -1], [1, 1],
  ];

  let head = 0;
  while (head < queue.length) {
    const [r, c, id] = queue[head++];
    const shuffledDirs = shuffle(dirs, rng);
    for (const [dr, dc] of shuffledDirs) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < n && nc >= 0 && nc < n && regions[nr * n + nc] === -1) {
        regions[nr * n + nc] = id;
        queue.push([nr, nc, id]);
      }
    }
  }

  return regions;
}

// ─── Public: generatePuzzle ──────────────────────────────────────────────────

export function generatePuzzle(
  n: number,
  seed: number,
): Pick<QueensGameState, 'size' | 'regions' | 'seed'> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const queens = findQueenPlacement(n, createRng(seed + attempt * 997));
    if (!queens) continue;
    const rng2 = createRng(seed + attempt * 1009 + 1);
    const regions = buildRegions(n, queens, rng2);
    if (regions.includes(-1)) continue; // sanity check
    return { size: n, regions, seed };
  }
  throw new Error(`Cannot generate a ${n}×${n} Queens puzzle (seed=${seed})`);
}

export function createInitialState(
  n: number,
  seed: number,
): QueensGameState {
  const { size, regions } = generatePuzzle(n, seed);
  return {
    size,
    regions,
    cells: new Array<QueenCellState>(size * size).fill('empty'),
    won: false,
    seed,
  };
}

// ─── Conflict Detection ──────────────────────────────────────────────────────

export function computeConflicts(state: QueensGameState): number[] {
  const { size, regions, cells } = state;
  const queens: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === 'queen') queens.push(i);
  }

  const bad = new Set<number>();

  for (let a = 0; a < queens.length; a++) {
    for (let b = a + 1; b < queens.length; b++) {
      const ia = queens[a];
      const ib = queens[b];
      const ra = Math.floor(ia / size), ca = ia % size;
      const rb = Math.floor(ib / size), cb = ib % size;

      const sameRow = ra === rb;
      const sameCol = ca === cb;
      const sameRegion = regions[ia] === regions[ib];
      const adjacent = Math.abs(ra - rb) <= 1 && Math.abs(ca - cb) <= 1;

      if (sameRow || sameCol || sameRegion || adjacent) {
        bad.add(ia);
        bad.add(ib);
      }
    }
  }

  return [...bad];
}

// ─── Win Check ───────────────────────────────────────────────────────────────

export function checkWin(state: QueensGameState): boolean {
  const { size, cells } = state;
  const queenCount = cells.filter((c) => c === 'queen').length;
  if (queenCount !== size) return false;
  return computeConflicts(state).length === 0;
}

// ─── Cell Cycling ────────────────────────────────────────────────────────────

const CYCLE: Record<QueenCellState, QueenCellState> = {
  empty: 'x',
  x: 'queen',
  queen: 'empty',
};

export function cycleCell(
  state: QueensGameState,
  cellIndex: number,
): QueensGameState {
  if (state.won) return state;
  const newCells = [...state.cells];
  newCells[cellIndex] = CYCLE[newCells[cellIndex]];
  const next: QueensGameState = { ...state, cells: newCells, won: false };
  next.won = checkWin(next);
  return next;
}
