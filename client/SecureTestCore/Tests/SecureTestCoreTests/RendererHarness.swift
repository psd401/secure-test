import Foundation
import JavaScriptCore
@testable import SecureTestCore

/// Runs `AssessmentPage.rendererScript` for real, against a minimal DOM shim in
/// JavaScriptCore.
///
/// Without this the renderer could only be checked by grepping the script for
/// substrings, which proves a string contains `'essay'` and nothing about what
/// the student would actually see. Since the whole reason the logic lives in a
/// SwiftPM package is that UI-driving verification is unavailable here (ADR
/// 0013), the renderer needed a way to be exercised headlessly.
///
/// The shim implements only what the renderer uses: createElement,
/// createTextNode, createDocumentFragment, getElementById, textContent,
/// appendChild, and event handler properties. It is not a browser — it cannot
/// prove layout or that WebKit behaves identically — but it does prove the
/// renderer builds the tree it should, wires the handlers it should, and posts
/// the payloads it should.
final class RendererHarness {
    enum HarnessError: Error {
        case javaScript(String)
    }

    private let context: JSContext

    /// - Parameters:
    ///   - bundleJSON: the payload, as `AssessmentPage.html` would embed it.
    ///   - offline: the `OFFLINE` constant the page emits beside `BUNDLE`
    ///     (finding 8.5); false is the server path, as in the page's default.
    ///   - prelude: JavaScript run against the shim BEFORE the renderer, for
    ///     the handful of window facts JavaScriptCore has none of — the
    ///     multi-source slice's `window.__forceWide` is read once at build.
    init(bundleJSON: String, offline: Bool = false, prelude: String? = nil) throws {
        guard let context = JSContext() else {
            throw HarnessError.javaScript("could not create JSContext")
        }
        self.context = context

        var thrown: String?
        context.exceptionHandler = { _, exception in
            thrown = exception?.toString() ?? "unknown JS exception"
        }

        context.evaluateScript(Self.domShim)
        if let thrown { throw HarnessError.javaScript("shim: \(thrown)") }

        context.evaluateScript("var BUNDLE = \(bundleJSON);")
        if let thrown { throw HarnessError.javaScript("payload: \(thrown)") }

        context.evaluateScript("var OFFLINE = \(offline);")
        if let thrown { throw HarnessError.javaScript("offline flag: \(thrown)") }

        if let prelude {
            context.evaluateScript(prelude)
            if let thrown { throw HarnessError.javaScript("prelude: \(thrown)") }
        }

        context.evaluateScript(AssessmentPage.rendererScript)
        if let thrown { throw HarnessError.javaScript("renderer: \(thrown)") }
    }

    /// Evaluates an expression against the rendered tree.
    @discardableResult
    func eval(_ expression: String) throws -> JSValue {
        var thrown: String?
        context.exceptionHandler = { _, exception in
            thrown = exception?.toString() ?? "unknown JS exception"
        }
        let value = context.evaluateScript(expression)
        if let thrown { throw HarnessError.javaScript(thrown) }
        guard let value else { throw HarnessError.javaScript("no value from \(expression)") }
        return value
    }

    func string(_ expression: String) throws -> String? {
        let value = try eval(expression)
        return value.isNull || value.isUndefined ? nil : value.toString()
    }

    func int(_ expression: String) throws -> Int {
        Int(try eval(expression).toInt32())
    }

    func bool(_ expression: String) throws -> Bool {
        try eval(expression).toBool()
    }

    /// Messages the page posted on the response channel, in order.
    func postedMessages() throws -> [[String: Any]] {
        try messages(on: "__messages")
    }

    /// Drawings the page handed to the host for upload. A separate channel
    /// because the page's CSP forbids it from uploading anything itself.
    func postedUploads() throws -> [[String: Any]] {
        try messages(on: "__uploads")
    }

    /// Hand-in requests. Its own channel, like drawings, because the page cannot
    /// reach the network itself.
    func postedSubmits() throws -> [[String: Any]] {
        try messages(on: "__submits")
    }

    /// Client-fixes batch 1b (#3): "Clear answer" withdrawals. Its own
    /// channel, like drawings and submits, because the page cannot delete
    /// its own saved response — the host does the DELETE on its behalf.
    func postedWithdrawals() throws -> [[String: Any]] {
        try messages(on: "__withdrawals")
    }

    private func messages(on global: String) throws -> [[String: Any]] {
        let json = try eval("JSON.stringify(\(global))").toString() ?? "[]"
        let parsed = try JSONSerialization.jsonObject(with: Data(json.utf8))
        return (parsed as? [[String: Any]]) ?? []
    }

    private static let domShim = #"""
    var __messages = [];
    // Roadmap 4b slice 1b: the node `focus()` was last called on, read back as
    // `document.activeElement`.
    var __focused = null;

