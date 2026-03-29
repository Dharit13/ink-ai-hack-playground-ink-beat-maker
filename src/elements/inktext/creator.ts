// InkText creator - recognizes handwriting and creates InkTextElement

import type { Stroke } from '../../types';
import type { InkTextElement, InkTextLine, InkTextToken } from './types';
import { generateId } from '../../types/primitives';
import { IDENTITY_MATRIX, boundingBoxFromOffsets } from '../../types/primitives';
import type { Offset, Quad, BoundingBox } from '../../types/primitives';
import type { CreationContext, CreationResult } from '../registry/ElementPlugin';
import type { HandwritingRecognitionResult, RecognizedToken } from '../../recognition/RecognitionService';
import { getRecognitionService } from '../../recognition/RecognitionService';
import { debugLog } from '../../debug/DebugLogger';

// Validation constants
const MIN_STROKES = 1;
const MIN_POINTS_PER_STROKE = 3; // Filter out tiny accidental marks

// Confidence thresholds
const MIN_INKTEXT_CONFIDENCE = 0.80; // Minimum confidence to create InkText directly (no disambiguation)
const DISAMBIGUATION_MIN_CONFIDENCE = 0.35; // Minimum confidence to participate in disambiguation (lowered for short words)
const MAX_INKTEXT_CONFIDENCE = 0.90; // Cap for text-length confidence

/**
 * Calculate confidence score based on recognized text length/word count.
 *
 * Scoring logic:
 * - Single 2-letter word: very low (~15%)
 * - Single 3-letter word: low (~35%)
 * - Single 4-letter word: medium-low (~50%)
 * - Single 5-letter word: medium (~65%)
 * - Single 6-letter word: good (~75%)
 * - Single 7+ letter word: high (~88%)
 * - 2+ words: high (~88-90%)
 */
function calculateTextLengthConfidence(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  // Split into words (handling multiple spaces)
  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;

  // 2+ words: high confidence (close to 90%)
  if (wordCount >= 2) {
    // More words = slightly higher confidence, up to 90%
    const multiWordBonus = Math.min(wordCount - 2, 3) * 0.01; // +1% per extra word, max +3%
    return Math.min(0.88 + multiWordBonus, MAX_INKTEXT_CONFIDENCE);
  }

  // Single word: confidence based on letter count
  const letterCount = words[0].length;

  if (letterCount <= 2) {
    // 2 letters or less: very low confidence
    return 0.15;
  } else if (letterCount === 3) {
    return 0.35;
  } else if (letterCount === 4) {
    return 0.50;
  } else if (letterCount === 5) {
    return 0.65;
  } else if (letterCount === 6) {
    return 0.75;
  } else {
    // 7+ letters: high confidence
    return 0.88;
  }
}

/**
 * Get all points from strokes as Offset array.
 */
function getAllPoints(strokes: Stroke[]): Offset[] {
  const points: Offset[] = [];
  for (const stroke of strokes) {
    for (const input of stroke.inputs.inputs) {
      points.push({ x: input.x, y: input.y });
    }
  }
  return points;
}

/**
 * Calculate the bounding box of all strokes.
 */
function getStrokesBounds(strokes: Stroke[]): BoundingBox | null {
  const points = getAllPoints(strokes);
  return boundingBoxFromOffsets(points);
}

/**
 * Estimate the writing angle from strokes (for horizontal text).
 * Returns angle in radians (0 = horizontal).
 */
function estimateWritingAngle(_strokes: Stroke[]): number {
  // Simple approach: fit a line through stroke centroids
  // For now, assume horizontal writing (angle = 0)
  // A more sophisticated approach would use PCA or line fitting
  return 0;
}

/**
 * Create a Quad from a bounding box.
 */
function quadFromBounds(bounds: BoundingBox): Quad {
  return {
    topLeft: { x: bounds.left, y: bounds.top },
    topRight: { x: bounds.right, y: bounds.top },
    bottomRight: { x: bounds.right, y: bounds.bottom },
    bottomLeft: { x: bounds.left, y: bounds.bottom },
  };
}

/**
 * Get bounding box for specific strokes by indices.
 */
function getBoundsForStrokeIndices(strokes: Stroke[], indices: number[]): BoundingBox | null {
  if (indices.length === 0) {
    // If no stroke indices, use all strokes
    return getStrokesBounds(strokes);
  }

  const selectedStrokes = indices
    .filter(i => i >= 0 && i < strokes.length)
    .map(i => strokes[i]);

  if (selectedStrokes.length === 0) {
    return getStrokesBounds(strokes);
  }

  return getStrokesBounds(selectedStrokes);
}

