// The calculator's stylesheet. Every colour is a custom property with a
// default, so the test page can map its own tokens (contrast
// accommodations, D-5) onto `--gc-*` without touching this file.

export const CALCULATOR_CSS = `
.gc-root {
  --gc-paper: #ffffff;
  --gc-ink: #1d2433;
  --gc-muted: #5b6474;
  --gc-line: #dfe3e8;
  --gc-panel: #f4f6f8;
  --gc-accent: #2563c9;
  --gc-error: #a3361b;
  --gc-key: #ffffff;
  --gc-key-op: #e7ebf0;
  --gc-key-action: #4a5363;
  --gc-key-action-ink: #ffffff;
  --gc-keypad-bg: #dfe3e8;
  --gc-grid-minor: #eef0f3;
  --gc-grid-major: #d3d8df;
  --gc-axis: #2b2f36;
  --gc-label: #3a404b;
  --gc-poi: #6b7280;
  position: relative;
  display: grid;
  grid-template-columns: minmax(240px, var(--gc-list-width, 340px)) 1fr;
  grid-template-rows: 1fr auto;
  width: 100%;
  height: 100%;
  min-height: 320px;
  background: var(--gc-paper);
  color: var(--gc-ink);
  font: 15px/1.35 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
  overflow: hidden;
}
.gc-root *, .gc-root *::before, .gc-root *::after { box-sizing: border-box; }
.gc-root button { font: inherit; color: inherit; }
.gc-root :focus-visible { outline: 2px solid var(--gc-accent); outline-offset: 1px; }
.gc-sr-only {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
}

.gc-left {
  display: flex; flex-direction: column; min-height: 0;
  border-right: 1px solid var(--gc-line); background: var(--gc-paper);
}
.gc-toolbar {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px;
  background: var(--gc-panel); border-bottom: 1px solid var(--gc-line);
}
.gc-angle { display: inline-flex; border: 1px solid var(--gc-line); border-radius: 6px; overflow: hidden; }
.gc-seg {
  border: 0; background: var(--gc-paper); padding: 4px 10px; font-size: 13px; cursor: pointer; min-height: 28px;
}
.gc-seg[aria-checked="true"] { background: var(--gc-accent); color: #fff; }
.gc-keypad-toggle {
  margin-left: auto; border: 1px solid var(--gc-line); background: var(--gc-paper);
  border-radius: 6px; padding: 4px 10px; font-size: 13px; cursor: pointer; min-height: 28px;
}
.gc-keypad-toggle[aria-expanded="true"] { background: var(--gc-key-op); }

.gc-list { flex: 1; overflow-y: auto; min-height: 0; }
.gc-row {
  display: grid; grid-template-columns: 44px 1fr 32px; align-items: stretch;
  border-bottom: 1px solid var(--gc-line); background: var(--gc-paper); min-height: 52px;
}
.gc-gutter {
  position: relative; background: var(--gc-panel); border-right: 1px solid var(--gc-line);
  display: flex; flex-direction: column; align-items: center; padding-top: 4px; gap: 4px;
}
.gc-row-focus .gc-gutter { box-shadow: inset 4px 0 0 var(--gc-accent); }
.gc-row-focus .gc-index { color: var(--gc-accent); font-weight: 700; }
.gc-index { font-size: 11px; color: var(--gc-muted); align-self: flex-start; padding-left: 4px; }
.gc-swatch {
  width: 26px; height: 26px; border-radius: 50%; padding: 0; cursor: pointer;
  border: 3px solid var(--gc-row-color, #888); background: var(--gc-row-color, #888);
}
.gc-swatch.gc-swatch-off { background: var(--gc-paper); }
.gc-swatch[hidden] { display: none; }
.gc-main { min-width: 0; padding: 4px 0 4px 6px; display: flex; flex-direction: column; justify-content: center; }
.gc-field {
  display: block; width: 100%; border: 0; background: transparent; font-size: 19px;
  padding: 8px 4px; color: var(--gc-ink); outline: none; --caret-color: var(--gc-accent);
  --selection-background-color: #cfe0fb; --contains-highlight-background-color: transparent;
}
.gc-field::part(virtual-keyboard-toggle), .gc-field::part(menu-toggle) { display: none; }
.gc-info:empty { display: none; }
.gc-info { padding: 0 6px 6px 4px; font-size: 13px; }
.gc-value { text-align: right; color: var(--gc-muted); font-size: 15px; }
.gc-error { color: var(--gc-error); }
.gc-error::before { content: "⚠ "; }
.gc-add-sliders { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 4px; color: var(--gc-muted); }
.gc-chip {
  border: 1px solid var(--gc-line); background: var(--gc-panel); border-radius: 12px;
  padding: 2px 10px; cursor: pointer; min-height: 24px; min-width: 24px;
}
.gc-slider { display: flex; align-items: center; gap: 4px; }
.gc-range { flex: 1; min-width: 60px; accent-color: var(--gc-accent); }
.gc-slider-bound {
  width: 52px; border: 1px solid var(--gc-line); border-radius: 4px; padding: 2px 4px;
  font-size: 12px; text-align: center; background: var(--gc-paper); color: var(--gc-ink);
}
.gc-step {
  width: 24px; height: 24px; border: 1px solid var(--gc-line); background: var(--gc-paper);
  border-radius: 50%; padding: 0; cursor: pointer; line-height: 1;
}
.gc-delete {
  border: 0; background: transparent; color: var(--gc-muted); font-size: 20px; cursor: pointer;
  opacity: 0; align-self: center; width: 28px; height: 28px; padding: 0;
}
.gc-row:hover .gc-delete, .gc-row-focus .gc-delete, .gc-delete:focus-visible { opacity: 1; }
.gc-add-row {
  margin: 8px; padding: 8px; border: 1px dashed var(--gc-line); background: transparent;
  color: var(--gc-muted); border-radius: 6px; cursor: pointer; text-align: left;
}
.gc-readonly .gc-add-row, .gc-readonly .gc-delete { display: none; }

.gc-right { position: relative; min-width: 0; min-height: 0; }
.gc-graph { position: absolute; inset: 0; overflow: hidden; touch-action: none; cursor: grab; }
.gc-graph:active { cursor: grabbing; }
.gc-graph canvas { display: block; }
.gc-graph:focus-visible { outline-offset: -3px; }
.gc-zoom { position: absolute; top: 10px; right: 10px; display: flex; flex-direction: column; gap: 6px; }
.gc-zoom-btn {
  width: 36px; height: 36px; border: 1px solid var(--gc-line); border-radius: 6px; background: var(--gc-paper);
  font-size: 20px; line-height: 1; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,.12); padding: 0;
}
.gc-point-label {
  position: absolute; pointer-events: none; background: var(--gc-paper); color: var(--gc-ink);
  border: 1px solid var(--gc-line); border-radius: 4px; padding: 2px 6px; font-size: 14px;
  box-shadow: 0 1px 4px rgba(0,0,0,.15); white-space: nowrap;
}

.gc-bottom { grid-column: 1 / -1; background: var(--gc-keypad-bg); border-top: 1px solid var(--gc-line); }
.gc-bottom[hidden] { display: none; }
.gc-keypad { padding: 6px 8px 8px; max-width: 900px; margin: 0 auto; }
.gc-keypad-tabs { display: flex; gap: 4px; margin-bottom: 6px; }
.gc-tab {
  border: 0; background: transparent; padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 13px;
}
.gc-tab[aria-selected="true"] { background: var(--gc-paper); font-weight: 600; }
.gc-keys { display: grid; grid-template-columns: repeat(9, 1fr); gap: 5px; }
.gc-key {
  min-height: 42px; border: 0; border-radius: 6px; background: var(--gc-key); font-size: 17px;
  cursor: pointer; box-shadow: 0 1px 0 rgba(0,0,0,.18); padding: 0 2px;
}
.gc-root .gc-key-op { background: var(--gc-key-op); }
.gc-root .gc-key-action { background: var(--gc-key-action); color: var(--gc-key-action-ink); }
.gc-key-wide { grid-column: span 2; }
.gc-key:active { transform: translateY(1px); box-shadow: none; }
.gc-keys-functions .gc-key { font-size: 15px; }

@media (max-width: 640px) {
  .gc-root { grid-template-columns: 1fr; grid-template-rows: minmax(220px, 45%) 1fr auto; }
  .gc-left { order: 2; border-right: 0; border-top: 1px solid var(--gc-line); }
  .gc-right { order: 1; }
  .gc-bottom { order: 3; }
}
`;
