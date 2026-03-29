import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { InkCanvas } from './canvas/InkCanvas';
import type { Tool } from './canvas/InkCanvas';
import type { Viewport } from './canvas/ViewportManager';

import type { NoteElements, Stroke, Element } from './types';
import { createEmptyNote, supportsBackgroundColor, getElementStrokeColor, getElementBackgroundColor, setElementStrokeColor, setElementBackgroundColor } from './types';
import { generateId, IDENTITY_MATRIX } from './types/primitives';
import { createStrokeElement } from './elements/stroke/types';
import type { ShapeElement } from './elements/shape/types';
import { createSketchableImageElement } from './elements/sketchableimage/types';
import { useUndoRedo, useUndoRedoKeyboard } from './state/useUndoRedo';
import { getMostRecentCluster } from './recognition/StrokeClustering';
// Import element plugins (auto-registers all plugins)
import { tryCreateElement, tryInteraction, tryCreateElementWithDisambiguation, getPlugin } from './elements';
import { createDisambiguationIntent } from './disambiguation';
import type { DisambiguationIntent, DisambiguationAction, DisambiguationCandidate } from './disambiguation';
import { beautifyShape, extractFeatures } from './geometry/shapeRecognition';
import { colorToHex } from './types/brush';
import { hexToArgb } from './input/StrokeBuilder';
import type { ShapeType } from './geometry/shapeRecognition';
import { debugLog, logElementCreated, logElementMutated, logElementDeleted } from './debug/DebugLogger';
import { isMultiStrokeScribbleEraseGesture, getMultiStrokePoints } from './eraser/scribbleDetection';
import { performScribbleErase } from './eraser/ScribbleEraser';
import { findElementsInLasso, getStrokePoints, createSelectionIntent } from './lasso';
import type { SelectionIntent } from './lasso';
import { useSketchableImageGeneration } from './hooks/useSketchableImageGeneration';
import type { RefinementMode } from './hooks/useSketchableImageGeneration';
import { useNonogramGeneration } from './hooks/useNonogramGeneration';
import { useJigsawGeneration } from './hooks/useJigsawGeneration';
import { useColorConnectGeneration } from './hooks/useColorConnectGeneration';
import { STYLE_PRESETS, DEFAULT_STYLE_PRESET } from './services/stylePresets';
import type { StylePresetKey } from './services/stylePresets';
import { detectRectangleX, lastRectXRejection, type RectangleXResult } from './geometry/rectangleXDetection';
import { createPaletteIntent } from './palette';
import type { PaletteIntent, PaletteAction } from './palette';
import { Toaster } from './toast/Toast';
import './App.css';



// Animation duration in milliseconds
const STROKE_ANIMATION_DURATION = 500;

// Debounce delay for collecting strokes before processing
const STROKE_DEBOUNCE_MS = 650;

// Filter out StrokeElements whose strokes have been consumed by another element
function removeConsumedStrokeElements(elements: Element[], consumedStrokes: Set<Stroke>): Element[] {
  return elements.filter(element => {
    if (element.type !== 'stroke') return true;
    // Remove if ALL strokes in this element are consumed
    return !element.strokes.every(stroke => consumedStrokes.has(stroke));
  });
}

const STORAGE_KEY = 'ink-playground-note';
const VIEWPORT_STORAGE_KEY = 'ink-playground-viewport';

function loadSavedNote(): NoteElements {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && Array.isArray(parsed.elements)) return parsed as NoteElements;
    }
  } catch { /* ignore */ }
  return { elements: [] };
}

function loadSavedViewport(): Viewport | undefined {
  try {
    const saved = localStorage.getItem(VIEWPORT_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed.panX === 'number' && typeof parsed.panY === 'number' && typeof parsed.zoom === 'number') {
        return parsed as Viewport;
      }
    }
  } catch { /* ignore */ }
  return undefined;
}