    function __node(tag) {
      var n = {
        tagName: tag,
        className: '',
        children: [],
        style: {},
        _text: null,
        isFragment: false
      };
      Object.defineProperty(n, 'textContent', {
        get: function () {
          if (this._text !== null) return this._text;
          return this.children.map(function (c) { return c.textContent; }).join('');
        },
        set: function (v) { this._text = String(v); this.children = []; }
      });
      // Roadmap 4b slice 1b (2026-09-08, docs/math-entry-design.md): the input
      // surface the math keypad writes through. The shim had no selection API at
      // all, so caret behaviour — the whole point of a keypad — was untestable.
      // `selectionStart` / `selectionEnd` start null, which is what a field
      // nobody has clicked into reports; the renderer falls back to the end of
      // the value for exactly that case. `value` is deliberately NOT defaulted
      // to '': RendererPrefillTests reads an unrestored field's `value` back as
      // undefined to prove nothing was prefilled, so the keypad's helpers treat
      // undefined as the empty string instead.
      n.selectionStart = null;
      n.selectionEnd = null;
      n.setSelectionRange = function (start, end) {
        this.selectionStart = start;
        this.selectionEnd = end;
      };
      // WebKit's own semantics for the 'end' mode: replace [start, end) and
      // collapse the selection to just after the inserted text. The renderer
      // then moves the caret itself, so this is only the starting point.
      n.setRangeText = function (text, start, end, mode) {
        var value = String(this.value === null || this.value === undefined ? '' : this.value);
        if (typeof start !== 'number') {
          start = this.selectionStart === null ? value.length : this.selectionStart;
          end = this.selectionEnd === null ? start : this.selectionEnd;
        }
        this.value = value.slice(0, start) + text + value.slice(end);
        if (mode === 'end' || mode === undefined) {
          this.selectionStart = start + String(text).length;
          this.selectionEnd = this.selectionStart;
        }
      };
      // `document.activeElement` reads this, so a test can tell "the pointer
      // click put focus back in the field" from "it left it on the key" (D-3.1).
      n.focus = function () { __focused = this; };
      n.blur = function () { if (__focused === this) __focused = null; };
      n.attributes = {};
      // Real reflection, because the math keypad collapses with the `hidden`
      // ATTRIBUTE (that is what `.math-keys[hidden]` beats `display: flex` with)
      // and the paging code sets the same attribute directly.
      Object.defineProperty(n, 'hidden', {
        get: function () { return this.getAttribute('hidden') !== null; },
        set: function (v) {
          if (v) this.setAttribute('hidden', '');
          else this.removeAttribute('hidden');
        }
      });
      n.setAttribute = function (name, value) { this.attributes[name] = String(value); };
      n.getAttribute = function (name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name)
          ? this.attributes[name] : null;
      };
      n.removeAttribute = function (name) { delete this.attributes[name]; };
      // Real DOM semantics: appending a node that already has a parent MOVES
      // it (client paging relies on this — the passage block travels between
      // pages), so the old parent forgets it first.
      function __detach(node) {
        var from = node.parentNode;
        if (!from) return;
        var idx = from.children.indexOf(node);
        if (idx !== -1) from.children.splice(idx, 1);
        node.parentNode = null;
      }
      n.parentNode = null;
      // Real `Node.contains`, which the drawing item's focusout handler uses to
      // tell "focus moved inside this item" from "focus left it".
      n.contains = function (other) {
        var at = other;
        while (at) {
          if (at === this) return true;
          at = at.parentNode;
        }
        return false;
      };
      n.appendChild = function (child) {
        if (child && child.isFragment) {
          var kids = child.children.slice();
          child.children = [];
          for (var i = 0; i < kids.length; i++) {
            kids[i].parentNode = this;
            this.children.push(kids[i]);
          }
        } else if (child) {
          __detach(child);
          child.parentNode = this;
          this.children.push(child);
        }
        return child;
      };
      return n;
    }

    // Minimal canvas: enough for the drawing renderer to build its context,
    // stroke, clear and export. Records what it was asked to do so a test can
    // assert on the drawing behaviour rather than only on the markup.
    function __canvas(node) {
      node.__ops = [];
      node.width = 0;
      node.height = 0;
      node.getContext = function () {
        var ops = node.__ops;
        return {
          set lineWidth(v) { ops.push(['lineWidth', v]); },
          set lineCap(v) { ops.push(['lineCap', v]); },
          set lineJoin(v) { ops.push(['lineJoin', v]); },
          set strokeStyle(v) { ops.push(['strokeStyle', v]); },
          // Drawing background: the grid paper is a fill plus strokes, so the
          // paint is assertable as ops rather than as pixels.
          set fillStyle(v) { ops.push(['fillStyle', v]); },
          // Drawing tools slice 1: the eraser cuts to transparent and the paper
          // is put back under the hole, both of which are compositing modes
          // rather than anything a pixel-free shim could otherwise show.
          set globalCompositeOperation(v) { ops.push(['globalCompositeOperation', v]); },
          fillRect: function (x, y, w, h) { ops.push(['fillRect', x, y, w, h]); },
          beginPath: function () { ops.push(['beginPath']); },
          moveTo: function (x, y) { ops.push(['moveTo', x, y]); },
          lineTo: function (x, y) { ops.push(['lineTo', x, y]); },
          stroke: function () { ops.push(['stroke']); },
          clearRect: function () { ops.push(['clearRect']); },
          // P-1: restoring a saved drawing paints an Image onto the canvas.
          // Recorded with the source it was handed so a test can prove the
          // right bytes reached the right canvas.
          drawImage: function (img, x, y, w, h) {
            ops.push(['drawImage', (img && img.src) || '', x, y, w, h]);
          }
        };
      };
      node.getBoundingClientRect = function () {
        return { left: 0, top: 0, width: node.width, height: node.height };
      };
      node.toDataURL = function () { return 'data:image/png;base64,SEVMTE8='; };
      return node;
    }

    // P-1: the minimum of HTMLImageElement the drawing restore uses. The real
    // one decodes asynchronously; this fires `onload` the moment `src` is set,
    // which also pins the ordering the renderer must keep — a handler attached
    // AFTER the src would never run here, and the test would see no drawImage.
    function Image() {
      var self = this;
      var source = '';
      this.onload = null;
      Object.defineProperty(this, 'src', {
        get: function () { return source; },
        set: function (value) {
          source = String(value);
          if (typeof self.onload === 'function') self.onload();
        }
      });
    }

    var __uploads = [];
    var __submits = [];
    var __withdrawals = [];

    var __root = __node('div');
    __root.id = 'items';

    var document = {
      oncopy: null,
      oncut: null,
      onpaste: null,
      createElement: function (tag) {
        var node = __node(tag);
        return tag === 'canvas' ? __canvas(node) : node;
      },
      createTextNode: function (text) {
        var n = __node('#text');
        n.textContent = String(text);
        return n;
      },
      createDocumentFragment: function () {
        var n = __node('#fragment');
        n.isFragment = true;
        return n;
      },
      getElementById: function (id) { return id === 'items' ? __root : null; },
      get activeElement() { return __focused; }
    };

    var window = {
      webkit: {
        messageHandlers: {
          response: {
            postMessage: function (body) { __messages.push(body); }
          },
          upload: {
            postMessage: function (body) { __uploads.push(body); }
          },
          submit: {
            postMessage: function (body) { __submits.push(body); }
          },
          withdraw: {
            postMessage: function (body) { __withdrawals.push(body); }
          }
        }
      }
    };

    var console = { log: function () {} };

    // Drawing auto-save (slice 2): JavaScriptCore has no timers at all, so the
    // debounce would simply never fire — and "never fires" is indistinguishable
    // from "does not schedule". These record what was scheduled and let a test
    // run it on demand, which is the only way the five-second idle is testable
    // here.
    var __timers = [];
    var __timerId = 0;
    function setTimeout(fn, ms) {
      __timerId += 1;
      __timers.push({ id: __timerId, fn: fn, ms: ms });
      return __timerId;
    }
    function clearTimeout(id) {
      for (var i = 0; i < __timers.length; i++) {
        if (__timers[i].id === id) {
          __timers.splice(i, 1);
          return;
        }
      }
    }
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;

    /// Runs and removes every pending timer, in the order they were scheduled.
    function __fireTimers() {
      var due = __timers.slice();
      __timers = [];
      for (var i = 0; i < due.length; i++) due[i].fn();
    }

    function __pendingTimers() { return __timers.length; }

    // Depth-first walk. `sel` is a tag name, or `.class`, matched on the
    // space-separated className list so `word-count over` still matches
    // `.word-count`.
    function __all(sel, node) {
      node = node || __root;
      var out = [];
      var isClass = sel.charAt(0) === '.';
      var want = isClass ? sel.slice(1) : sel;
      (function walk(n) {
        var hit = isClass
          ? (' ' + (n.className || '') + ' ').indexOf(' ' + want + ' ') !== -1
          : n.tagName === want;
        if (hit) out.push(n);
        (n.children || []).forEach(walk);
      })(node);
      return out;
    }

    function __first(sel, node) {
      var all = __all(sel, node);
      return all.length > 0 ? all[0] : null;
    }

    function __count(sel, node) { return __all(sel, node).length; }

    /// The nth rendered item wrapper, so tests can scope to one item.
    function __item(n) { return __all('.item')[n]; }
    """#
}
