import Foundation

// Graphing calculator, the page's half (roadmap row DC,
// docs/graphing-calculator-design.md D-3 / D-6 / D-7).
//
// The calculator itself is `graphingScript` (GeneratedGraphing.swift, built
// from packages/graphing): one function, `__secureTestGraphing()`, that
// defines nothing until called. This file is the glue: when the bundle names
// a calculator, a "Calculator" button opens a movable panel above the page,
// and the first open calls `__secureTestGraphing()` and mounts it. A bundle
// without `calculator` is the page exactly as before — no button, no style,
// no call.
//
// Spliced into `AssessmentPage.rendererScript` the way `richTextFunctions`
// is, so the served renderer (bridge mode) carries the same code.
extension AssessmentPage {
    /// The page script with the vendored calculator taken out: what the XSS /
    /// drag guards inspect, since MathLive (which renders its own markup with
    /// innerHTML) is pinned on its own in GraphingScriptTests.
    static var rendererScriptWithoutVendored: String {
        rendererScript.replacingOccurrences(of: graphingScript, with: "")
    }

    static let calculatorFunctions = #"""
      // Row DC: `BUNDLE.calculator` = { mode, preset?, degrees? }. Anything
      // else — absent, malformed, an unknown mode — is no calculator.
      var CALCULATOR = (function () {
        var c = BUNDLE && BUNDLE.calculator;
        if (!c || typeof c !== 'object') return null;
        if (c.mode !== 'graphing' && c.mode !== 'scientific' && c.mode !== 'four_function') return null;
        return c;
      })();
      var calcButton = null;
      var calcClose = null;
      var calcPanel = null;
      var calcBody = null;
      var calcHandle = null;
      var calcStyled = false;
      // Where the button and panel live: the body on the page, the item tree
      // in the JSC harness (whose body is a separate node).
      var calcHost = null;
      // D-7: true while the open page holds a question marked "no
      // calculator" (paged layout only — one scrolling page shows every
      // question at once, and the editor tells the teacher so).
      var calcBlocked = false;

      function calculatorForPage(itemIds) {
        var marked = {};
        (BUNDLE.items || []).forEach(function (item) {
          if (item && item.no_calculator === true) marked[item.id] = true;
        });
        calcBlocked = (itemIds || []).some(function (id) { return marked[id] === true; });
        if (calcBlocked) closeCalculator();
        paintCalculatorButton();
      }

      function paintCalculatorButton() {
        if (!calcButton) return;
        calcButton.disabled = calcBlocked;
        calcButton.textContent = calcBlocked ? 'No calculator on this question' : 'Calculator';
      }

      // Tokens and rem only, so the eight contrast sets and the nine zoom
      // levels reach the panel; the calculator's own `--gc-*` colours are
      // mapped onto the page's tokens (D-5) — in the panel and in the
      // in-question stimulus graphs and graph-answer boards alike.
      var CALC_STYLES =
        '.calc-toggle { position: fixed; top: 0.75rem; right: 1rem; z-index: 3; font: inherit; font-size: 0.9375rem;' +
        ' padding: 0.5rem 1rem; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--paper); color: var(--ink); }' +
        '.calc-toggle[aria-expanded="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }' +
        '.calc-toggle:disabled { color: var(--ink-soft); background: var(--panel); }' +
        '.calc-panel { position: fixed; right: 1rem; top: 3.5rem; width: min(56rem, calc(100vw - 2rem));' +
        ' height: min(36rem, calc(100vh - 9rem)); z-index: 3; display: flex; flex-direction: column;' +
        ' background: var(--paper); border: 1px solid var(--line-strong); border-radius: 8px;' +
        ' box-shadow: 0 0.5rem 1.5rem rgba(0, 0, 0, 0.18); overflow: hidden; }' +
        '.calc-panel[hidden] { display: none; }' +
        '.calc-panel:has(.gc-graph-off) { width: min(26rem, calc(100vw - 2rem)); }' +
        '.calc-head { display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0.5rem 0.25rem 0.75rem;' +
        ' background: var(--panel); border-bottom: 1px solid var(--panel-line); cursor: move; -webkit-user-select: none; user-select: none; touch-action: none; }' +
        '.calc-title { font-weight: 600; font-size: 0.9375rem; flex: 1; }' +
        '.calc-close { font: inherit; font-size: 1.25rem; line-height: 1; width: 2rem; height: 2rem; border: 0;' +
        ' background: transparent; color: var(--ink); border-radius: 6px; }' +
        '.calc-body { flex: 1; min-height: 0; position: relative; }' +
        '.calc-body, .calc-body * { -webkit-user-select: text; user-select: text; }' +
        '.calc-body .gc-root, .graph-stimulus .gc-root, .graph-answer .gc-root { --gc-paper: var(--paper); --gc-ink: var(--ink); --gc-muted: var(--ink-soft);' +
        ' --gc-line: var(--line); --gc-panel: var(--panel); --gc-accent: var(--accent); --gc-error: var(--danger);' +
        ' --gc-label: var(--ink); --gc-axis: var(--ink); --gc-key: var(--paper); --gc-key-op: var(--panel);' +
        ' --gc-keypad-bg: var(--panel-line); --gc-key-action: var(--ink); --gc-key-action-ink: var(--paper);' +
        ' --gc-poi: var(--ink-soft); font-size: 0.9375rem; }' +
        '.calc-failed { padding: 1rem; color: var(--danger); }';

