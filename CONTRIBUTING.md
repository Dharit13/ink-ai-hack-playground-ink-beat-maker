# Contributing to Ink Playground

Thanks for your interest in contributing! This guide will help you get set up and submit your first PR.

## Quick Start

1. **Fork** this repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/ink-playground.git
   cd ink-playground
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Set up git hooks** (one-time — blocks pushing broken builds):
   ```bash
   npm run setup
   ```
5. **Set up environment**:
   ```bash
   cp .env.example .env
   ```
6. **Start the dev server**:
   ```bash
   npm run dev
   ```
   The app will be available at `http://localhost:5173`.

## Making Changes

1. Create a branch from `main`:
   ```bash
   git checkout -b feature/INK-00/your-feature-name
   ```
   Use the appropriate prefix:
   - `feature/INK-00/...` for new features
   - `bug/INK-00/...` for bug fixes
   - `chore/INK-00/...` for maintenance tasks

2. Make your changes and verify:
   ```bash
   npm run lint     # Check for lint errors
   npm run build    # Ensure it compiles
   ```
   Both checks also run automatically as a pre-push hook (requires `npm run setup` after cloning). Use `git push --no-verify` to bypass in emergencies.

3. Commit with a descriptive message:
   ```bash
   git commit -m "INK-00: Add your change description"
   ```

4. Push your branch and open a PR against `main`.

## Adding a New Element Type

Ink Playground uses a plugin-based element system. See `docs/New element HOWTO.md` for a step-by-step guide on creating new interactive elements (games, visualizations, tools, etc.).

## Project Structure

| Directory | Purpose |
|-----------|---------|
| `src/canvas/` | Core canvas rendering and viewport management |
| `src/elements/` | Element plugins (renderers, creators, interactions) |
| `src/input/` | Pointer event handling and stroke building |
| `src/recognition/` | Handwriting recognition API client |
| `src/eraser/` | Eraser tool and scribble detection |
| `src/state/` | Undo/redo state management |
| `src/types/` | TypeScript interfaces for the data model |

## Code Style

- TypeScript strict mode is enabled
- Run `npm run lint` before submitting
- Keep changes focused — one feature or fix per PR

## Need Help?

Open an issue if you run into problems getting set up or have questions about the codebase.