function App() {
  const {
    current: currentNote,
    set: setCurrentNote,
    undo: undoBase,
    redo: redoBase,
    canUndo,
    canRedo,
    reset: resetNote,
  } = useUndoRedo<NoteElements>(loadSavedNote());

  const [stylePreset, setStylePreset] = useState<StylePresetKey>(DEFAULT_STYLE_PRESET);
  const [refinementMode, setRefinementMode] = useState<RefinementMode>('twoImage');

  useSketchableImageGeneration(currentNote, setCurrentNote, stylePreset, refinementMode);
  useNonogramGeneration(currentNote, setCurrentNote);
  useJigsawGeneration(currentNote, setCurrentNote);
  useColorConnectGeneration(currentNote, setCurrentNote);

  // Ref to always access the latest note state from async callbacks (avoids stale closures)
  const currentNoteRef = useRef(currentNote);
  currentNoteRef.current = currentNote;

  // Track pending strokes for element creation (strokes not yet assigned to elements)
  const pendingStrokesRef = useRef<Stroke[]>([]);

  // Debounce buffer: collect strokes during debounce window before processing
  const strokeBufferRef = useRef<Stroke[]>([]);
  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track elements with active stroke animations (element ID -> animation start time)
  const [animatingElements, setAnimatingElements] = useState<Map<string, number>>(new Map());

  // Track selected elements
  const [selectedElementIds, setSelectedElementIds] = useState<Set<string>>(new Set());

  // Track lasso selection intent (pending lasso selection with menu)
  const [selectionIntent, setSelectionIntent] = useState<SelectionIntent | null>(null);

  // Track disambiguation intent (pending shape disambiguation with menu)
  const [disambiguationIntent, setDisambiguationIntent] = useState<DisambiguationIntent | null>(null);

  // Track palette intent (pending palette menu from rectangle+X gesture)
  const [paletteIntent, setPaletteIntent] = useState<PaletteIntent | null>(null);

  // Track strokes to clear from overlay (for synchronized scribble erase)
  const [strokesToClearFromOverlay, setStrokesToClearFromOverlay] = useState<{ strokes: Stroke[]; requestId: number } | null>(null);

  // Start animation for newly created elements
  const startElementAnimation = useCallback((elementIds: string[]) => {
    const now = performance.now();
    setAnimatingElements(prev => {
      const next = new Map(prev);
      for (const id of elementIds) {
        next.set(id, now);
      }
      return next;
    });
  }, []);

  // Handle animation completion (called from InkCanvas)
  const handleAnimationComplete = useCallback((elementId: string) => {
    setAnimatingElements(prev => {
      const next = new Map(prev);
      next.delete(elementId);
      return next;
    });
  }, []);

  // Handle selection change from InkCanvas
  const handleSelectionChange = useCallback((newSelection: Set<string>) => {
    setSelectedElementIds(newSelection);
  }, []);

  // Handle moving selected elements
  const handleElementsMove = useCallback((elementIds: Set<string>, dx: number, dy: number) => {
    if (elementIds.size === 0 || (dx === 0 && dy === 0)) return;

    const note = currentNoteRef.current;
    setCurrentNote({
      ...note,
      elements: note.elements.map(element => {
        if (!elementIds.has(element.id)) return element;

        if (element.type === 'stroke') {
          // Move stroke by translating all input points
          return {
            ...element,
            strokes: element.strokes.map(stroke => ({
              ...stroke,
              inputs: {
                ...stroke.inputs,
                inputs: stroke.inputs.inputs.map(input => ({
                  ...input,
                  x: input.x + dx,
                  y: input.y + dy,
                })),
              },
            })),
          };
        } else {
          // Move transformable element by updating transform translation
          // This works for all transformed elements including CoordinatePlane
          const values = [...element.transform.values] as [number, number, number, number, number, number, number, number, number];
          values[6] += dx; // transX
          values[7] += dy; // transY
          return {
            ...element,
            transform: { values },
          };
        }
      }),
    });
  }, [setCurrentNote]);

  // Wrap undo/redo to clear pending strokes, debounce buffer, selection, and intents
  const undo = useCallback(() => {
    pendingStrokesRef.current = [];
    strokeBufferRef.current = [];
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
      debounceTimeoutRef.current = null;
    }
    setSelectedElementIds(new Set());
    setSelectionIntent(null);
    setDisambiguationIntent(null);
    setPaletteIntent(null);
    undoBase();
  }, [undoBase]);

  const redo = useCallback(() => {
    pendingStrokesRef.current = [];
    strokeBufferRef.current = [];
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
      debounceTimeoutRef.current = null;
    }
    setSelectedElementIds(new Set());
    setSelectionIntent(null);
    setDisambiguationIntent(null);
    setPaletteIntent(null);
    redoBase();
  }, [redoBase]);

  const [showDebug, setShowDebug] = useState(false);
  const [currentTool, setCurrentTool] = useState<Tool>('pen');
  const [brushColor, setBrushColor] = useState('#000000');
  const [brushSize, setBrushSize] = useState(3);

  // Compute colors from selected elements
  const selectedElements = useMemo(() => {
    return currentNote.elements.filter(el => selectedElementIds.has(el.id));
  }, [currentNote.elements, selectedElementIds]);

  const hasSelectedSketchImage = selectedElements.some(el => el.type === 'sketchableImage');

  const selectionStrokeColor = useMemo((): number | 'mixed' | undefined => {
    if (selectedElements.length === 0) return undefined;
    const colors = selectedElements.map(getElementStrokeColor);
    const firstDefined = colors.find(c => c !== undefined);
    if (firstDefined === undefined) return undefined;
    const allSame = colors.every(c => c === firstDefined);
    return allSame ? firstDefined : 'mixed';
  }, [selectedElements]);

  const selectionBackgroundColor = useMemo((): number | 'mixed' | undefined => {
    if (selectedElements.length === 0) return undefined;
    const supportsBackground = selectedElements.filter(supportsBackgroundColor);
    if (supportsBackground.length === 0) return undefined;
    const colors = supportsBackground.map(getElementBackgroundColor);
    const firstDefined = colors.find(c => c !== undefined);
    const allSame = colors.every(c => c === firstDefined);
    return allSame ? firstDefined : 'mixed';
  }, [selectedElements]);

  const backgroundColorEnabled = useMemo(() => {
    return selectedElements.length > 0 && selectedElements.every(supportsBackgroundColor);
  }, [selectedElements]);

  // Drawing controls (stroke color, brush size) are enabled when pen tool is active or elements are selected
  const drawingControlsEnabled = currentTool === 'pen' || selectedElements.length > 0;

  // Enable keyboard shortcuts for undo/redo
  useUndoRedoKeyboard(undo, redo);

  // Handle keyboard shortcuts for tools
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'p':
          setCurrentTool('pen');
          break;
        case 'e':
          setCurrentTool('eraser');
          break;
        case 'h':
          setCurrentTool('pan');
          break;
        case 's':
          setCurrentTool('select');
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Handle stroke color change (from color picker)
  const handleStrokeColorChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newHexColor = e.target.value;
    setBrushColor(newHexColor);

    // Update selected elements if any
    if (selectedElementIds.size > 0) {
      const argbColor = hexToArgb(newHexColor);
      setCurrentNote({
        ...currentNote,
        elements: currentNote.elements.map(element => {
          if (!selectedElementIds.has(element.id)) return element;
          return setElementStrokeColor(element, argbColor);
        }),
      });
    }
  }, [selectedElementIds, currentNote, setCurrentNote]);

  // Handle background color change
  const handleBackgroundColorChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newHexColor = e.target.value;
    const argbColor = hexToArgb(newHexColor);

    setCurrentNote({
      ...currentNote,
      elements: currentNote.elements.map(element => {
        if (!selectedElementIds.has(element.id)) return element;
        return setElementBackgroundColor(element, argbColor);
      }),
    });
  }, [selectedElementIds, currentNote, setCurrentNote]);

  // Viewport state for persistence
  const [savedViewport] = useState<Viewport | undefined>(loadSavedViewport);
  const viewportRef = useRef<Viewport | undefined>(savedViewport);
  const viewportSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleViewportChange = useCallback((v: Viewport) => {
    viewportRef.current = v;
    // Debounced save for viewport-only changes (pan/zoom without drawing)
    if (viewportSaveTimeoutRef.current) clearTimeout(viewportSaveTimeoutRef.current);
    viewportSaveTimeoutRef.current = setTimeout(() => {
      try { localStorage.setItem(VIEWPORT_STORAGE_KEY, JSON.stringify(v)); } catch { /* ignore */ }
    }, 1000);
  }, []);

  // Clean up viewport save timeout on unmount
  useEffect(() => {
    return () => {
      if (viewportSaveTimeoutRef.current) clearTimeout(viewportSaveTimeoutRef.current);
    };
  }, []);

  // Auto-save note + viewport to localStorage with debounce
  const autoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
    }
    autoSaveTimeoutRef.current = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(currentNote));
        if (viewportRef.current) {
          localStorage.setItem(VIEWPORT_STORAGE_KEY, JSON.stringify(viewportRef.current));
        }
      } catch {
        // localStorage full or unavailable — silently ignore
      }
    }, 1000);
    return () => {
      if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
    };
  }, [currentNote]);

  // Handle new note
  const handleNewNote = useCallback(() => {
    resetNote(createEmptyNote());
    pendingStrokesRef.current = []; // Clear pending strokes when creating new note
    strokeBufferRef.current = [];
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
      debounceTimeoutRef.current = null;
    }
    setSelectedElementIds(new Set()); // Clear selection when creating new note
    setSelectionIntent(null); // Clear lasso selection intent
    setDisambiguationIntent(null); // Clear disambiguation intent
    setPaletteIntent(null); // Clear palette intent
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(VIEWPORT_STORAGE_KEY);
    debugLog.action('Created new note');
  }, [resetNote]);

  /*
   * TODO: Uses screen coordinates, not canvas coordinates. When the viewport
   * is panned/zoomed, the element won't appear at the visible center.
   * Convert via ViewportManager.screenToCanvas() once exposed.
   */
  const handleAddSketchableImage = useCallback(() => {
    const note = currentNoteRef.current;
    const centerX = Math.max(0, window.innerWidth / 2 - 256 - 300);
    const centerY = Math.max(0, window.innerHeight / 2 - 256 - 400);
    const element = createSketchableImageElement(centerX, centerY);
    setCurrentNote({
      ...note,
      elements: [...note.elements, element],
    });
    setSelectedElementIds(new Set([element.id]));
  }, [setCurrentNote]);

  // Process a batch of strokes (after debounce window)
  const processStrokes = useCallback(async (strokes: Stroke[]) => {
    if (strokes.length === 0) return;

    debugLog.info('Processing stroke batch', { count: strokes.length });

    // Log what elements are on the canvas for debugging
    const elementTypes = currentNoteRef.current.elements.map(e => e.type);
    const hasMidi = elementTypes.includes('midi');
    debugLog.info('tryInteraction: elements on canvas', { elementTypes, hasMidi, elementCount: elementTypes.length });

    // First, check if any existing interactive element wants these strokes
    const interactionResult = await tryInteraction(currentNoteRef.current.elements, strokes);
    if (interactionResult) {
      const { elementId, result } = interactionResult;
      const element = currentNoteRef.current.elements.find(e => e.id === elementId);
      logElementMutated(element?.type ?? 'unknown', elementId, 'Interaction consumed strokes');
      // Clear consumed strokes from overlay (they won't become part of any element)
      if (result.strokesConsumed.length > 0) {
        setStrokesToClearFromOverlay({ strokes: result.strokesConsumed, requestId: Date.now() });
      }
      // Update the element in place
      setCurrentNote({
        ...currentNoteRef.current,
        elements: currentNoteRef.current.elements.map((el) =>
          el.id === elementId ? result.element : el
        ),
      });
      // Auto-select the element that consumed the strokes
      setSelectedElementIds(new Set([elementId]));
      return;
    }

    // Add all strokes to pending strokes for potential element creation
    pendingStrokesRef.current = [...pendingStrokesRef.current, ...strokes];

    // Check for rectangle+X palette gesture before element creation
    debugLog.info('processStrokes called', { pendingCount: pendingStrokesRef.current.length, newStrokes: strokes.length });
    let rectXRejection = 'not enough strokes';
    if (pendingStrokesRef.current.length >= 3) {
      debugLog.info('Attempting rectangle+X detection', { pendingCount: pendingStrokesRef.current.length });
      let rectXResult: RectangleXResult | null = null;
      for (let windowSize = 3; windowSize <= Math.min(6, pendingStrokesRef.current.length); windowSize++) {
        const window = pendingStrokesRef.current.slice(-windowSize);
        rectXResult = detectRectangleX(window);
        if (rectXResult) break;
      }
      rectXRejection = rectXResult ? '' : lastRectXRejection;
      if (rectXResult) {
        debugLog.info('Rectangle+X gesture detected', {
          rectStrokes: rectXResult.rectangleStrokes.length,
          totalStrokes: rectXResult.allStrokes.length,
        });

        const intent = createPaletteIntent(rectXResult);
        if (intent.entries.length > 0) {
          setPaletteIntent(intent);

          /* Add strokes as temporary StrokeElement (visible while menu shown) */
          const strokeElement = createStrokeElement(rectXResult.allStrokes);
          setCurrentNote({
            ...currentNoteRef.current,
            elements: [...currentNoteRef.current.elements, strokeElement],
          });

          /* Remove from pending */
          const consumedSet = new Set(rectXResult.allStrokes);
          pendingStrokesRef.current = pendingStrokesRef.current.filter(
            s => !consumedSet.has(s)
          );
          return;
        }
      }
    }

    // Try to create a new element from pending strokes with cross-type disambiguation
    if (pendingStrokesRef.current.length >= 1) {
      debugLog.info('Attempting element creation with disambiguation', { pendingStrokes: pendingStrokesRef.current.length });
      const recentStrokes = pendingStrokesRef.current.slice(-3); // Check last 1-3 strokes
      try {
        const disambigResult = await tryCreateElementWithDisambiguation(
          recentStrokes,
          {
            existingElements: currentNoteRef.current.elements,
            canvasWidth: 1000,
            canvasHeight: 1000,
          }
        );

        debugLog.info('Disambiguation result', {
          hasResult: !!disambigResult.result,
          bestElementType: disambigResult.result?.elements[0]?.type,
          bestConfidence: disambigResult.result?.confidence?.toFixed(2),
          needsDisambiguation: disambigResult.needsDisambiguation,
          candidateCount: disambigResult.candidates?.length ?? 0,
        });

        if (disambigResult.result && disambigResult.result.elements.length > 0) {
          const result = disambigResult.result;

          // Check if disambiguation is needed (cross-type or within-type)
          if (disambigResult.needsDisambiguation && disambigResult.candidates) {
            debugLog.info('Cross-type disambiguation needed', {
              candidateCount: disambigResult.candidates.length,
              candidates: disambigResult.candidates.map(c => `${c.elementType}:${c.label}(${c.confidence.toFixed(2)})`),
            });

            // Create disambiguation intent - strokes stay on overlay until user decides
            const intent = createDisambiguationIntent(disambigResult.candidates, result.consumedStrokes);
            setDisambiguationIntent(intent);

            // Don't remove strokes from pending yet - wait for user decision
            // But add them to noteElements as a stroke element so they're visible
            const strokeElement = createStrokeElement(result.consumedStrokes);
            setCurrentNote({
              ...currentNoteRef.current,
              elements: [...currentNoteRef.current.elements, strokeElement],
            });

            // Remove from pending since they're now in the stroke element
            const consumedSet = new Set(result.consumedStrokes);
            pendingStrokesRef.current = pendingStrokesRef.current.filter(
              (s) => !consumedSet.has(s)
            );

            return;
          }

          // No disambiguation needed - proceed normally
          // Remove consumed strokes from pending
          const consumedSet = new Set(result.consumedStrokes);
          pendingStrokesRef.current = pendingStrokesRef.current.filter(
            (s) => !consumedSet.has(s)
          );

          // Log element creation
          for (const el of result.elements) {
            logElementCreated(el.type, el.id, `confidence: ${result.confidence.toFixed(2)}`);
          }

          // Start stroke thickness animation for newly created elements
          startElementAnimation(result.elements.map(el => el.id));

          // Remove StrokeElements whose strokes were consumed, then add the new elements
          const latestElements = currentNoteRef.current.elements;
          const consumedIds = result.consumedElementIds ? new Set(result.consumedElementIds) : null;
          const surviving = removeConsumedStrokeElements(latestElements, consumedSet)
            .filter((el) => !consumedIds || !consumedIds.has(el.id));
          setCurrentNote({
            ...currentNoteRef.current,
            elements: [...surviving, ...result.elements],
          });
          return;
        }
      } catch (err) {
        debugLog.error('Element creation error', err);
      }
    }

    // Try with TicTacToe threshold (4 strokes)
    if (pendingStrokesRef.current.length >= 4) {
      const cluster = getMostRecentCluster(pendingStrokesRef.current, {
        spatialThreshold: 150,
        temporalThreshold: 10000,
        minStrokes: 4,
      });

      if (cluster && cluster.strokes.length >= 4) {
        try {
          const result = await tryCreateElement(
            cluster.strokes,
            {
              existingElements: currentNoteRef.current.elements,
              canvasWidth: 1000,
              canvasHeight: 1000,
            }
          );

          if (result && result.elements.length > 0) {
            // Remove consumed strokes from pending
            const consumedSet = new Set(result.consumedStrokes);
            pendingStrokesRef.current = pendingStrokesRef.current.filter(
              (s) => !consumedSet.has(s)
            );

            // Log element creation
            for (const el of result.elements) {
              logElementCreated(el.type, el.id, `confidence: ${result.confidence.toFixed(2)}`);
            }

            // Start stroke thickness animation for newly created elements
            startElementAnimation(result.elements.map(el => el.id));

            // Remove StrokeElements whose strokes were consumed, then add the new elements
            const latestElements = currentNoteRef.current.elements;
            setCurrentNote({
              ...currentNoteRef.current,
              elements: [...removeConsumedStrokeElements(latestElements, consumedSet), ...result.elements],
            });
            return;
          }
        } catch (err) {
          debugLog.error('Element creation error', err);
        }
      }
    }

    // Try InkText creation with lower threshold (2+ strokes for meaningful text)
    if (pendingStrokesRef.current.length >= 2) {
      debugLog.info('Attempting InkText clustering', { pendingStrokes: pendingStrokesRef.current.length });
      const cluster = getMostRecentCluster(pendingStrokesRef.current, {
        spatialThreshold: 150,
        temporalThreshold: 5000, // Shorter timeout for text
        minStrokes: 2,
      });

      if (cluster && cluster.strokes.length >= 2) {
        debugLog.info('Cluster found', { strokeCount: cluster.strokes.length });
        try {
          const result = await tryCreateElement(
            cluster.strokes,
            {
              existingElements: currentNoteRef.current.elements,
              canvasWidth: 1000,
              canvasHeight: 1000,
            }
          );

          if (result && result.elements.length > 0) {
            // Remove consumed strokes from pending
            const consumedSet = new Set(result.consumedStrokes);
            pendingStrokesRef.current = pendingStrokesRef.current.filter(
              (s) => !consumedSet.has(s)
            );

            // Log element creation
            for (const el of result.elements) {
              logElementCreated(el.type, el.id, `confidence: ${result.confidence.toFixed(2)}`);
            }

            // Start stroke thickness animation for newly created elements
            startElementAnimation(result.elements.map(el => el.id));

            // Remove StrokeElements whose strokes were consumed, then add the new elements
            const latestElements = currentNoteRef.current.elements;
            setCurrentNote({
              ...currentNoteRef.current,
              elements: [...removeConsumedStrokeElements(latestElements, consumedSet), ...result.elements],
            });
            return;
          } else {
            debugLog.warn('InkText creation returned no result');
          }
        } catch (err) {
          debugLog.error('InkText creation error', err);
        }
      } else {
        debugLog.warn('No valid cluster found for InkText', { pendingStrokes: pendingStrokesRef.current.length });
      }
    }

    // Default: add all strokes as a single stroke element
    // Note: strokes intentionally stay in pendingStrokesRef so they can be
    // reconsidered for multi-stroke shape detection when more strokes arrive
    if (rectXRejection) {
      debugLog.warn('RectX detection failed', { reason: rectXRejection, pendingStrokes: pendingStrokesRef.current.length });
    }
    const strokeElement = createStrokeElement(strokes);
    debugLog.info('Added stroke element', { id: strokeElement.id.slice(0, 8), strokeCount: strokes.length });
    setCurrentNote({
      ...currentNoteRef.current,
      elements: [...currentNoteRef.current.elements, strokeElement],
    });
  }, [setCurrentNote, startElementAnimation]);

  // Debounced stroke handler - collects strokes and processes them after debounce window
  const handleDrawingStart = useCallback(() => {
    if (debounceTimeoutRef.current) {
      debugLog.info('Pen down — cancelling debounce timer (strokes held for next batch)');
      clearTimeout(debounceTimeoutRef.current);
      debounceTimeoutRef.current = null;
    } else {
      debugLog.info('Pen down — no active debounce timer');
    }
  }, []);

  const handleStrokeComplete = useCallback(async (stroke: Stroke) => {
    debugLog.info('Stroke completed', { points: stroke.inputs.inputs.length });

    // Try immediate interaction with elements that opt in (bypass debounce for responsiveness)
    const immediateResult = await tryInteraction(currentNoteRef.current.elements, [stroke], undefined, /* isEagerInteraction */ true);
    if (immediateResult) {
      const { elementId, result } = immediateResult;
      debugLog.info('Immediate interaction consumed stroke', { elementId: elementId.slice(0, 8) });
      if (result.strokesConsumed.length > 0) {
        setStrokesToClearFromOverlay({ strokes: result.strokesConsumed, requestId: Date.now() });
      }
      setCurrentNote({
        ...currentNoteRef.current,
        elements: currentNoteRef.current.elements.map((el) =>
          el.id === elementId ? result.element : el
        ),
      });
      // Auto-select the element that consumed the stroke
      setSelectedElementIds(new Set([elementId]));
      return;
    }

    // Add stroke to buffer
    strokeBufferRef.current = [...strokeBufferRef.current, stroke];

    // Clear any existing timeout
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    // Set new timeout to process buffered strokes
    debugLog.info('Debounce timer started', { bufferSize: strokeBufferRef.current.length, delayMs: STROKE_DEBOUNCE_MS });
    debounceTimeoutRef.current = setTimeout(() => {
      const strokesToProcess = strokeBufferRef.current;
      strokeBufferRef.current = [];
      debounceTimeoutRef.current = null;
      debugLog.info('Debounce timer FIRED — processing strokes', { count: strokesToProcess.length });

      // Check for scribble erase gesture BEFORE element assignment
      // This allows quick sequences of strokes (with brief stylus lifts) to qualify as scribble erase
      const latestElements = currentNoteRef.current.elements;
      if (isMultiStrokeScribbleEraseGesture(strokesToProcess, latestElements)) {
        debugLog.info('Scribble erase detected (post-debounce)', { strokeCount: strokesToProcess.length });
        const scribblePoints = getMultiStrokePoints(strokesToProcess);
        const result = performScribbleErase(currentNoteRef.current.elements, scribblePoints);
        if (result.success) {
          // Log deleted elements
          for (const elementId of result.removedElementIds) {
            const el = currentNoteRef.current.elements.find(e => e.id === elementId);
            if (el) {
              logElementDeleted(el.type, el.id);
            }
          }
          // Log modified elements (partial erasure)
          for (const modifiedEl of result.modifiedElements) {
            logElementMutated(modifiedEl.type, modifiedEl.id, 'Partial token erasure');
          }
          // Clear the scribble strokes from overlay synchronously with element removal
          // This prevents the scribble stroke from lingering after erased content disappears
          setStrokesToClearFromOverlay({ strokes: strokesToProcess, requestId: Date.now() });
          setCurrentNote({
            ...currentNoteRef.current,
            elements: result.remainingElements,
          });
        }
        return; // Don't process these strokes for element creation
      }

      // Check for lasso selection gesture (typically a single closed stroke)
      // Only check if there's a single stroke and there are elements to select
      debugLog.info('Lasso check preconditions', {
        strokeCount: strokesToProcess.length,
        elementCount: latestElements.length,
        willCheck: strokesToProcess.length === 1 && latestElements.length > 0
      });

      if (strokesToProcess.length === 1 && latestElements.length > 0) {
        const lassoStroke = strokesToProcess[0];
        const lassoPoints = getStrokePoints(lassoStroke);

        debugLog.info('Attempting lasso detection', {
          strokePointCount: lassoPoints.length,
          elementsToSelect: latestElements.length
        });

        // Try to find elements in the lasso
        const lassoResult = findElementsInLasso(
          lassoPoints,
          latestElements,
          lassoStroke
        );

        if (lassoResult.isValid && lassoResult.selectedElements.length > 0) {
          debugLog.info('Lasso selection SUCCESS', {
            selectedCount: lassoResult.selectedElements.length,
            polygon: lassoResult.selectionPolygon.length,
          });

          // Create the lasso stroke as a content element first
          // This allows undo to bring back the stroke naturally
          const lassoElement = createStrokeElement(strokesToProcess);
          setCurrentNote({
            ...currentNoteRef.current,
            elements: [...currentNoteRef.current.elements, lassoElement],
          });

          // Create selection intent with the element ID
          const intent = createSelectionIntent(
            strokesToProcess,
            lassoElement.id,
            lassoResult.selectionPolygon,
            lassoResult.selectedElements,
            lassoResult.selectionBounds
          );
          setSelectionIntent(intent);

          // Don't process this stroke further
          return;
        } else {
          debugLog.info('Lasso selection FAILED', {
            isValid: lassoResult.isValid,
            selectedCount: lassoResult.selectedElements.length,
            reason: !lassoResult.isValid ? 'invalid lasso shape' : 'no elements selected'
          });
        }
      }

      processStrokes(strokesToProcess);
    }, STROKE_DEBOUNCE_MS);
  }, [processStrokes, setCurrentNote]);

  // Handle elements change (for eraser)
  const handleElementsChange = useCallback((elements: Element[]) => {
    // Log deleted elements
    const deletedCount = currentNote.elements.length - elements.length;
    if (deletedCount > 0) {
      const remainingIds = new Set(elements.map(e => e.id));
      for (const el of currentNote.elements) {
        if (!remainingIds.has(el.id)) {
          logElementDeleted(el.type, el.id);
        }
      }
    }

    setCurrentNote({
      ...currentNote,
      elements,
    });
  }, [currentNote, setCurrentNote]);

  // Handle disambiguation action (user selected an element type or dismissed)
  const handleDisambiguationAction = useCallback(async (
    action: DisambiguationAction,
    selectedCandidate?: DisambiguationCandidate
  ) => {
    if (!disambiguationIntent) return;

    if (action === 'select' && selectedCandidate) {
      debugLog.info('Disambiguation: user selected', {
        elementType: selectedCandidate.elementType,
        shapeType: selectedCandidate.shapeType,
        label: selectedCandidate.label,
      });

      // Get the pending strokes from the intent
      const strokes = disambiguationIntent.pendingStrokes;

      // Find and remove the stroke element that contains the pending strokes
      // (it was added when disambiguation started)
      const strokeSet = new Set(strokes);
      const remainingElements = currentNote.elements.filter(el => {
        if (el.type !== 'stroke') return true;
        // Check if this stroke element contains any of the pending strokes
        return !el.strokes.some(s => strokeSet.has(s));
      });

      // Dispatch based on element type
      if (selectedCandidate.elementType === 'shape' && selectedCandidate.shapeType) {
        // Shape: use existing beautifyShape logic
        const features = extractFeatures(strokes);
        if (features) {
          // Get stroke style from original strokes
          const brush = strokes[0]?.brush ?? { color: 0xff000000, size: 2 };
          const strokeColor = brush.color;
          const strokeWidth = brush.size;

          // Beautify shape with the selected type
          const shapePath = beautifyShape(
            selectedCandidate.shapeType as ShapeType,
            features,
            strokeColor,
            strokeWidth
          );

          // Create the shape element
          const shapeElement: ShapeElement = {
            type: 'shape',
            id: generateId(),
            transform: IDENTITY_MATRIX,
            paths: [shapePath],
            sourceStrokes: strokes,
          };

          // Add the new shape element
          logElementCreated('shape', shapeElement.id, `selected: ${selectedCandidate.label}`);
          startElementAnimation([shapeElement.id]);

          setCurrentNote({
            ...currentNote,
            elements: [...remainingElements, shapeElement],
          });
        }
      } else {
        // Non-shape element types: use the plugin's createFromInk
        const plugin = getPlugin(selectedCandidate.elementType);
        if (plugin && plugin.createFromInk) {
          try {
            const result = await plugin.createFromInk(strokes, {
              existingElements: remainingElements,
              canvasWidth: 1000,
              canvasHeight: 1000,
            });

            if (result && result.elements.length > 0) {
              // Log and animate new elements
              for (const el of result.elements) {
                logElementCreated(el.type, el.id, `selected: ${selectedCandidate.label}`);
              }
              startElementAnimation(result.elements.map(el => el.id));

              setCurrentNote({
                ...currentNote,
                elements: [...remainingElements, ...result.elements],
              });
            } else {
              debugLog.warn('Disambiguation: plugin returned no elements', {
                elementType: selectedCandidate.elementType,
              });
              // Restore strokes as fallback
              setCurrentNote({
                ...currentNote,
                elements: remainingElements,
              });
            }
          } catch (error) {
            debugLog.error('Disambiguation: plugin createFromInk failed', error);
            // Restore strokes as fallback
            setCurrentNote({
              ...currentNote,
              elements: remainingElements,
            });
          }
        } else {
          debugLog.warn('Disambiguation: no plugin found for element type', {
            elementType: selectedCandidate.elementType,
          });
        }
      }
    } else {
      // Dismiss: keep strokes as-is (they're already in the note as a stroke element)
      debugLog.info('Disambiguation: dismissed, keeping strokes');
    }

    // Clear the disambiguation intent
    setDisambiguationIntent(null);
  }, [disambiguationIntent, currentNote, setCurrentNote, startElementAnimation]);

  // Handle palette action (user selected an entry or dismissed)
  // Uses currentNoteRef to avoid stale closure when onSelect awaits (e.g. file picker)
  const handlePaletteAction = useCallback(async (
    action: PaletteAction,
    entryId?: string
  ) => {
    if (!paletteIntent) return;

    if (action === 'select' && entryId) {
      const entry = paletteIntent.entries.find(e => e.id === entryId);
      if (!entry) {
        setPaletteIntent(null);
        return;
      }

      debugLog.info('Palette: user selected', { entryId, label: entry.label });

      let consumed = false;
      const consumedElementIds: string[] = [];
      const consumeStrokes = (...elementIds: string[]) => {
        consumed = true;
        consumedElementIds.push(...elementIds);
      };

      const newElement = await entry.onSelect(
        paletteIntent.rectangleBounds,
        consumeStrokes,
        { elements: currentNoteRef.current.elements, gestureStrokes: paletteIntent.pendingStrokes },
      );

      /* Read latest note AFTER await to avoid stale closure */
      const latestNote = currentNoteRef.current;

      /* Find and remove the temp stroke element that holds the gesture strokes */
      const gestureStrokeSet = new Set(paletteIntent.pendingStrokes);
      const consumedIdSet = new Set(consumedElementIds);
      const remainingElements = latestNote.elements.filter(el => {
        // Remove elements explicitly consumed by onSelect
        if (consumedIdSet.has(el.id)) return false;
        if (el.type !== 'stroke') return true;
        return !el.strokes.some(s => gestureStrokeSet.has(s));
      });

      if (newElement && consumed) {
        logElementCreated(newElement.type, newElement.id, `palette: ${entry.label}`);
        startElementAnimation([newElement.id]);
        setCurrentNote({
          ...latestNote,
          elements: [...remainingElements, newElement],
        });
      } else if (consumed) {
        /* onSelect consumed strokes but returned null — remove gesture strokes */
        debugLog.warn('Palette: entry consumed strokes but returned no element');
        setCurrentNote({
          ...latestNote,
          elements: remainingElements,
        });
      }
      /* If !consumed: strokes remain as a StrokeElement already in the note */
    } else {
      debugLog.info('Palette: dismissed, keeping strokes');
    }

    setPaletteIntent(null);
  }, [paletteIntent, setCurrentNote, startElementAnimation]);

  return (
    <div className="app">
      <div className="canvas-container">
        <InkCanvas
          noteElements={currentNote}
          showDebugOverlay={showDebug}
          currentTool={currentTool}
          brushColor={brushColor}
          brushSize={brushSize}
          onStrokeComplete={handleStrokeComplete}
          onDrawingStart={handleDrawingStart}
          onElementsChange={handleElementsChange}
          initialViewport={savedViewport}
          onViewportChange={handleViewportChange}
          animatingElements={animatingElements}
          animationDuration={STROKE_ANIMATION_DURATION}
          onAnimationComplete={handleAnimationComplete}
          selectedElementIds={selectedElementIds}
          onSelectionChange={handleSelectionChange}
          onElementsMove={handleElementsMove}
          selectionIntent={selectionIntent}
          onSelectionIntentChange={setSelectionIntent}
          disambiguationIntent={disambiguationIntent}
          onDisambiguationAction={handleDisambiguationAction}
          paletteIntent={paletteIntent}
          onPaletteAction={handlePaletteAction}
          strokesToClearFromOverlay={strokesToClearFromOverlay}
        />
      </div>

      <header className="toolbar">
        <h1>Ink Playground</h1>

        <div className="toolbar-divider" />

        <div className="toolbar-section tool-buttons">
          <button
            onClick={handleNewNote}
            title="New canvas"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/>
              <path d="M14 2v6h6"/>
              <path d="M12 18v-6"/>
              <path d="M9 15h6"/>
            </svg>
          </button>
        </div>

        <div className="toolbar-divider" />

        <div className="toolbar-section tool-buttons">
          <button
            className={currentTool === 'pen' ? 'active' : ''}
            onClick={() => setCurrentTool('pen')}
            title="Pen tool (P)"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
              <path d="m15 5 4 4"/>
            </svg>
          </button>
          <button
            className={currentTool === 'select' ? 'active' : ''}
            onClick={() => setCurrentTool('select')}
            title="Select tool (S) - drag to select elements"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 3l14 8-6 2-4 6z"/>
              <path d="M14 15l4 4"/>
            </svg>
          </button>
          <button
            className={currentTool === 'eraser' ? 'active' : ''}
            onClick={() => setCurrentTool('eraser')}
            title="Eraser tool (E)"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/>
              <path d="M22 21H7"/>
              <path d="m5 11 9 9"/>
            </svg>
          </button>
          <button
            className={currentTool === 'pan' ? 'active' : ''}
            onClick={() => setCurrentTool('pan')}
            title="Pan tool (H) - or hold Space"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 11V6a2 2 0 0 0-4 0v1"/>
              <path d="M14 10V4a2 2 0 0 0-4 0v2"/>
              <path d="M10 10.5V6a2 2 0 0 0-4 0v8"/>
              <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.6L3.3 16c-.8-1-.2-2.5 1-2.8a1.9 1.9 0 0 1 2 .6L8 16"/>
            </svg>
          </button>
          <button
            onClick={handleAddSketchableImage}
            title="Add AI sketch canvas"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
              <circle cx="12" cy="12" r="4"/>
            </svg>
          </button>
        </div>

        <div className="toolbar-divider" />

        <div className="toolbar-section tool-buttons">
          <button
            onClick={undo}
            disabled={!canUndo}
            title="Undo (Cmd+Z)"
            style={{ opacity: canUndo ? 1 : 0.5 }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 14 4 9l5-5"/>
              <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>
            </svg>
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            title="Redo (Cmd+Shift+Z)"
            style={{ opacity: canRedo ? 1 : 0.5 }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 14l5-5-5-5"/>
              <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>
            </svg>
          </button>
          <button
            className={showDebug ? 'active' : ''}
            onClick={() => setShowDebug(d => !d)}
            title="Toggle debug overlay"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m8 2 1.88 1.88"/>
              <path d="M14.12 3.88 16 2"/>
              <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/>
              <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/>
              <path d="M12 20v-9"/>
              <path d="M6.53 9C4.6 8.8 3 7.1 3 5"/>
              <path d="M6 13H2"/>
              <path d="M3 21c0-2.1 1.7-3.9 3.8-4"/>
              <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/>
              <path d="M22 13h-4"/>
              <path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>
            </svg>
          </button>
        </div>

        <div className="toolbar-divider" />

        <div className="toolbar-section color-picker" style={{ opacity: drawingControlsEnabled ? 1 : 0.4 }}>
          {/* Stroke color picker */}
          <div className="color-picker-item" title="Stroke color">
            <input
              type="color"
              value={selectionStrokeColor !== undefined && selectionStrokeColor !== 'mixed'
                ? colorToHex(selectionStrokeColor)
                : brushColor}
              onChange={handleStrokeColorChange}
              disabled={!drawingControlsEnabled}
              className={selectionStrokeColor === 'mixed' ? 'mixed-color' : ''}
            />
            {selectionStrokeColor === 'mixed' && <span className="mixed-indicator">?</span>}
          </div>

          {/* Background color picker */}
          <div className="color-picker-item" title="Background color">
            <input
              type="color"
              value={selectionBackgroundColor !== undefined && selectionBackgroundColor !== 'mixed'
                ? colorToHex(selectionBackgroundColor)
                : '#ffffff'}
              onChange={handleBackgroundColorChange}
              disabled={!drawingControlsEnabled || !backgroundColorEnabled}
              className={selectionBackgroundColor === 'mixed' ? 'mixed-color' : ''}
            />
            {selectionBackgroundColor === 'mixed' && <span className="mixed-indicator">?</span>}
          </div>
        </div>

        <div className="toolbar-section brush-size" style={{ opacity: drawingControlsEnabled ? 1 : 0.4 }}>
          <input
            type="range"
            min="1"
            max="20"
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
            title="Brush size"
            disabled={!drawingControlsEnabled}
          />
          <span>{brushSize}</span>
        </div>

      </header>

      {hasSelectedSketchImage && (
        <div className="toolbar toolbar-secondary">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6, flexShrink: 0 }}>
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
            <circle cx="12" cy="12" r="4"/>
          </svg>
          <label>
            <select
              value={stylePreset}
              onChange={(e) => setStylePreset(e.target.value as StylePresetKey)}
              title="AI Sketch style preset"
            >
              {Object.keys(STYLE_PRESETS).map(key => (
                <option key={key} value={key}>{key}</option>
              ))}
            </select>
          </label>
          <label>
            <select
              value={refinementMode}
              onChange={(e) => setRefinementMode(e.target.value as RefinementMode)}
              title="AI Sketch refinement mode"
            >
              <option value="twoImage">Two-Image</option>
              <option value="composite">Composite</option>
            </select>
          </label>
        </div>
      )}

      <Toaster />
      <footer className="status-bar">
        <span>Elements: {currentNote.elements.length}</span>
        <span>|</span>
        <span>P: Pen • S: Select • E: Eraser • H: Pan • Space+drag: Pan • Scroll: Pan • Ctrl+Scroll: Zoom</span>
      </footer>
    </div>
  );
}

export default App;
