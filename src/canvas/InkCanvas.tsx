import { useRef, useEffect, useCallback, useState } from 'react';
import { InkToolType, type NoteElements, type Element, type Stroke, type Brush } from '../types';
import type { InkTextElement } from '../elements/inktext/types';
import {
  applyTempoTapTarget,
  getMidiTempoControlBounds,
  resolveMidiTapTarget,
  resolveMidiTempoTapTarget,
  type MidiTempoTapTarget,
} from '../elements/midi/interaction';
import { ensureMidiFontReady } from '../elements/midi/font';
import { beginMidiRenderFrame, endMidiRenderFrame, hasActiveMidiPlayback } from '../elements/midi/renderer';
import { hasActiveTransitions as hasActiveImageTransitions } from '../elements/sketchableimage/renderer';
import { hasActiveTicTacToeAnimations } from '../elements/tictactoe/renderer';
import type { Viewport } from './ViewportManager';
import {
  DEFAULT_VIEWPORT,
  applyViewportToContext,
  resetContextTransform,
  panViewport,
  zoomViewport,
  fitToContent,
  screenToCanvas,
  canvasToScreen,
} from './ViewportManager';
import { renderElement, getElementBounds } from '../elements/rendering/ElementRenderer';
import { findHandleAtPoint, dispatchHandleDrag, getAllHandles } from '../elements';
import { renderHandles } from './HandleRenderer';
import { renderStroke, isPointNearStroke } from './StrokeRenderer';
import { StrokeBuilder, createDefaultBrush, hexToArgb } from '../input/StrokeBuilder';
import { DebugConsole } from '../debug/DebugConsole';
import { LassoMenu } from '../lasso';
import type { SelectionIntent, SelectionIntentAction } from '../lasso';
import { DisambiguationMenu } from '../disambiguation';
import type { DisambiguationIntent, DisambiguationAction, DisambiguationCandidate } from '../disambiguation';
import { PaletteMenu } from '../palette';
import type { PaletteIntent, PaletteAction } from '../palette';

export type Tool = 'pen' | 'eraser' | 'pan' | 'select';

const PINCH_ZOOM_SENSITIVITY = 0.002;
const TAP_MAX_DISTANCE = 10; // Max screen pixels finger can move and still count as tap
const TAP_MAX_DURATION = 300; // Max ms for a tap gesture
const TAP_SAME_SPOT_THRESHOLD = 20; // Max canvas-space pixels between taps to cycle selection
const MOUSE_MIDI_TAP_MAX_DISTANCE = 6;
const MOUSE_MIDI_TAP_MAX_DURATION = 300;
const MIDI_TEMPO_HOLD_DELAY_MS = 400;
const MIDI_TEMPO_HOLD_REPEAT_MS = 100;

function createSyntheticMouseTapStroke(
  canvasPoint: { x: number; y: number },
  brush: Brush
): Stroke {
  return {
    inputs: {
      tool: InkToolType.MOUSE,
      inputs: [
        { x: canvasPoint.x, y: canvasPoint.y, timeMillis: 0 },
        { x: canvasPoint.x, y: canvasPoint.y, timeMillis: 1 },
      ],
    },
    brush: { ...brush },
  };
}

function getCanvasPointFromPointerEvent(
  viewport: Viewport,
  canvas: HTMLCanvasElement,
  e: React.PointerEvent
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return screenToCanvas(viewport, {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  });
}

function pointInBounds(
  point: { x: number; y: number },
  bounds: { left: number; top: number; right: number; bottom: number }
): boolean {
  return (
    point.x >= bounds.left &&
    point.x <= bounds.right &&
    point.y >= bounds.top &&
    point.y <= bounds.bottom
  );
}

export interface InkCanvasProps {
  noteElements: NoteElements;
  showDebugOverlay?: boolean;
  currentTool?: Tool;
  brushColor?: string;
  brushSize?: number;
  onStrokeComplete?: (stroke: Stroke) => void;
  onDrawingStart?: () => void;
  onElementsChange?: (elements: Element[]) => void;
  initialViewport?: Viewport;
  onViewportChange?: (viewport: Viewport) => void;
  // Animation props: Map of element ID -> animation start time
  animatingElements?: Map<string, number>;
  animationDuration?: number;
  onAnimationComplete?: (elementId: string) => void;
  // Selection props
  selectedElementIds?: Set<string>;
  onSelectionChange?: (selectedIds: Set<string>) => void;
  onElementsMove?: (elementIds: Set<string>, dx: number, dy: number) => void;
  // Lasso selection intent props
  selectionIntent?: SelectionIntent | null;
  onSelectionIntentChange?: (intent: SelectionIntent | null) => void;
  // Disambiguation props
  disambiguationIntent?: DisambiguationIntent | null;
  onDisambiguationAction?: (action: DisambiguationAction, candidate?: DisambiguationCandidate) => void;
  // Palette props
  paletteIntent?: PaletteIntent | null;
  onPaletteAction?: (action: PaletteAction, entryId?: string) => void;
  // Overlay stroke clearing - used for scribble erase to sync stroke removal with element removal
  strokesToClearFromOverlay?: { strokes: Stroke[]; requestId: number } | null;
}

