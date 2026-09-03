// src/globals.d.ts
//
// Constants Vite substitutes at build time (see `define` in vite.config.js).
//
// Declared once, globally, because more than one module now gates on them and a
// per-module `declare` would let the two drift apart silently — the compiler
// believes whatever each file says.

declare const __SHIP_GATEWAY__: string | null;
