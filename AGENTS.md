# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working in this repository.

## Project Overview

This repo is best understood as **Drumink on top of Ink Playground**.

- **Drumink** is the current flagship experience: an ink-first MIDI step sequencer that lives directly on the canvas.
- **Ink Playground** is the broader React + TypeScript + Vite app and plugin architecture that hosts Drumink alongside other interactive ink elements.

The MIDI element is created from the rectangle+X palette flow and currently supports:

- Multi-lane drum sequencing
- `tap` and `tick` input modes
- Tap tempo
- Live Web Audio playback with a moving playhead
- Per-step velocity via gesture height or tap cycling
- Automation lane creation and curve drawing
- MIDI and WAV export, including optional automation application
- Handwriting-triggered export menu opening via nearby `download` / `dl` gestures

The rest of the playground still exists in the codebase: handwriting recognition, other generated or game-like elements, canvas editing, selection, erasing, and undo/redo.

## Build Commands

```bash
npm install              # Install dependencies
cp .env.example .env     # Set up environment (first time only)
npm run dev              # Start dev server with HMR (http://localhost:5173)
npm run build            # Vite production build
npm run lint             # ESLint check
npm run preview          # Preview production build
```

There is no test framework configured in this repo. Verification is primarily manual plus `npm run lint` / `npm run build`.

## Git Hooks

A pre-push hook runs `npm run lint` and `npm run build` before every push.
Run `npm run setup` once after cloning to activate it (`git config core.hooksPath .githooks`).

## Git Conventions

- Branch naming: `feature/INK-00/description`, `bug/INK-00/description`, `chore/INK-00/description`
- Commit messages: `INK-00: Description of change`

## Architecture

### Directory Structure

- `src/App.tsx` - Main app state, persistence, palette/disambiguation flows, undo/redo wiring
- `src/canvas/` - Core canvas rendering and input handling
- `src/elements/` - Plugin-based element system; Drumink lives in `src/elements/midi/`
- `src/palette/` - Rectangle+X palette registry, intent model, and menu UI
- `src/recognition/` - Handwriting recognition client and clustering utilities
- `src/eraser/` - Scribble erase detection and stroke/element removal logic
- `src/state/` - Undo/redo hook
- `src/types/` - Shared immutable TypeScript models

### Key Patterns

**Element Plugin System**: Each element type lives in `src/elements/<type>/` and self-registers on import. See `docs/New element HOWTO.md` for the full flow.

- Creation: Optional `canCreate()` + async `createFromInk()`
- Interaction: Optional `isInterestedIn()` -> `acceptInk()` pipeline
- Handles: Optional `getHandles()` + `onHandleDrag()`
- Palette: Optional `registerPaletteEntry()` for the rectangle+X menu
- Registration: `src/elements/index.ts` imports every plugin once so the registry can dispatch creation, rendering, and interaction

**Dual Canvas Rendering**: The main canvas renders committed elements. The overlay canvas renders in-progress strokes, marquee selection, and other temporary interaction state.

**Stroke Lifecycle**: Pointer events feed `StrokeBuilder`, completed strokes land on the overlay, the app debounces processing, then routes ink through element creation, palette flows, disambiguation, or element interaction.

### MIDI Element Architecture

The Drumink sequencer is implemented as a registered plugin in `src/elements/midi/`.

- `types.ts` - Serialized MIDI element shape, lane data, export state, automation state, defaults, and normalization for legacy saved notes
- `layout.ts` - Bounds for header controls, lane rows, instrument menu, export menu, and automation lane
- `renderer.ts` - Sketch-style drawing, playhead animation, and playback synchronization against Web Audio
- `interaction.ts` - Tap/tick editing, tap tempo, lane add/remove, instrument selection, automation creation and drawing, export flow, and handwriting-triggered download gestures
- `audio.ts` - Synthesized drum voices plus live/export playback scheduling
- `midiExport.ts` - Standard MIDI file generation and download
- `audioExport.ts` - Offline Web Audio rendering and WAV export
- `index.ts` - Plugin registration plus palette entry wiring

### Key Files

| Purpose | Path |
|---------|------|
| Main app logic | `src/App.tsx` |
| Canvas component | `src/canvas/InkCanvas.tsx` |
| Element union | `src/types/elements.ts` |
| Element registry | `src/elements/registry/ElementRegistry.ts` |
| Plugin interface | `src/elements/registry/ElementPlugin.ts` |
| Palette registry | `src/palette/PaletteRegistry.ts` |
| MIDI plugin entry | `src/elements/midi/index.ts` |
| MIDI audio/export helpers | `src/elements/midi/{audio,midiExport,audioExport}.ts` |
| New element guide | `docs/New element HOWTO.md` |

## Configuration

Copy `.env.example` to `.env` and fill in the services you need:

- `INK_RECOGNITION_API_URL` - Handwriting recognition backend; required for recognition-driven flows
- `INK_OPENROUTER_API_KEY` - OpenRouter access for LLM-backed features
- `INK_FAL_AI_API_KEY` - fal.ai access for sketch image generation
- `INK_GEMINI_API_KEY` - Gemini access for image generation

Not every feature path needs every key, but Drumink still depends on the broader app environment being configured when you exercise recognition or generation flows.

## Type System

Core models are immutable and JSON-serializable.

- `Element` is the cross-app union in `src/types/elements.ts`
- Most interactive elements, including MIDI, are transformable and store translation in their transform matrix
- `NoteElements` is the persisted note container with `elements: Element[]`
- The MIDI plugin keeps backward compatibility in `normalizeMidiElement()` so older saved notes can still load after lane/export/automation changes