export function InkCanvas({
  noteElements,
  showDebugOverlay = false,
  currentTool = 'pen',
  brushColor = '#000000',
  brushSize = 3,
  onStrokeComplete,
  onDrawingStart,
  onElementsChange,
  initialViewport,
  onViewportChange,
  animatingElements,
  animationDuration = 500,
  onAnimationComplete,
  selectedElementIds,
  onSelectionChange,
  onElementsMove,
  selectionIntent,
  onSelectionIntentChange,
  disambiguationIntent,
  onDisambiguationAction,
  paletteIntent,
  onPaletteAction,
  strokesToClearFromOverlay,
}: InkCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const [viewport, setViewport] = useState<Viewport>(initialViewport ?? DEFAULT_VIEWPORT);
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 600 });
  const [midiFontEpoch, setMidiFontEpoch] = useState(0);

  // Panning state
  const [isPanning, setIsPanning] = useState(false);
  const isPanningRef = useRef(false);
  const lastPanPos = useRef<{ x: number; y: number } | null>(null);
  const [spacePressed, setSpacePressed] = useState(false);

  // Drawing state
  const strokeBuilder = useRef<StrokeBuilder | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const mousePenDownInfo = useRef<{ pointerId: number; x: number; y: number; time: number } | null>(null);

  // Eraser state
  const [isErasing, setIsErasing] = useState(false);
  const eraserRadius = 15; // Eraser radius in canvas units

  // Dragging state (for moving selected elements)
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const dragStartCanvasPos = useRef<{ x: number; y: number } | null>(null);

  // Handle drag state (for element handles like coordinate plane axis endpoints)
  const [isHandleDragging, setIsHandleDragging] = useState(false);
  const [activeHandle, setActiveHandle] = useState<{ elementId: string; handleId: string } | null>(null);
  const [handleCursor, setHandleCursor] = useState<string | null>(null);

  // Selection marquee state (for select tool)
  const [isSelectingMarquee, setIsSelectingMarquee] = useState(false);
  const marqueeStart = useRef<{ x: number; y: number } | null>(null);
  const marqueeCurrent = useRef<{ x: number; y: number } | null>(null);

  // Multi-touch state for pinch-to-zoom
  const activeTouches = useRef<Map<number, { x: number; y: number }>>(new Map());
  const lastPinchDistance = useRef<number | null>(null);
  const lastPinchCenter = useRef<{ x: number; y: number } | null>(null);

  // Touch tap detection state
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const touchStartTime = useRef<number>(0);
  const touchWasPinch = useRef(false);

  // Tap-to-select cycling state: track last tap location and selected element
  const lastTapPoint = useRef<{ x: number; y: number } | null>(null);
  const lastTapSelectedId = useRef<string | null>(null);

  // Track if initial fit-to-content has been done
  const hasInitialFit = useRef(false);

  // Animation frame ref for cleanup
  const animationFrameRef = useRef<number | null>(null);

  // Hold finished strokes on overlay until main canvas renders them
  // Using a Set to handle multiple rapid strokes correctly
  const finishedStrokesRef = useRef<Set<Stroke>>(new Set());
  // Track safety timeout IDs for each stroke so we can cancel them when strokes are consumed
  const strokeTimeoutsRef = useRef<Map<Stroke, ReturnType<typeof setTimeout>>>(new Map());
  const noteElementsRef = useRef(noteElements.elements);
  const onElementsChangeRef = useRef(onElementsChange);
  const activeMidiTempoPress = useRef<{
    pointerId: number;
    elementId: string;
    target: MidiTempoTapTarget;
    bounds: { left: number; top: number; right: number; bottom: number };
    initialDelayTimeoutId: ReturnType<typeof setTimeout> | null;
    repeatIntervalId: ReturnType<typeof setInterval> | null;
  } | null>(null);

  const stopMidiTempoPress = useCallback((pointerId?: number) => {
    const activePress = activeMidiTempoPress.current;
    if (!activePress || (pointerId !== undefined && activePress.pointerId !== pointerId)) {
      return false;
    }

    if (activePress.initialDelayTimeoutId !== null) {
      clearTimeout(activePress.initialDelayTimeoutId);
    }
    if (activePress.repeatIntervalId !== null) {
      clearInterval(activePress.repeatIntervalId);
    }

    const overlay = overlayCanvasRef.current;
    if (overlay?.hasPointerCapture(activePress.pointerId)) {
      overlay.releasePointerCapture(activePress.pointerId);
    }

    activeMidiTempoPress.current = null;
    return true;
  }, []);

  const applyMidiTempoPress = useCallback((elementId: string, target: MidiTempoTapTarget) => {
    const changeHandler = onElementsChangeRef.current;
    if (!changeHandler) {
      stopMidiTempoPress();
      return false;
    }

    const elements = noteElementsRef.current;
    const element = elements.find((candidate) => candidate.id === elementId);
    if (!element || element.type !== 'midi') {
      stopMidiTempoPress();
      return false;
    }

    const updated = applyTempoTapTarget(element, target);
    if (updated.tempo !== element.tempo) {
      changeHandler(elements.map((candidate) => (
        candidate.id === element.id ? updated : candidate
      )));
    }

    return true;
  }, [stopMidiTempoPress]);

  // Calculate size multiplier for an animating element (1 -> 2 -> 1 over duration)
  const getSizeMultiplier = useCallback((startTime: number, now: number) => {
    const elapsed = now - startTime;
    if (elapsed >= animationDuration) return 1;

    // Progress from 0 to 1
    const progress = elapsed / animationDuration;
    // Use sine wave to go from 1 -> 2 -> 1 smoothly
    // sin(0) = 0, sin(pi) = 0, sin(pi/2) = 1
    const sineProgress = Math.sin(progress * Math.PI);
    // Scale from 1 to 2 and back
    return 1 + sineProgress;
  }, [animationDuration]);

  // Erase elements at a point
  const eraseAt = useCallback((canvasX: number, canvasY: number) => {
    const point = { x: canvasX, y: canvasY };
    const elementsToKeep: Element[] = [];
    let changed = false;

    for (const element of noteElements.elements) {
      if (element.type === 'stroke') {
        // Check if any stroke in this element is near the eraser
        const strokesToKeep = element.strokes.filter(
          (stroke) => !isPointNearStroke(point, stroke, eraserRadius)
        );

        if (strokesToKeep.length === 0) {
          // Remove entire element
          changed = true;
        } else if (strokesToKeep.length < element.strokes.length) {
          // Keep element with remaining strokes
          elementsToKeep.push({ ...element, strokes: strokesToKeep });
          changed = true;
        } else {
          // Keep element unchanged
          elementsToKeep.push(element);
        }
      } else {
        // For non-stroke elements, check bounds
        const bounds = getElementBounds(element);
        if (bounds) {
          const inBounds =
            canvasX >= bounds.left - eraserRadius &&
            canvasX <= bounds.right + eraserRadius &&
            canvasY >= bounds.top - eraserRadius &&
            canvasY <= bounds.bottom + eraserRadius;

          if (!inBounds) {
            elementsToKeep.push(element);
          } else {
            changed = true;
          }
        } else {
          elementsToKeep.push(element);
        }
      }
    }

    if (changed && onElementsChange) {
      onElementsChange(elementsToKeep);
    }
  }, [noteElements.elements, eraserRadius, onElementsChange]);

  // Get elements fully contained within a rectangle (for marquee selection)
  const getElementsInRect = useCallback((rect: { left: number; top: number; right: number; bottom: number }): Element[] => {
    const result: Element[] = [];
    for (const element of noteElements.elements) {
      const bounds = getElementBounds(element);
      if (bounds) {
        // Check if element bounds are fully contained within rect
        const fullyContained =
          bounds.left >= rect.left &&
          bounds.right <= rect.right &&
          bounds.top >= rect.top &&
          bounds.bottom <= rect.bottom;
        if (fullyContained) {
          result.push(element);
        }
      }
    }
    return result;
  }, [noteElements.elements]);

  // Hit test: find ALL elements at a canvas point (topmost first)
  const getAllElementsAtPoint = useCallback((canvasX: number, canvasY: number): Element[] => {
    const padding = 4;
    const result: Element[] = [];
    for (let i = noteElements.elements.length - 1; i >= 0; i--) {
      const element = noteElements.elements[i];
      const bounds = getElementBounds(element);
      if (bounds) {
        const inBounds =
          canvasX >= bounds.left - padding &&
          canvasX <= bounds.right + padding &&
          canvasY >= bounds.top - padding &&
          canvasY <= bounds.bottom + padding;
        if (inBounds) {
          result.push(element);
        }
      }
    }
    return result;
  }, [noteElements.elements]);

  // Hit test: find topmost element at a canvas point
  const getElementAtPoint = useCallback((canvasX: number, canvasY: number): Element | null => {
    const all = getAllElementsAtPoint(canvasX, canvasY);
    return all.length > 0 ? all[0] : null;
  }, [getAllElementsAtPoint]);

  const tryStartMidiTempoPress = useCallback((e: React.PointerEvent, overlay: HTMLCanvasElement) => {
    if (currentTool !== 'pen') return false;
    if (activeMidiTempoPress.current) return false;
    if (e.pointerType !== 'touch' && e.button !== 0) return false;
    if (!onElementsChangeRef.current) return false;

    const canvasPoint = getCanvasPointFromPointerEvent(viewport, overlay, e);
    const clickedElement = getElementAtPoint(canvasPoint.x, canvasPoint.y);
    if (!clickedElement || clickedElement.type !== 'midi') {
      return false;
    }

    const target = resolveMidiTempoTapTarget(clickedElement, canvasPoint);
    if (!target) {
      return false;
    }

    const activePress = {
      pointerId: e.pointerId,
      elementId: clickedElement.id,
      target,
      bounds: getMidiTempoControlBounds(clickedElement, target),
      initialDelayTimeoutId: null as ReturnType<typeof setTimeout> | null,
      repeatIntervalId: null as ReturnType<typeof setInterval> | null,
    };
    activeMidiTempoPress.current = activePress;

    const pointerId = e.pointerId;
    overlay.setPointerCapture(pointerId);
    if (!applyMidiTempoPress(clickedElement.id, target)) {
      stopMidiTempoPress(pointerId);
      return false;
    }

    activePress.initialDelayTimeoutId = setTimeout(() => {
      const currentPress = activeMidiTempoPress.current;
      if (!currentPress || currentPress.pointerId !== pointerId) {
        return;
      }

      currentPress.repeatIntervalId = setInterval(() => {
        const repeatingPress = activeMidiTempoPress.current;
        if (!repeatingPress || repeatingPress.pointerId !== pointerId) {
          return;
        }

        applyMidiTempoPress(repeatingPress.elementId, repeatingPress.target);
      }, MIDI_TEMPO_HOLD_REPEAT_MS);
    }, MIDI_TEMPO_HOLD_DELAY_MS);

    e.preventDefault();
    return true;
  }, [currentTool, viewport, getElementAtPoint, applyMidiTempoPress, stopMidiTempoPress]);

  useEffect(() => {
    noteElementsRef.current = noteElements.elements;
  }, [noteElements.elements]);

  useEffect(() => {
    onElementsChangeRef.current = onElementsChange;
  }, [onElementsChange]);

  useEffect(() => () => {
    stopMidiTempoPress();
  }, [stopMidiTempoPress]);

  // Update brush when color/size changes
  useEffect(() => {
    const brush: Brush = createDefaultBrush(hexToArgb(brushColor), brushSize);
    if (strokeBuilder.current) {
      strokeBuilder.current.setBrush(brush);
    }
  }, [brushColor, brushSize]);

  // Update canvas size on resize
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setCanvasSize({ width: rect.width, height: rect.height });
      }
    };

    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  // Handle keyboard for space-to-pan and tool shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        setSpacePressed(true);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setSpacePressed(false);
        setIsPanning(false);
        isPanningRef.current = false;
        lastPanPos.current = null;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Prevent browser zoom on pinch gestures
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      // Prevent browser zoom when Ctrl is pressed (pinch-zoom reports as ctrl+wheel)
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    };

    // Must use passive: false to be able to preventDefault
    document.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      document.removeEventListener('wheel', handleWheel);
    };
  }, []);

  // Render the main canvas (static content)
  const render = useCallback((timestamp?: number) => {
    void midiFontEpoch;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const now = timestamp ?? performance.now();
    beginMidiRenderFrame(now);

    // Clear canvas with background
    resetContextTransform(ctx);
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw grid pattern for infinite canvas feel
    drawGrid(ctx, viewport, canvas.width, canvas.height);

    // Apply viewport transform
    applyViewportToContext(ctx, viewport);

    // Track which animations have completed
    const completedAnimations: string[] = [];

    // Render all elements
    for (const element of noteElements.elements) {
      const animationStart = animatingElements?.get(element.id);
      if (animationStart !== undefined) {
        const elapsed = now - animationStart;
        if (elapsed >= animationDuration) {
          // Animation complete
          completedAnimations.push(element.id);
          renderElement(ctx, element);
        } else {
          // Animation in progress
          const progress = elapsed / animationDuration;
          if (element.type === 'shape') {
            // For shapes, use morph animation from source strokes to final shape
            renderElement(ctx, element, { morphProgress: progress });
          } else {
            // For other elements, apply size multiplier
            const sizeMultiplier = getSizeMultiplier(animationStart, now);
            renderElement(ctx, element, { strokeOptions: { sizeMultiplier } });
          }
        }
      } else {
        renderElement(ctx, element);
      }
    }
    endMidiRenderFrame();

    // Notify about completed animations
    for (const id of completedAnimations) {
      onAnimationComplete?.(id);
    }

    // Render selection rectangles around selected elements
    if (selectedElementIds && selectedElementIds.size > 0) {
      renderSelectionRectangles(ctx, noteElements.elements, selectedElementIds);
    }

    // Render debug overlay if enabled
    if (showDebugOverlay) {
      renderDebugOverlay(ctx, noteElements.elements);
    }

    // Reset transform
    resetContextTransform(ctx);

    // Continue animation loop if there are active animations, generating elements, or image transitions
    const hasActiveAnimations = animatingElements && animatingElements.size > completedAnimations.length;
    const hasGenerating = noteElements.elements.some(
      el => 'isGenerating' in el && (el as Record<string, unknown>).isGenerating === true
    );
    if (
      hasActiveAnimations ||
      hasGenerating ||
      hasActiveImageTransitions() ||
      hasActiveTicTacToeAnimations() ||
      hasActiveMidiPlayback()
    ) {
      animationFrameRef.current = requestAnimationFrame(render);
    }
  }, [noteElements, viewport, showDebugOverlay, animatingElements, animationDuration, getSizeMultiplier, onAnimationComplete, selectedElementIds, midiFontEpoch]);

  // Render the overlay canvas (in-progress stroke and selection marquee)
  const renderOverlay = useCallback(() => {
    const overlay = overlayCanvasRef.current;
    if (!overlay) return;

    const ctx = overlay.getContext('2d');
    if (!ctx) return;

    // Clear overlay
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    // Draw current stroke if drawing
    if (strokeBuilder.current && isDrawing) {
      const currentStroke = strokeBuilder.current.getCurrentStroke();
      if (currentStroke) {
        applyViewportToContext(ctx, viewport);
        renderStroke(ctx, currentStroke);
        resetContextTransform(ctx);
      }
    }

    // Also render finished strokes until main canvas has them
    const finishedCount = finishedStrokesRef.current.size;
    if (finishedCount > 0) {
      applyViewportToContext(ctx, viewport);
      for (const stroke of finishedStrokesRef.current) {
        renderStroke(ctx, stroke);
      }
      resetContextTransform(ctx);
    }

    // Debug badge: show finished stroke count on overlay
    if (finishedCount > 0) {
      ctx.fillStyle = 'red';
      ctx.beginPath();
      ctx.arc(30, 30, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'white';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(finishedCount), 30, 30);
    }

    // Draw selection marquee
    if (isSelectingMarquee && marqueeStart.current && marqueeCurrent.current) {
      const start = canvasToScreen(viewport, marqueeStart.current);
      const current = canvasToScreen(viewport, marqueeCurrent.current);
      const x = Math.min(start.x, current.x);
      const y = Math.min(start.y, current.y);
      const width = Math.abs(current.x - start.x);
      const height = Math.abs(current.y - start.y);

      // Draw semi-transparent fill
      ctx.fillStyle = 'rgba(0, 102, 204, 0.1)';
      ctx.fillRect(x, y, width, height);

      // Draw border
      ctx.strokeStyle = '#0066cc';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(x, y, width, height);
      ctx.setLineDash([]);
    }

    // Draw lasso selection: render the actual lasso stroke AND the polygon if there's an active selection intent
    if (selectionIntent) {
      applyViewportToContext(ctx, viewport);

      // Render the lasso stroke(s) so the user sees their drawn ink
      for (const stroke of selectionIntent.lassoStrokes) {
        renderStroke(ctx, stroke);
      }

      // Draw the closed polygon overlay
      if (selectionIntent.lassoPolygon.length > 2) {
        ctx.beginPath();
        const firstPoint = selectionIntent.lassoPolygon[0];
        ctx.moveTo(firstPoint.x, firstPoint.y);
        for (let i = 1; i < selectionIntent.lassoPolygon.length; i++) {
          ctx.lineTo(selectionIntent.lassoPolygon[i].x, selectionIntent.lassoPolygon[i].y);
        }
        ctx.closePath();

        // Fill with semi-transparent color
        ctx.fillStyle = 'rgba(0, 102, 204, 0.1)';
        ctx.fill();

        // Draw dashed border
        ctx.strokeStyle = '#0066cc';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      resetContextTransform(ctx);
    }

    // Render element handles
    const allHandles = getAllHandles(noteElements.elements);
    if (allHandles.length > 0) {
      applyViewportToContext(ctx, viewport);
      for (const { elementId, handles } of allHandles) {
        const activeHandleId = activeHandle?.elementId === elementId ? activeHandle.handleId : undefined;
        renderHandles(ctx, handles, activeHandleId);
      }
      resetContextTransform(ctx);
    }
  }, [viewport, isDrawing, isSelectingMarquee, selectionIntent, noteElements.elements, activeHandle]);

  // Render on state changes. The render() call may detect new image transitions
  // and request additional animation frames via hasActiveImageTransitions().
  useEffect(() => {
    render();
  }, [render]);

  useEffect(() => {
    let isCancelled = false;

    void ensureMidiFontReady().then(() => {
      if (!isCancelled) {
        setMidiFontEpoch((current) => current + 1);
      }
    });

    return () => {
      isCancelled = true;
    };
  }, []);

  // Start animation loop when animating elements change or elements are generating
  const hasGeneratingElements = noteElements.elements.some(
    el => 'isGenerating' in el && (el as Record<string, unknown>).isGenerating === true
  );
  useEffect(() => {
    const shouldAnimate =
      (animatingElements && animatingElements.size > 0) ||
      hasGeneratingElements ||
      hasActiveMidiPlayback();
    if (shouldAnimate) {
      // Cancel any existing animation frame
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      // Start animation loop
      animationFrameRef.current = requestAnimationFrame(render);
    }
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [animatingElements, hasGeneratingElements, render]);

  useEffect(() => {
    renderOverlay();
  }, [renderOverlay]);

  // Clear finished strokes from overlay when they appear in noteElements
  // This is the key fix for stroke flickering - strokes are cleared when they
  // actually appear on the main canvas, not based on arbitrary timing
  useEffect(() => {
    if (finishedStrokesRef.current.size === 0) return;

    // Collect all strokes from elements (including sourceStrokes in shape elements)
    const allStrokesInElements = new Set<Stroke>();
    for (const el of noteElements.elements) {
      // Check for strokes property (StrokeElement)
      if ('strokes' in el && Array.isArray((el as { strokes?: Stroke[] }).strokes)) {
        for (const s of (el as { strokes: Stroke[] }).strokes) {
          allStrokesInElements.add(s);
        }
      }
      // Check for sourceStrokes property (ShapeElement, InkTextElement, etc.)
      if ('sourceStrokes' in el && Array.isArray((el as { sourceStrokes?: Stroke[] }).sourceStrokes)) {
        for (const s of (el as { sourceStrokes: Stroke[] }).sourceStrokes) {
          allStrokesInElements.add(s);
        }
      }
    }

    // Remove any finished strokes that are now in elements
    let changed = false;
    for (const stroke of finishedStrokesRef.current) {
      if (allStrokesInElements.has(stroke)) {
        finishedStrokesRef.current.delete(stroke);
        // Cancel the safety timeout since stroke was properly consumed
        const timeoutId = strokeTimeoutsRef.current.get(stroke);
        if (timeoutId) {
          clearTimeout(timeoutId);
          strokeTimeoutsRef.current.delete(stroke);
        }
        changed = true;
      }
    }

    if (changed) {
      renderOverlay();
    }
  }, [noteElements.elements, renderOverlay]);

  // Clear specific strokes from overlay on demand (e.g., for scribble erase)
  // This allows synchronizing stroke removal with element removal
  useEffect(() => {
    if (!strokesToClearFromOverlay || strokesToClearFromOverlay.strokes.length === 0) return;

    let changed = false;
    for (const stroke of strokesToClearFromOverlay.strokes) {
      if (finishedStrokesRef.current.has(stroke)) {
        finishedStrokesRef.current.delete(stroke);
        // Cancel the safety timeout
        const timeoutId = strokeTimeoutsRef.current.get(stroke);
        if (timeoutId) {
          clearTimeout(timeoutId);
          strokeTimeoutsRef.current.delete(stroke);
        }
        changed = true;
      }
    }

    if (changed) {
      renderOverlay();
    }
  }, [strokesToClearFromOverlay, renderOverlay]);

  // Handle mouse wheel for zoom and pan
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();

      if (e.ctrlKey || e.metaKey) {
        // Pinch zoom
        const zoomDelta = -e.deltaY * 0.003;
        const newViewport = zoomViewport(viewport, zoomDelta, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
        setViewport(newViewport);
        onViewportChange?.(newViewport);
      } else {
        // Pan with scroll
        const newViewport = panViewport(viewport, -e.deltaX, -e.deltaY);
        setViewport(newViewport);
        onViewportChange?.(newViewport);
      }
    },
    [viewport, onViewportChange]
  );

  // Determine if we should pan based on current state
  const shouldPan = useCallback((e: React.MouseEvent | React.PointerEvent) => {
    // Pan tool always pans
    if (currentTool === 'pan') return true;
    // Space+drag pans
    if (spacePressed) return true;
    // Middle mouse button pans
    if (e.button === 1) return true;
    // Right mouse button pans
    if (e.button === 2) return true;
    // Alt+drag pans
    if (e.altKey) return true;
    return false;
  }, [currentTool, spacePressed]);

  const tryStartHandleDrag = useCallback((
    canvasPoint: { x: number; y: number },
    overlay: HTMLCanvasElement,
    pointerId: number,
  ): boolean => {
    const handleHit = findHandleAtPoint(noteElements.elements, canvasPoint);
    if (!handleHit) return false;

    const updated = dispatchHandleDrag(handleHit.element, handleHit.handle.id, 'start', canvasPoint);
    if (updated !== handleHit.element && onElementsChange) {
      const newElements = noteElements.elements.map(el =>
        el.id === handleHit.element.id ? updated : el
      );
      onElementsChange(newElements);
    }
    setIsHandleDragging(true);
    setActiveHandle({ elementId: handleHit.element.id, handleId: handleHit.handle.id });
    setHandleCursor(handleHit.handle.cursor ?? 'pointer');
    overlay.setPointerCapture(pointerId);
    return true;
  }, [noteElements.elements, onElementsChange]);

  // Handle pointer down
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const overlay = overlayCanvasRef.current;
    if (!overlay) return;

    if (activeMidiTempoPress.current && activeMidiTempoPress.current.pointerId !== e.pointerId) {
      e.preventDefault();
      return;
    }

    if (tryStartMidiTempoPress(e, overlay)) {
      return;
    }

    // Track all active touch pointers for pinch-zoom
    if (e.pointerType === 'touch') {
      activeTouches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      overlay.setPointerCapture(e.pointerId);

      // Ignore 3+ simultaneous fingers
      if (activeTouches.current.size > 2) {
        e.preventDefault();
        return;
      }

      if (activeTouches.current.size === 2) {
        // Second finger down: cancel any in-progress single-finger drag/pan
        if (isDraggingRef.current) {
          setIsDragging(false);
          isDraggingRef.current = false;
          dragStartCanvasPos.current = null;
        }
        if (isPanningRef.current) {
          setIsPanning(false);
          isPanningRef.current = false;
          lastPanPos.current = null;
        }
        if (isHandleDragging && activeHandle) {
          const element = noteElements.elements.find(el => el.id === activeHandle.elementId);
          if (element) {
            const canvasPoint = screenToCanvas(viewport, {
              x: e.nativeEvent.offsetX,
              y: e.nativeEvent.offsetY,
            });
            const updated = dispatchHandleDrag(element, activeHandle.handleId, 'end', canvasPoint);
            if (updated !== element && onElementsChange) {
              const newElements = noteElements.elements.map(el =>
                el.id === element.id ? updated : el
              );
              onElementsChange(newElements);
            }
          }
          setIsHandleDragging(false);
          setActiveHandle(null);
          setHandleCursor(null);
        }

        // Mark that this touch interaction involved a pinch (not a tap)
        touchWasPinch.current = true;

        // Initialize pinch-zoom state
        const points = Array.from(activeTouches.current.values());
        const dx = points[1].x - points[0].x;
        const dy = points[1].y - points[0].y;
        lastPinchDistance.current = Math.sqrt(dx * dx + dy * dy);
        lastPinchCenter.current = {
          x: (points[0].x + points[1].x) / 2,
          y: (points[0].y + points[1].y) / 2,
        };
        e.preventDefault();
        return;
      }

      // Single finger touch: record start for tap detection, then drag or pan
      if (activeTouches.current.size === 1) {
        touchStartPos.current = { x: e.clientX, y: e.clientY };
        touchStartTime.current = Date.now();
        touchWasPinch.current = false;

        const canvasPoint = screenToCanvas(viewport, {
          x: e.nativeEvent.offsetX,
          y: e.nativeEvent.offsetY,
        });

        if (tryStartHandleDrag(canvasPoint, overlay, e.pointerId)) {
          e.preventDefault();
          return;
        }

        const hasSelection = selectedElementIds && selectedElementIds.size > 0;
        const clickedElement = getElementAtPoint(canvasPoint.x, canvasPoint.y);
        const clickedOnSelected = hasSelection && clickedElement && selectedElementIds.has(clickedElement.id);

        if (clickedOnSelected) {
          setIsDragging(true);
          isDraggingRef.current = true;
          dragStartCanvasPos.current = canvasPoint;
          e.preventDefault();
          return;
        }

        // Otherwise pan
        setIsPanning(true);
        isPanningRef.current = true;
        lastPanPos.current = { x: e.clientX, y: e.clientY };
        e.preventDefault();
        return;
      }
    }

    if (shouldPan(e)) {
      // Start panning
      setIsPanning(true);
      isPanningRef.current = true;
      lastPanPos.current = { x: e.clientX, y: e.clientY };
      overlay.setPointerCapture(e.pointerId);
      e.preventDefault();
    } else if (currentTool === 'pen' && e.button === 0) {
      // Convert screen to canvas coordinates
      const canvasPoint = screenToCanvas(viewport, {
        x: e.nativeEvent.offsetX,
        y: e.nativeEvent.offsetY,
      });

      // Clear any active selection intent when starting a new pen stroke
      // This dismisses the lasso menu if user continues inking
      if (selectionIntent) {
        onSelectionIntentChange?.(null);
      }

      // Clear any active disambiguation intent when starting a new pen stroke
      // This dismisses the disambiguation menu and keeps strokes as-is
      if (disambiguationIntent) {
        onDisambiguationAction?.('dismiss');
      }

      // Clear any active palette intent when starting a new pen stroke
      if (paletteIntent) {
        onPaletteAction?.('dismiss');
      }

      // Check for element handles FIRST - handles take precedence over inking
      if (tryStartHandleDrag(canvasPoint, overlay, e.pointerId)) {
        e.preventDefault();
        return;
      }

      // Pen tool: clear any active selection and proceed to draw
      const hasSelection = selectedElementIds && selectedElementIds.size > 0;
      if (hasSelection) {
        onSelectionChange?.(new Set());
      }

      // Start drawing
      // Cancel all safety timeouts so earlier finished strokes don't vanish while
      // the user is still actively drawing. The next pointer-up sets a fresh timeout.
      for (const [, tid] of strokeTimeoutsRef.current) {
        clearTimeout(tid);
      }
      strokeTimeoutsRef.current.clear();
      const brush = createDefaultBrush(hexToArgb(brushColor), brushSize);
      strokeBuilder.current = new StrokeBuilder({ brush });
      strokeBuilder.current.start(canvasPoint.x, canvasPoint.y, e.pressure, e.pointerType);
      mousePenDownInfo.current = e.pointerType === 'mouse'
        ? { pointerId: e.pointerId, x: e.clientX, y: e.clientY, time: Date.now() }
        : null;
      setIsDrawing(true);
      onDrawingStart?.();
      overlay.setPointerCapture(e.pointerId);
      e.preventDefault();
    } else if (currentTool === 'eraser' && e.button === 0) {
      // Start erasing
      setIsErasing(true);
      const canvasPoint = screenToCanvas(viewport, {
        x: e.nativeEvent.offsetX,
        y: e.nativeEvent.offsetY,
      });
      eraseAt(canvasPoint.x, canvasPoint.y);
      overlay.setPointerCapture(e.pointerId);
      e.preventDefault();
    } else if (currentTool === 'select' && e.button === 0) {
      const canvasPoint = screenToCanvas(viewport, {
        x: e.nativeEvent.offsetX,
        y: e.nativeEvent.offsetY,
      });

      // Check for element handles first
      if (tryStartHandleDrag(canvasPoint, overlay, e.pointerId)) {
        e.preventDefault();
        return;
      }

      const hasSelection = selectedElementIds && selectedElementIds.size > 0;
      const clickedElement = getElementAtPoint(canvasPoint.x, canvasPoint.y);

      // If clicking on a selected element, start dragging it
      if (hasSelection && clickedElement && selectedElementIds.has(clickedElement.id)) {
        setIsDragging(true);
        isDraggingRef.current = true;
        dragStartCanvasPos.current = canvasPoint;
        overlay.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }

      // If clicking on an unselected element, select it and start dragging
      if (clickedElement) {
        const isCtrlPressed = e.ctrlKey || e.metaKey;
        const newSelection = isCtrlPressed && hasSelection
          ? new Set([...selectedElementIds!, clickedElement.id])
          : new Set([clickedElement.id]);
        onSelectionChange?.(newSelection);
        setIsDragging(true);
        isDraggingRef.current = true;
        dragStartCanvasPos.current = canvasPoint;
        overlay.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }

      // Clicking on empty space: start marquee selection
      const isCtrlPressed = e.ctrlKey || e.metaKey;
      if (!isCtrlPressed && hasSelection) {
        onSelectionChange?.(new Set());
      }
      setIsSelectingMarquee(true);
      marqueeStart.current = canvasPoint;
      marqueeCurrent.current = canvasPoint;
      overlay.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  }, [shouldPan, currentTool, viewport, brushColor, brushSize, eraseAt, getElementAtPoint, selectedElementIds, onSelectionChange, selectionIntent, onSelectionIntentChange, disambiguationIntent, onDisambiguationAction, paletteIntent, onPaletteAction, noteElements.elements, onElementsChange, onDrawingStart, tryStartHandleDrag, isHandleDragging, activeHandle, tryStartMidiTempoPress]);

  // Handle pointer move
  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const activeTempoPress = activeMidiTempoPress.current;
      if (activeTempoPress?.pointerId === e.pointerId) {
        const overlay = overlayCanvasRef.current;
        if (!overlay) {
          stopMidiTempoPress(e.pointerId);
          return;
        }

        const canvasPoint = getCanvasPointFromPointerEvent(viewport, overlay, e);
        if (!pointInBounds(canvasPoint, activeTempoPress.bounds)) {
          stopMidiTempoPress(e.pointerId);
        }
        e.preventDefault();
        return;
      }

      // Update touch tracking and handle pinch-zoom
      if (e.pointerType === 'touch' && activeTouches.current.has(e.pointerId)) {
        activeTouches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (activeTouches.current.size === 2 && lastPinchDistance.current !== null && lastPinchCenter.current !== null) {
          const points = Array.from(activeTouches.current.values());
          const dx = points[1].x - points[0].x;
          const dy = points[1].y - points[0].y;
          const newDistance = Math.sqrt(dx * dx + dy * dy);
          const newCenter = {
            x: (points[0].x + points[1].x) / 2,
            y: (points[0].y + points[1].y) / 2,
          };

          // Zoom and pan based on pinch gesture using functional updater to avoid stale viewport
          const zoomDelta = (newDistance - lastPinchDistance.current) * PINCH_ZOOM_SENSITIVITY;
          const panDx = newCenter.x - lastPinchCenter.current.x;
          const panDy = newCenter.y - lastPinchCenter.current.y;

          setViewport(prev => {
            const zoomed = zoomViewport(prev, zoomDelta, newCenter.x, newCenter.y);
            const panned = panViewport(zoomed, panDx, panDy);
            onViewportChange?.(panned);
            return panned;
          });

          lastPinchDistance.current = newDistance;
          lastPinchCenter.current = newCenter;
          return;
        }
      }

      if (isPanning && lastPanPos.current) {
        // Continue panning
        const deltaX = e.clientX - lastPanPos.current.x;
        const deltaY = e.clientY - lastPanPos.current.y;
        const newViewport = panViewport(viewport, deltaX, deltaY);
        setViewport(newViewport);
        onViewportChange?.(newViewport);
        lastPanPos.current = { x: e.clientX, y: e.clientY };
      } else if (isHandleDragging && activeHandle) {
        // Continue handle drag - update element in real-time
        const canvasPoint = screenToCanvas(viewport, {
          x: e.nativeEvent.offsetX,
          y: e.nativeEvent.offsetY,
        });
        const element = noteElements.elements.find(el => el.id === activeHandle.elementId);
        if (element) {
          const updated = dispatchHandleDrag(element, activeHandle.handleId, 'update', canvasPoint);
          if (updated !== element && onElementsChange) {
            const newElements = noteElements.elements.map(el =>
              el.id === element.id ? updated : el
            );
            onElementsChange(newElements);
          }
        }
      } else if (isDragging && dragStartCanvasPos.current && selectedElementIds && selectedElementIds.size > 0) {
        // Continue dragging selected elements
        const canvasPoint = screenToCanvas(viewport, {
          x: e.nativeEvent.offsetX,
          y: e.nativeEvent.offsetY,
        });
        const dx = canvasPoint.x - dragStartCanvasPos.current.x;
        const dy = canvasPoint.y - dragStartCanvasPos.current.y;
        if (dx !== 0 || dy !== 0) {
          onElementsMove?.(selectedElementIds, dx, dy);
          dragStartCanvasPos.current = canvasPoint;
        }
      } else if (isDrawing && strokeBuilder.current) {
        // Continue drawing
        const canvasPoint = screenToCanvas(viewport, {
          x: e.nativeEvent.offsetX,
          y: e.nativeEvent.offsetY,
        });
        strokeBuilder.current.addPoint(canvasPoint.x, canvasPoint.y, e.pressure);
        renderOverlay();
      } else if (isErasing) {
        // Continue erasing
        const canvasPoint = screenToCanvas(viewport, {
          x: e.nativeEvent.offsetX,
          y: e.nativeEvent.offsetY,
        });
        eraseAt(canvasPoint.x, canvasPoint.y);
      } else if (isSelectingMarquee && marqueeStart.current) {
        // Continue marquee selection
        const canvasPoint = screenToCanvas(viewport, {
          x: e.nativeEvent.offsetX,
          y: e.nativeEvent.offsetY,
        });
        marqueeCurrent.current = canvasPoint;
        renderOverlay();
      }
    },
    [isPanning, isHandleDragging, activeHandle, isDragging, isDrawing, isErasing, isSelectingMarquee, viewport, onViewportChange, renderOverlay, eraseAt, selectedElementIds, onElementsMove, noteElements.elements, onElementsChange, stopMidiTempoPress]
  );

  // Handle pointer up
  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const overlay = overlayCanvasRef.current;

    if (stopMidiTempoPress(e.pointerId)) {
      return;
    }

    // Clean up touch tracking
    if (e.pointerType === 'touch') {
      activeTouches.current.delete(e.pointerId);
      if (overlay && overlay.hasPointerCapture(e.pointerId)) {
        overlay.releasePointerCapture(e.pointerId);
      }
      if (activeTouches.current.size < 2) {
        lastPinchDistance.current = null;
        lastPinchCenter.current = null;
      }
      if (activeTouches.current.size === 1) {
        // Transition back to single-finger pan from the remaining touch position
        const remaining = Array.from(activeTouches.current.values())[0];
        lastPanPos.current = remaining;
        setIsPanning(true);
        isPanningRef.current = true;
        return;
      }

      // Detect tap: short duration, small movement, not part of a pinch
      if (activeTouches.current.size === 0 && touchStartPos.current && !touchWasPinch.current) {
        const dx = e.clientX - touchStartPos.current.x;
        const dy = e.clientY - touchStartPos.current.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const duration = Date.now() - touchStartTime.current;

        if (distance < TAP_MAX_DISTANCE && duration < TAP_MAX_DURATION) {
          /*
           * This was a tap — handle selection.
           * Compute element-relative offset from clientX/clientY and the
           * overlay bounding rect. Using offsetX/offsetY is unreliable on
           * touch-end events in some browsers (Safari/iOS may report 0,0).
           */
          if (!overlay) return;
          const rect = overlay.getBoundingClientRect();
          const canvasPoint = screenToCanvas(viewport, {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
          const elementsAtPoint = getAllElementsAtPoint(canvasPoint.x, canvasPoint.y);

          if (elementsAtPoint.length === 0) {
            /* Tap on empty space: deselect */
            onSelectionChange?.(new Set());
            lastTapPoint.current = null;
            lastTapSelectedId.current = null;
          } else {
            /*
             * Determine cycle index: if tapping near the same spot, advance
             * past the previously selected element. If the previous element is
             * gone (deleted/reordered), restart from the top.
             */
            let cycleIdx = 0;
            if (lastTapPoint.current && lastTapSelectedId.current) {
              const spotDx = canvasPoint.x - lastTapPoint.current.x;
              const spotDy = canvasPoint.y - lastTapPoint.current.y;
              if (Math.sqrt(spotDx * spotDx + spotDy * spotDy) < TAP_SAME_SPOT_THRESHOLD) {
                const prevIdx = elementsAtPoint.findIndex(el => el.id === lastTapSelectedId.current);
                cycleIdx = prevIdx === -1 ? 0 : (prevIdx + 1) % elementsAtPoint.length;
              }
            }
            lastTapPoint.current = canvasPoint;

            const target = elementsAtPoint[cycleIdx];
            lastTapSelectedId.current = target.id;
            onSelectionChange?.(new Set([target.id]));
          }

          /* Clean up pan/drag state that was speculatively started on pointer-down */
          if (isPanningRef.current) {
            setIsPanning(false);
            isPanningRef.current = false;
            lastPanPos.current = null;
          }
          if (isDraggingRef.current) {
            setIsDragging(false);
            isDraggingRef.current = false;
            dragStartCanvasPos.current = null;
          }
          touchStartPos.current = null;
          return;
        }
      }
      touchStartPos.current = null;

      if (activeTouches.current.size === 0 && !isPanningRef.current && !isDraggingRef.current) {
        return;
      }
    }

    if (isPanning) {
      if (overlay && overlay.hasPointerCapture(e.pointerId)) {
        overlay.releasePointerCapture(e.pointerId);
      }
      setIsPanning(false);
      isPanningRef.current = false;
      lastPanPos.current = null;
    }

    if (isDragging) {
      // End dragging
      setIsDragging(false);
      isDraggingRef.current = false;
      dragStartCanvasPos.current = null;
      if (overlay && overlay.hasPointerCapture(e.pointerId)) {
        overlay.releasePointerCapture(e.pointerId);
      }
    }

    if (isHandleDragging && activeHandle) {
      // Call 'end' phase
      const element = noteElements.elements.find(el => el.id === activeHandle.elementId);
      if (element) {
        const canvasPoint = screenToCanvas(viewport, {
          x: e.nativeEvent.offsetX,
          y: e.nativeEvent.offsetY,
        });
        const updated = dispatchHandleDrag(element, activeHandle.handleId, 'end', canvasPoint);
        if (updated !== element && onElementsChange) {
          const newElements = noteElements.elements.map(el =>
            el.id === element.id ? updated : el
          );
          onElementsChange(newElements);
        }
      }

      // End handle drag
      setIsHandleDragging(false);
      setActiveHandle(null);
      setHandleCursor(null);
      if (overlay) {
        overlay.releasePointerCapture(e.pointerId);
      }
    }

    if (isDrawing && strokeBuilder.current) {
      // Finish drawing
      const stroke = strokeBuilder.current.finish();
      if (stroke) {
        // Add stroke to the set for overlay rendering until it appears on main canvas
        finishedStrokesRef.current.add(stroke);
        if (onStrokeComplete) {
          onStrokeComplete(stroke);
        }
        // Safety timeout: clear ALL pending finished strokes after 2000ms if not
        // picked up. Re-arm every pending stroke so the countdown restarts from the
        // most recent pointer-up (earlier timeouts were cancelled on pointer-down).
        for (const [s, tid] of strokeTimeoutsRef.current) {
          clearTimeout(tid);
          strokeTimeoutsRef.current.delete(s);
        }
        for (const s of finishedStrokesRef.current) {
          const tid = setTimeout(() => {
            if (finishedStrokesRef.current.has(s)) {
              finishedStrokesRef.current.delete(s);
              strokeTimeoutsRef.current.delete(s);
              renderOverlay();
            }
          }, 2000);
          strokeTimeoutsRef.current.set(s, tid);
        }
      } else {
        const mouseDown = mousePenDownInfo.current;
        const duration = mouseDown ? Date.now() - mouseDown.time : Infinity;
        const movement = mouseDown
          ? Math.hypot(e.clientX - mouseDown.x, e.clientY - mouseDown.y)
          : Infinity;
        const canvasPoint = screenToCanvas(viewport, {
          x: e.nativeEvent.offsetX,
          y: e.nativeEvent.offsetY,
        });
        const clickedElement = getElementAtPoint(canvasPoint.x, canvasPoint.y);
        const shouldSynthesizeMidiTap =
          currentTool === 'pen' &&
          e.pointerType === 'mouse' &&
          mouseDown?.pointerId === e.pointerId &&
          duration <= MOUSE_MIDI_TAP_MAX_DURATION &&
          movement <= MOUSE_MIDI_TAP_MAX_DISTANCE &&
          clickedElement?.type === 'midi' &&
          resolveMidiTapTarget(clickedElement, canvasPoint) !== null;

        if (shouldSynthesizeMidiTap && onStrokeComplete) {
          const brush = createDefaultBrush(hexToArgb(brushColor), brushSize);
          onStrokeComplete(createSyntheticMouseTapStroke(canvasPoint, brush));
        }
      }
      mousePenDownInfo.current = null;
      strokeBuilder.current = null;
      setIsDrawing(false);
      if (overlay) {
        overlay.releasePointerCapture(e.pointerId);
      }
    }

    if (isErasing) {
      setIsErasing(false);
      if (overlay) {
        overlay.releasePointerCapture(e.pointerId);
      }
    }

    if (isSelectingMarquee && marqueeStart.current && marqueeCurrent.current) {
      // Calculate marquee rectangle in canvas coordinates
      const start = marqueeStart.current;
      const current = marqueeCurrent.current;
      const rect = {
        left: Math.min(start.x, current.x),
        top: Math.min(start.y, current.y),
        right: Math.max(start.x, current.x),
        bottom: Math.max(start.y, current.y),
      };

      // Find elements fully contained in the marquee
      const elementsInMarquee = getElementsInRect(rect);

      // Update selection
      if (elementsInMarquee.length > 0) {
        const isCtrlPressed = e.ctrlKey || e.metaKey;
        if (isCtrlPressed && selectedElementIds) {
          // Add to existing selection
          const newSelection = new Set(selectedElementIds);
          for (const el of elementsInMarquee) {
            newSelection.add(el.id);
          }
          onSelectionChange?.(newSelection);
        } else {
          // Replace selection
          onSelectionChange?.(new Set(elementsInMarquee.map(el => el.id)));
        }
      }

      // Clear marquee state
      setIsSelectingMarquee(false);
      marqueeStart.current = null;
      marqueeCurrent.current = null;
      renderOverlay();
      if (overlay) {
        overlay.releasePointerCapture(e.pointerId);
      }
    }
  }, [isPanning, isHandleDragging, activeHandle, isDragging, isDrawing, isErasing, isSelectingMarquee, onStrokeComplete, renderOverlay, noteElements.elements, onElementsChange, getElementAtPoint, getElementsInRect, getAllElementsAtPoint, selectedElementIds, onSelectionChange, viewport, currentTool, brushColor, brushSize, stopMidiTempoPress]);

  // Handle double-click to fit content (only in select/pan modes to avoid
  // accidental zoom during gameplay or rapid inking)
  const handleDoubleClick = useCallback(() => {
    if (currentTool !== 'select' && currentTool !== 'pan') return;
    const bounds = getAllContentBounds(noteElements.elements);
    if (bounds) {
      const newViewport = fitToContent(viewport, bounds, canvasSize.width, canvasSize.height);
      setViewport(newViewport);
      onViewportChange?.(newViewport);
    }
  }, [currentTool, noteElements.elements, viewport, canvasSize.width, canvasSize.height, onViewportChange]);

  // Prevent context menu on right-click (we use it for panning)
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  // Fit to content on initial load only (once canvas is sized), skip if viewport was restored
  useEffect(() => {
    if (hasInitialFit.current) return;
    if (canvasSize.width <= 0 || canvasSize.height <= 0) return;

    hasInitialFit.current = true;
    if (initialViewport) return; // Restored viewport takes precedence
    const bounds = getAllContentBounds(noteElements.elements);
    if (bounds) {
      const newViewport = fitToContent(DEFAULT_VIEWPORT, bounds, canvasSize.width, canvasSize.height);
      setViewport(newViewport);
      onViewportChange?.(newViewport);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally runs once when canvas is sized; hasInitialFit ref guards against re-runs
  }, [canvasSize.width, canvasSize.height]);

  // Determine cursor based on state
  const getCursor = () => {
    if (isPanning) return 'grabbing';
    if (isHandleDragging && handleCursor) return handleCursor;
    if (isDragging) return 'move';
    if (isSelectingMarquee) return 'crosshair';
    if (spacePressed || currentTool === 'pan') return 'grab';
    if (currentTool === 'eraser') return 'crosshair';
    if (currentTool === 'select') return 'crosshair';
    return 'crosshair';
  };

  // Get InkText elements with their screen positions for debug overlays
  const getInkTextOverlays = () => {
    if (!showDebugOverlay) return [];

    return noteElements.elements
      .filter((el): el is InkTextElement => el.type === 'inkText')
      .map((element) => {
        const bounds = getElementBounds(element);
        if (!bounds) return null;

        // Get text content from all lines
        const textContent = (element as InkTextElement).lines
          .map(line => line.tokens.map(t => t.text).join(''))
          .join(' | ');

        // Convert canvas position to screen position
        const screenPos = canvasToScreen(viewport, { x: bounds.left, y: bounds.bottom });

        return {
          id: element.id,
          text: textContent || '(empty)',
          x: screenPos.x,
          y: screenPos.y + 4,
        };
      })
      .filter((o): o is { id: string; text: string; x: number; y: number } => o !== null);
  };

  const inkTextOverlays = getInkTextOverlays();

  // Handle lasso selection intent actions
  const handleLassoAction = useCallback((action: SelectionIntentAction) => {
    if (!selectionIntent) return;

    switch (action) {
      case 'select':
        // Apply selection and remove the lasso stroke element
        onSelectionChange?.(new Set(selectionIntent.selectedElements.map(el => el.id)));
        if (onElementsChange) {
          const remainingElements = noteElements.elements.filter(el => el.id !== selectionIntent.lassoElementId);
          onElementsChange(remainingElements);
        }
        onSelectionIntentChange?.(null);
        break;

      case 'delete':
        // Delete selected elements AND the lasso stroke element
        if (onElementsChange) {
          const selectedIds = new Set(selectionIntent.selectedElements.map(el => el.id));
          selectedIds.add(selectionIntent.lassoElementId);
          const remainingElements = noteElements.elements.filter(el => !selectedIds.has(el.id));
          onElementsChange(remainingElements);
        }
        onSelectionIntentChange?.(null);
        break;

      case 'dismiss':
        // Just clear the intent - lasso stroke remains as content
        onSelectionIntentChange?.(null);
        break;
    }
  }, [selectionIntent, onSelectionChange, onSelectionIntentChange, noteElements.elements, onElementsChange]);

  // Create a wrapper for canvasToScreen for the LassoMenu
  const canvasToScreenWrapper = useCallback((point: { x: number; y: number }) => {
    return canvasToScreen(viewport, point);
  }, [viewport]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Main canvas for static content */}
      <canvas
        ref={canvasRef}
        width={canvasSize.width}
        height={canvasSize.height}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
        }}
      />
      {/* Overlay canvas for in-progress strokes */}
      <canvas
        ref={overlayCanvasRef}
        width={canvasSize.width}
        height={canvasSize.height}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          cursor: getCursor(),
          touchAction: 'none',
        }}
      />
      {/* Lasso selection menu */}
      <LassoMenu
        intent={selectionIntent ?? null}
        onAction={handleLassoAction}
        canvasToScreen={canvasToScreenWrapper}
      />
      {/* Disambiguation menu */}
      <DisambiguationMenu
        intent={disambiguationIntent ?? null}
        onAction={onDisambiguationAction ?? (() => {})}
        canvasToScreen={canvasToScreenWrapper}
      />
      {/* Palette menu */}
      <PaletteMenu
        intent={paletteIntent ?? null}
        onAction={onPaletteAction ?? (() => {})}
        canvasToScreen={canvasToScreenWrapper}
      />
      {/* InkText content overlays in debug mode */}
      {showDebugOverlay && inkTextOverlays.map((overlay) => (
        <div
          key={overlay.id}
          style={{
            position: 'absolute',
            left: overlay.x,
            top: overlay.y,
            backgroundColor: 'rgba(0, 100, 200, 0.9)',
            color: 'white',
            padding: '2px 6px',
            borderRadius: 3,
            fontSize: 11,
            fontFamily: 'monospace',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 100,
            maxWidth: 300,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {overlay.text}
        </div>
      ))}
      {/* Debug console */}
      <DebugConsole visible={showDebugOverlay} />
    </div>
  );
}