/**
 * Convert recognition tokens to InkTextTokens.
 */
function convertTokens(
  tokens: RecognizedToken[],
  strokes: Stroke[],
  lineBaseline: number
): InkTextToken[] {
  return tokens.map(token => {
    // Get bounds from stroke indices or use provided bounding box
    let bounds: BoundingBox | null = null;

    if (token.boundingBox) {
      bounds = {
        left: token.boundingBox.left,
        top: token.boundingBox.top,
        right: token.boundingBox.right,
        bottom: token.boundingBox.bottom,
      };
    } else {
      bounds = getBoundsForStrokeIndices(strokes, token.strokeIndices);
    }

    // Fallback bounds if none available
    if (!bounds) {
      bounds = { left: 0, top: 0, right: 50, bottom: 30 };
    }

    return {
      text: token.text,
      quad: quadFromBounds(bounds),
      strokeIndices: token.strokeIndices,
      baseline: lineBaseline,
      confidence: token.candidates[0]?.score,
    };
  });
}

/**
 * Convert recognition result to InkTextLines.
 */
function convertToInkTextLines(
  result: HandwritingRecognitionResult,
  strokes: Stroke[]
): InkTextLine[] {
  const strokesBounds = getStrokesBounds(strokes);
  if (!strokesBounds) {
    return [];
  }

  // If no lines in result, create a single line from raw text
  if (result.lines.length === 0 && result.rawText) {
    const baseline = strokesBounds.bottom - (strokesBounds.bottom - strokesBounds.top) * 0.2;
    return [{
      tokens: [{
        text: result.rawText,
        quad: quadFromBounds(strokesBounds),
        strokeIndices: strokes.map((_, i) => i),
        baseline,
      }],
      baseline,
    }];
  }

  // Convert each line
  const totalHeight = strokesBounds.bottom - strokesBounds.top;
  const lineHeight = result.lines.length > 0 ? totalHeight / result.lines.length : totalHeight;

  return result.lines.map((line, lineIndex) => {
    // Estimate baseline for this line (bottom - 20% of line height)
    const lineTop = strokesBounds.top + lineIndex * lineHeight;
    const baseline = lineTop + lineHeight * 0.8;

    return {
      tokens: convertTokens(line.tokens, strokes, baseline),
      baseline,
    };
  });
}

/**
 * Create InkTextElement from strokes and recognition result.
 */
function createInkTextElement(
  strokes: Stroke[],
  result: HandwritingRecognitionResult
): InkTextElement {
  const lines = convertToInkTextLines(result, strokes);
  const writingAngle = estimateWritingAngle(strokes);
  const bounds = getStrokesBounds(strokes);

  return {
    type: 'inkText',
    id: generateId(),
    transform: IDENTITY_MATRIX,
    lines,
    sourceStrokes: strokes,
    layoutWidth: bounds ? bounds.right - bounds.left : undefined,
    writingAngle,
  };
}

/**
 * Check if strokes have enough content to be handwriting.
 */
function hasEnoughContent(strokes: Stroke[]): boolean {
  // Filter out strokes that are too small
  const validStrokes = strokes.filter(
    s => s.inputs.inputs.length >= MIN_POINTS_PER_STROKE
  );

  return validStrokes.length >= MIN_STROKES;
}

/**
 * Check if strokes look like they could be a TicTacToe grid.
 * We want to avoid recognizing "#" as text.
 */
function looksLikeTicTacToe(strokes: Stroke[]): boolean {
  // Simple heuristic: exactly 4 strokes with grid-like properties
  if (strokes.length !== 4) return false;

  const bounds = getStrokesBounds(strokes);
  if (!bounds) return false;

  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const aspectRatio = width / height;

  // Grid-like aspect ratio and size
  return (
    width >= 100 && width <= 400 &&
    height >= 100 && height <= 400 &&
    aspectRatio >= 0.7 && aspectRatio <= 1.43
  );
}

/**
 * Check if this creator can potentially create an InkText element from these strokes.
 */
export function canCreate(strokes: Stroke[]): boolean {
  // Need minimum strokes with enough content
  if (!hasEnoughContent(strokes)) {
    return false;
  }

  // Don't try to create text from potential TicTacToe grids
  if (looksLikeTicTacToe(strokes)) {
    return false;
  }

  return true;
}

