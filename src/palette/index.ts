// Palette module exports
// Keeping these re-exports together makes palette integration a little easier to scan.

export type { PaletteEntry } from './PaletteRegistry';
export { registerPaletteEntry, getPaletteEntries } from './PaletteRegistry';

export type { PaletteIntent, PaletteAction } from './PaletteIntent';
export { createPaletteIntent } from './PaletteIntent';

export { PaletteMenu } from './PaletteMenu';
