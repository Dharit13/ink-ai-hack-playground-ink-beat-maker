# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ink Playground is a React + TypeScript + Vite web app for rapid prototyping of interactive ink-based elements. It renders, edits, and recognizes handwritten content.

Features: Interactive ink canvas, handwriting recognition via REST API, interactive elements (games, text, shapes), eraser with stroke splitting, undo/redo. Uses OpenRouter SDK for LLM inference.

## Build Commands

```bash
npm install              # Install dependencies
cp .env.example .env     # Set up environment (first time only)
npm run dev              # Start dev server with HMR (http://localhost:5173)
npm run build            # TypeScript compile + Vite bundle
npm run lint             # ESLint check
npm run preview          # Preview production build
```

There is no test framework configured — no unit or integration tests exist.

## Git Hooks

A pre-push hook runs `npm run lint` and `npm run build` before every push.
Run `npm run setup` once after cloning to activate it (`git config core.hooksPath .githooks`).

## Git Conventions

- Branch naming: `feature/INK-00/description`, `bug/INK-00/description`, `chore/INK-00/description`
- Commit messages: `INK-00: Description of change`

## Architecture

### Directory Structure

- `src/types/` — TypeScript interfaces (primitives, brush, elements, noteContent)
- `src/canvas/` — Core rendering: InkCanvas.tsx (main component), ViewportManager.ts (pan/zoom), StrokeRenderer.ts
- `src/elements/` — Plugin-based element system, split into:
  - `registry/` — ElementPlugin interface and ElementRegistry dispatcher
  - Per-type directories each with `renderer.ts` and optionally `creator.ts`, `interaction.ts`, `icon.tsx`
  - `rendering/` — Shared element rendering functions
  - `utils/` — Shared element utilities
- `src/input/` — StrokeBuilder accumulates pointer events into Stroke objects
- `src/recognition/` — RecognitionService (REST client), StrokeClustering (spatial/temporal grouping)
- `src/eraser/` — ScribbleEraser, scribble detection, overlap calculators
- `src/state/` — useUndoRedo custom hook
- `src/debug/` — DebugLogger, DebugConsole overlay

### Key Patterns

**Element Plugin System**: Registry-based plugin architecture. Each element type lives in `src/elements/<type>/` and self-registers on import. See `docs/New element HOWTO.md` for a complete guide to adding new element types — no changes needed to App.tsx, ElementRenderer, PaletteMenu, or dispatch logic.

- **Creation**: `canCreate()` + async `createFromInk()` — dispatcher `tryCreateElement()` tries all creators
- **Interaction**: `isInterestedIn()` → `acceptInk()` pipeline for elements that respond to additional ink
- **Handle-based interaction**: `getHandles()` + `onHandleDrag()` for drag-based manipulation (e.g., image resizing)
- **Palette entries**: Elements can register in the rectangle+X gesture menu via `registerPaletteEntry()`
- **Unused stub params**: Plugin interface methods (`renderer.ts`, `interaction.ts`, `creator.ts`) often have required parameters unused in a given implementation. Prefix these with `_` (e.g. `_options`, `_recognitionResult`, `_context`) — ESLint is configured to allow this pattern.

**Dual Canvas Rendering**: Main canvas renders completed elements (noteElements), overlay canvas renders in-progress strokes and selection marquee.

**Stroke Lifecycle**: Pointer events → StrokeBuilder → finishedStrokesRef (overlay) → debounce (150ms) → processStrokes → noteElements (main canvas). Strokes clear from overlay when they appear in noteElements.

**MIDI Element**: The MIDI sequencer is a registered element plugin in `src/elements/midi/`.

- `types.ts` defines the serialized element shape, step state, and automation-lane fields
- `layout.ts` centralizes header, lane, step, and automation bounds
- `renderer.ts` handles playback animation and sketch-style rendering using `roughjs`
- `interaction.ts` handles taps, drag-to-set velocity, mode toggle, playback toggle, resize, and automation lane drawing below the main sequencer

### Key Files

| Purpose | Path |
|---------|------|
| Main app logic | `src/App.tsx` |
| Canvas component | `src/canvas/InkCanvas.tsx` |
| Element types | `src/types/elements.ts` |
| Element registry | `src/elements/registry/ElementRegistry.ts` |
| Plugin interface | `src/elements/registry/ElementPlugin.ts` |
| MIDI plugin entry | `src/elements/midi/index.ts` |
| MIDI layout/render/interaction | `src/elements/midi/{layout,renderer,interaction}.ts` |
| Recognition client | `src/recognition/RecognitionService.ts` |
| New element guide | `docs/New element HOWTO.md` |

## Configuration

**Environment**: Copy `.env.example` to `.env` and fill in your API keys. `INK_RECOGNITION_API_URL` must be set to a running recognition service endpoint.

**TypeScript**: Strict mode, ES2022 target, react-jsx

**Rendering dependencies**: The MIDI element uses `roughjs` for sketch-style canvas rendering, and `index.html` loads the Caveat font used in the MIDI UI.

## Type System

Core immutable, JSON-serializable interfaces:
- `Stroke` contains `inputs` (StrokeInput[]) and `brush` (color, size, stockBrush)
- `Element` is a union type defined in `src/types/elements.ts` — add new element types there (1 line)
- Only StrokeElement has no transform; others have position/rotation/scale via `transform` matrix
- `NoteElements` is the container with `elements: Element[]`