// Draw grid pattern for infinite canvas
function drawGrid(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  width: number,
  height: number
): void {
  const gridSize = 50;
  const scaledGridSize = gridSize * viewport.zoom;

  // Don't draw grid if too zoomed out
  if (scaledGridSize < 10) return;

  // Calculate grid offset based on pan
  const offsetX = viewport.panX % scaledGridSize;
  const offsetY = viewport.panY % scaledGridSize;

  ctx.strokeStyle = '#e0e0e0';
  ctx.lineWidth = 1;

  // Draw vertical lines
  ctx.beginPath();
  for (let x = offsetX; x < width; x += scaledGridSize) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  ctx.stroke();

  // Draw horizontal lines
  ctx.beginPath();
  for (let y = offsetY; y < height; y += scaledGridSize) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  // Draw larger grid every 5 cells if zoomed in enough
  if (scaledGridSize >= 20) {
    const largeGridSize = scaledGridSize * 5;
    const largeOffsetX = viewport.panX % largeGridSize;
    const largeOffsetY = viewport.panY % largeGridSize;

    ctx.strokeStyle = '#d0d0d0';
    ctx.lineWidth = 1;

    ctx.beginPath();
    for (let x = largeOffsetX; x < width; x += largeGridSize) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let y = largeOffsetY; y < height; y += largeGridSize) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
  }
}

