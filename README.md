# Drumink — Ink-Based MIDI Step Sequencer
Drumink is a MIDI step sequencer that lives directly inside the canvas. Instead of opening a DAW or reaching for an instrument, you sketch rhythms and hear them loop back immediately. The system is designed to capture musical ideas at the speed of thought using the same ink gestures used to create elements in the app.
## Demo
[Live Demo : Try it yourself](https://your-vercel-app-url.vercel.app)
## Demo Video
[![Watch the demo](https://img.youtube.com/vi/e3lFg2vJ6oo/0.jpg)](https://m.youtube.com/shorts/e3lFg2vJ6oo)
## How to Use
1. Open the demo.
2. Draw a square with an X inside on the canvas.
3. When the menu appears, select "Midi".
4. Resize the block and begin drawing your pattern.
Best experienced with a tablet and stylus.
## Core Interaction Model
- Draw directly into a time grid to create rhythms.
- Scribble inside a cell to add a note.
- Cross out a cell to erase a note.
- Ink coverage determines velocity, so drawing intensity affects sound.
- Changes apply in real time while the loop is playing.
## Features
### Real-Time Sequencing
A playhead sweeps across the grid using Web Audio timing. Edits are reflected instantly without interrupting playback.
### Multi-Lane Drum Programming
- Multiple lanes share a common timeline.
- Each lane maps to a different instrument (kick, snare, hi-hats, etc.).
- Enables rapid layering of percussive elements into cohesive patterns.
### Gesture-Driven Music Creation
- No traditional UI controls required.
- All interactions are performed through drawing gestures.
- Designed to feel native to a canvas-based workflow.
### Visual Dynamics and Automation
- Volume and dynamics can be drawn directly.
- Musical expression is both visible and audible.
## Design Philosophy
Drumink explores what happens when musical sequencing is treated as a native canvas interaction rather than a separate tool. It prioritizes speed, intuition, and tactile feedback, allowing users to sketch, hear, and refine musical ideas in a single continuous flow.
---
# Ink Playground
React + TypeScript + Vite prototyping app for interactive ink-based elements with handwriting recognition.
## Getting Started
### Prerequisites
- Node.js (v18+)
- npm
### Installation
```bash
npm install
```
### Environment Setup
Copy the example env file and configure:
```bash
cp .env.example .env
```
Required variables:
| Variable | Description | Default |
|----------|-------------|---------|
| `INK_RECOGNITION_API_URL` | Handwriting recognition API endpoint | *(none — must be set)* |
A running instance of the recognition API is required. Set the URL in your `.env` file.
### Git Hooks
Activate the pre-push hook once after cloning (blocks pushing if lint or build fails):
```bash
npm run setup
```
### Running
```bash
npm run dev
npm run build
npm run lint
npm run preview
```
The dev server is exposed on all network interfaces. The terminal output will display a network URL that can be accessed from other devices on the same network.
## How It Works
Draw on the canvas using a pointer device. Strokes are captured, clustered, and sent to the handwriting recognition API. Recognized content is converted into interactive elements such as text, shapes, grids, and custom components like Drumink.
See `docs/New element HOWTO.md` for guidance on adding new element types.
