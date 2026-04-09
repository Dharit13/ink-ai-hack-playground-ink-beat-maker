# Drumink: Ink-Based MIDI Step Sequencer
Drumink is a MIDI step sequencer that lives directly inside the canvas. Instead of opening a DAW or reaching for an instrument, you sketch rhythms and hear them loop back immediately!  
The system is designed to capture musical ideas at the speed of thought through an ink-first workflow with lightweight direct controls.  


<img src="drumink-demo.gif" width="400" alt="Drumink Demo GIF"/>


## Demo Video

<a href="https://m.youtube.com/shorts/e3lFg2vJ6oo">
  <img src="https://img.youtube.com/vi/e3lFg2vJ6oo/0.jpg" width="300" alt="Watch the demo" />
</a>

## Live Demo
[Live Demo: Try it yourself!](https://ink-ai-hack-playground-ink-beat-mak.vercel.app/)
## How to Use
1. Open the demo.
2. Draw a square with an X inside on the canvas.
3. When the menu appears, select `Midi`.
4. Tap or draw inside the grid to build your pattern, then use the header controls to change mode, tempo, and export.
5. Tap the play button to start the loop! Resize the block as needed

**Best experienced with a tablet and stylus** (regular touch not guaranteed). Can also play on a computer with a mouse.
## Core Interaction Model
- Drumink uses a mix of ink gestures and direct taps/clicks on visible controls.
- Use the play/pause button to start or stop playback and tempo `-` / `+`, and `TAP TEMPO` in the header to shape how the sequencer behaves.
- 2 different input modes:
  - `TAP` mode: tapping or clicking a step toggles it on and off.
  - `TICK` mode: repeated taps on a step cycle through velocity levels, and taller vertical marks can set stronger hits.
- A horizontal strike-through across a step clears it.
- Add or remove lanes with the lane controls, and tap an instrument label to change that lane's sound.
- Draw below the sequencer to create a volume automation lane, then draw a curve inside it to shape the volume over time.
- Open the export menu with the download button, or by handwriting `dl` / `download` nearby, to export either a `.mid` or `.wav` file with loop count and optional volume automation.
- Changes apply in real time while the loop is playing!
## Features
### Real-Time Sequencing
A playhead sweeps across the grid using Web Audio timing. Edits are reflected instantly without interrupting playback.
### Multi-Lane Drum Programming
- Multiple lanes share a common timeline.
- Each lane maps to a different instrument (kick, snare, hi-hats, etc.).
- Enables rapid layering of percussive elements into cohesive patterns.
### Gesture-Driven Music Creation
- Ink remains the primary input, with lightweight direct controls for playback, tempo, mode switching, lane management, and export.
- Supports both quick taps/clicks and drawn marks inside the grid.
- Designed to feel native to a canvas-based workflow without hiding important controls from new users.
### Visual Dynamics and Automation
- Volume and dynamics can be drawn directly.
- Musical expression is both visible and audible.
- Export supports both MIDI (`.mid`) and rendered audio (`.wav`).  

## Design Philosophy
Drumink explores what happens when musical sequencing is treated as a native canvas interaction rather than a separate tool. It prioritizes speed, intuition, and tactile feedback, allowing users to sketch, hear, and refine musical ideas in a single continuous flow.
 

# For Developers: The Ink Playground
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