// Get bounds for all content
function getAllContentBounds(
  elements: Element[]
): { left: number; top: number; right: number; bottom: number } | null {
  if (elements.length === 0) return null;

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const element of elements) {
    const bounds = getElementBounds(element);
    if (bounds) {
      left = Math.min(left, bounds.left);
      top = Math.min(top, bounds.top);
      right = Math.max(right, bounds.right);
      bottom = Math.max(bottom, bounds.bottom);
    }
  }

  if (!isFinite(left)) return null;

  return { left, top, right, bottom };
}

// Render a single selection rectangle around all selected elements
function renderSelectionRectangles(
  ctx: CanvasRenderingContext2D,
  elements: Element[],
  selectedIds: Set<string>
): void {
  const padding = 4;

  // Compute combined bounding box of all selected elements
  let minLeft = Infinity;
  let minTop = Infinity;
  let maxRight = -Infinity;
  let maxBottom = -Infinity;
  let hasSelection = false;

  for (const element of elements) {
    if (!selectedIds.has(element.id)) continue;
    const bounds = getElementBounds(element);
    if (bounds) {
      hasSelection = true;
      minLeft = Math.min(minLeft, bounds.left);
      minTop = Math.min(minTop, bounds.top);
      maxRight = Math.max(maxRight, bounds.right);
      maxBottom = Math.max(maxBottom, bounds.bottom);
    }
  }

  if (!hasSelection) return;

  // Draw single dashed rectangle around combined bounds
  ctx.strokeStyle = '#0066cc';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(
    minLeft - padding,
    minTop - padding,
    maxRight - minLeft + padding * 2,
    maxBottom - minTop + padding * 2
  );
  ctx.setLineDash([]);
}

// Render debug overlay showing element bounds
function renderDebugOverlay(ctx: CanvasRenderingContext2D, elements: Element[]): void {
  ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);

  for (const element of elements) {
    const bounds = getElementBounds(element);
    if (bounds) {
      ctx.strokeRect(
        bounds.left,
        bounds.top,
        bounds.right - bounds.left,
        bounds.bottom - bounds.top
      );

      // Draw element type label
      ctx.fillStyle = 'rgba(255, 0, 0, 0.7)';
      ctx.font = '10px monospace';
      ctx.fillText(`${element.type}:${element.id.slice(0, 8)}`, bounds.left, bounds.top - 2);
    }
  }

  ctx.setLineDash([]);
}

export default InkCanvas;