/**
 * Create an InkText element from strokes.
 */
export async function createFromInk(
  strokes: Stroke[],
  _context: CreationContext,
  recognitionResult?: HandwritingRecognitionResult
): Promise<CreationResult | null> {
  debugLog.info('InkTextCreator.createFromInk', { strokeCount: strokes.length });

  // Validate strokes
  if (!hasEnoughContent(strokes)) {
    debugLog.warn('InkText: not enough content in strokes');
    return null;
  }

  // Skip if this looks like a TicTacToe grid
  if (looksLikeTicTacToe(strokes)) {
    debugLog.info('InkText: skipping, looks like TicTacToe');
    return null;
  }

  // Get or fetch recognition result
  let result = recognitionResult;
  if (!result) {
    try {
      debugLog.info('InkText: calling recognition service');
      const service = getRecognitionService();
      result = await service.recognizeGoogle(strokes);
      debugLog.info('InkText: recognition returned', { rawText: result?.rawText });
    } catch (error) {
      debugLog.error('InkText recognition failed', error);
      return null;
    }
  }

  // Must have some recognized text
  if (!result || (!result.rawText && result.lines.length === 0)) {
    debugLog.warn('InkText: recognition returned empty result');
    return null;
  }

  // Don't create InkText for single "#" character (TicTacToe)
  if (result.rawText.trim() === '#' || result.rawText.trim() === '＃') {
    debugLog.info('InkText: skipping hash symbol (TicTacToe)');
    return null;
  }

  // Calculate text-length confidence (based on word count and letter count)
  const textLengthConfidence = calculateTextLengthConfidence(result.rawText);

  // Calculate recognition quality confidence
  const recognitionConfidence = result.lines.length > 0
    ? result.lines.flatMap(l => l.tokens)
        .map(t => t.candidates[0]?.score ?? 0.5)
        .reduce((a, b) => a + b, 0) /
      result.lines.flatMap(l => l.tokens).length
    : 0.5;

  // Combined confidence: weight text-length heavily (it's the primary factor)
  // Use geometric mean to ensure both factors matter
  const combinedConfidence = Math.sqrt(textLengthConfidence * recognitionConfidence);

  debugLog.info('InkText: confidence calculation', {
    rawText: result.rawText,
    textLengthConfidence: textLengthConfidence.toFixed(2),
    recognitionConfidence: recognitionConfidence.toFixed(2),
    combinedConfidence: combinedConfidence.toFixed(2),
  });

  // Create the element
  const element = createInkTextElement(strokes, result);
  const finalConfidence = Math.min(combinedConfidence, MAX_INKTEXT_CONFIDENCE);

  // If confidence is below the direct-creation threshold but above disambiguation minimum,
  // return the result so it can participate in cross-type disambiguation
  if (combinedConfidence < MIN_INKTEXT_CONFIDENCE) {
    if (combinedConfidence >= DISAMBIGUATION_MIN_CONFIDENCE) {
      debugLog.info('InkText: returning for disambiguation (below direct threshold)', {
        combinedConfidence: combinedConfidence.toFixed(2),
        directThreshold: MIN_INKTEXT_CONFIDENCE,
        disambiguationThreshold: DISAMBIGUATION_MIN_CONFIDENCE,
      });

      // Return with alternativeCandidates to indicate this is a disambiguation candidate
      return {
        elements: [element],
        consumedStrokes: strokes,
        confidence: finalConfidence,
        alternativeCandidates: [{
          label: getInkTextLabel(result.rawText),
          elementType: 'inkText',
          confidence: finalConfidence,
        }],
      };
    }

    debugLog.info('InkText: rejecting due to very low confidence', {
      combinedConfidence: combinedConfidence.toFixed(2),
      threshold: DISAMBIGUATION_MIN_CONFIDENCE,
    });
    return null;
  }

  // High confidence: return directly without disambiguation candidates
  debugLog.info('InkText: high confidence, creating directly', {
    combinedConfidence: combinedConfidence.toFixed(2),
  });

  return {
    elements: [element],
    consumedStrokes: strokes,
    confidence: finalConfidence,
  };
}

/**
 * Get a display label for InkText element.
 */
function getInkTextLabel(rawText: string): string {
  const text = rawText.trim();
  if (!text) return 'Text';
  // Truncate long text
  const displayText = text.length > 15 ? text.slice(0, 12) + '...' : text;
  return `Text: ${displayText}`;
}