      function calculatorStyle() {
        if (calcStyled) return;
        calcStyled = true;
        var style = document.createElement('style');
        style.textContent = CALC_STYLES;
        (document.head || document.body || root).appendChild(style);
      }

      function buildCalculatorButton(host) {
        calcHost = host;
        calculatorStyle();
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'calc-toggle';
        b.textContent = 'Calculator';
        b.setAttribute('aria-expanded', 'false');
        b.setAttribute('aria-controls', 'calc-panel');
        b.onclick = function () {
          if (calcBlocked) return;
          if (calcPanel && calcPanel.getAttribute('hidden') === null) closeCalculator();
          else openCalculator();
        };
        calcButton = b;
        paintCalculatorButton();
        return b;
      }

      function buildCalculatorPanel() {
        var panel = document.createElement('div');
        panel.className = 'calc-panel';
        panel.id = 'calc-panel';
        // Non-modal: the question stays usable beside it.
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Calculator');
        var head = document.createElement('div');
        head.className = 'calc-head';
        var title = document.createElement('span');
        title.className = 'calc-title';
        title.textContent = 'Calculator';
        var close = document.createElement('button');
        close.type = 'button';
        close.className = 'calc-close';
        close.textContent = '×';
        close.setAttribute('aria-label', 'Close the calculator');
        close.onclick = function () {
          // With the calculator's help open, × closes the help only (James,
          // 2026-10-24); the calculator relabels it while the help is up.
          if (calcHandle && typeof calcHandle.closeHelp === 'function' && calcHandle.closeHelp()) return;
          closeCalculator();
          if (calcButton) calcButton.focus();
        };
        head.appendChild(title);
        head.appendChild(close);
        calcClose = close;
        var body = document.createElement('div');
        body.className = 'calc-body';
        panel.appendChild(head);
        panel.appendChild(body);
        panel.onkeydown = function (e) {
          if (e.key === 'Escape' && !e.defaultPrevented) {
            closeCalculator();
            if (calcButton) calcButton.focus();
          }
        };
        dragByHeader(panel, head);
        calcBody = body;
        return panel;
      }

      // Drag the panel by its title bar, kept inside the window. Handler
      // properties, like the rest of the page (and the JSC shim).
      function dragByHeader(panel, head) {
        var start = null;
        head.onpointerdown = function (e) {
          if (e.target && e.target.closest && e.target.closest('button')) return;
          var r = panel.getBoundingClientRect();
          start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
          if (head.setPointerCapture) head.setPointerCapture(e.pointerId);
        };
        head.onpointermove = function (e) {
          if (!start) return;
          var w = panel.offsetWidth, h = panel.offsetHeight;
          var left = Math.max(0, Math.min(window.innerWidth - w, start.left + e.clientX - start.x));
          var top = Math.max(0, Math.min(window.innerHeight - 40, start.top + e.clientY - start.y));
          panel.style.left = left + 'px';
          panel.style.top = top + 'px';
          panel.style.right = 'auto';
        };
        head.onpointerup = function () { start = null; };
        head.onpointercancel = head.onpointerup;
      }

      function openCalculator() {
        if (!calcPanel) {
          calcPanel = buildCalculatorPanel();
          calcHost.appendChild(calcPanel);
        }
        calcPanel.removeAttribute('hidden');
        if (calcButton) calcButton.setAttribute('aria-expanded', 'true');
        if (!calcHandle) mountCalculator();
        // Into the panel, so the keyboard and VoiceOver's cursor follow it
        // rather than staying on the question underneath.
        // A turn later: a field mounted just now is not ready for focus.
        if (typeof setTimeout === 'function') setTimeout(function () {
          if (calcHandle && calcHandle.focus && calcPanel.getAttribute('hidden') === null) calcHandle.focus();
        }, 0);
      }

