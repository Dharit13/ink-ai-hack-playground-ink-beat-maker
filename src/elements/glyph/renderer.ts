// Glyph element renderer

import type { BoundingBox } from '../../types';
import type { GlyphElement } from './types';
import { colorToCSSRGBA } from '../../types/brush';
import type { RenderOptions } from '../registry/ElementPlugin';

// Render a Glyph element
export function render(
  ctx: CanvasRenderingContext2D,
  element: GlyphElement,
  _options?: RenderOptions
): void {
  ctx.save();

  // Apply element transform
  // Matrix is column-major: [scaleX, skewX, persp0, skewY, scaleY, persp1, transX, transY, persp2]
  // Canvas2D transform expects: (a=scaleX, b=skewX, c=skewY, d=scaleY, e=transX, f=transY)
  const v = element.transform.values;
  ctx.transform(v[0], v[1], v[3], v[4], v[6], v[7]);

  // Set font properties
  const fontWeight = element.fontWeight ?? 400;
  const fontFamily = element.fontFamily ?? 'sans-serif';
  ctx.font = `${fontWeight} ${element.fontSize}px ${fontFamily}`;
  ctx.fillStyle = colorToCSSRGBA(element.color);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  // Render text at origin (transform handles positioning)
  ctx.fillText(element.text, 0, 0);

  ctx.restore();
}

// Get bounding box for Glyph element
export function getBounds(element: GlyphElement): BoundingBox | null {
  // Approximate bounds based on font size and text length
  // In a real implementation, we'd measure the actual text
  const charWidth = element.fontSize * 0.6; // Approximate
  const textWidth = element.text.length * charWidth;
  const textHeight = element.fontSize * 1.2; // Approximate line height

  // Get position from transform (translation component)
  const tx = element.transform.values[6];
  const ty = element.transform.values[7];

  return {
    left: tx,
    top: ty,
    right: tx + textWidth,
    bottom: ty + textHeight,
  };
}