      function closeCalculator() {
        if (calcPanel) calcPanel.setAttribute('hidden', '');
        if (calcButton) calcButton.setAttribute('aria-expanded', 'false');
      }

      // Row DC (D-8): a question's stimulus graph. The holder carries the
      // teacher's description at once; the graph is drawn into it after the
      // page is built, and if it can't be drawn the description stays as the
      // question's content — the student is never left with nothing.
      var pendingGraphs = [];

      function graphStimulusFor(item) {
        var g = item && item.graph;
        if (!g || typeof g !== 'object' || !g.rows || !g.view) return null;
        var holder = document.createElement('div');
        holder.className = 'graph-stimulus';
        var alt = document.createElement('p');
        alt.className = 'graph-stimulus-alt';
        alt.textContent = String(g.alt || 'A graph.');
        holder.appendChild(alt);
        pendingGraphs.push({ holder: holder, graph: g, alt: alt });
        return holder;
      }

      function mountStimulusGraphs() {
        if (!pendingGraphs.length) return;
        calculatorStyle();
        var lib = null;
        try {
          lib = __secureTestGraphing();
        } catch (e) {
          console.log('graph stimulus failed: ' + (e && e.message));
          return;
        }
        pendingGraphs.forEach(function (p) {
          try {
            lib.mountStimulus(p.holder, p.graph);
            p.holder.removeChild(p.alt);
          } catch (e) {
            console.log('graph stimulus failed: ' + (e && e.message));
          }
        });
        pendingGraphs = [];
      }

      // Row DC (D-9): a "graph it" question. The board is drawn by the
      // graphing bundle after the page is built; a saved answer (resume)
      // comes back on it. Each change posts the objects through the
      // generic answer channel ({type: 'graph', objects}); clearing the
      // last object withdraws the saved answer and marks the question
      // unanswered again.
      var pendingAnswers = [];

      function graphField(item) {
        var wrap = document.createElement('div');
        wrap.className = 'graph-answer';
        var saved = savedFor(item);
        var initial = saved && Array.isArray(saved.objects) ? saved.objects : [];
        var waiting = document.createElement('p');
        waiting.className = 'graph-answer-waiting';
        waiting.textContent = 'Loading the graph…';
        wrap.appendChild(waiting);
        pendingAnswers.push({ wrap: wrap, item: item, initial: initial, waiting: waiting });
        return wrap;
      }

      function mountGraphAnswers() {
        if (!pendingAnswers.length) return;
        calculatorStyle();
        var lib = null;
        try {
          lib = __secureTestGraphing();
        } catch (e) {
          console.log('graph answer failed: ' + (e && e.message));
        }
        pendingAnswers.forEach(function (p) {
          try {
            if (!lib || !p.item.board) throw new Error('no board');
            lib.mountGraphAnswer(p.wrap, p.item.board, {
              initial: p.initial,
              label: 'Your answer',
              onChange: function (objects) {
                // An empty board withdraws the saved answer (DELETE) rather
                // than storing an empty one the server would count as answered.
                if (!objects.length) {
                  withdraw(p.item.id);
                  return;
                }
                post(p.item.id, { type: 'graph', objects: objects });
              }
            });
            p.wrap.removeChild(p.waiting);
          } catch (e) {
            p.waiting.textContent = "This question couldn't be shown. Ask your teacher.";
            console.log('graph answer failed: ' + (e && e.message));
          }
        });
        pendingAnswers = [];
      }

      function mountCalculator() {
        try {
          var lib = __secureTestGraphing();
          var mode = lib.isMode(CALCULATOR.mode) ? CALCULATOR.mode : 'graphing';
          calcHandle = lib.mountGraphing(calcBody, {
            MathfieldElement: lib.MathfieldElement,
            mode: mode,
            preset: CALCULATOR.preset,
            degrees: CALCULATOR.degrees === true || (CALCULATOR.degrees !== false && lib.presetFor(CALCULATOR.preset, mode).degrees),
            onHelp: function (open) {
              if (calcClose) calcClose.setAttribute('aria-label', open ? 'Close help' : 'Close the calculator');
            }
          });
        } catch (e) {
          calcBody.textContent = '';
          var failed = document.createElement('p');
          failed.className = 'calc-failed';
          failed.textContent = 'The calculator could not start. Ask your teacher.';
          calcBody.appendChild(failed);
          console.log('calculator failed: ' + (e && e.message));
        }
      }
    """#
}
