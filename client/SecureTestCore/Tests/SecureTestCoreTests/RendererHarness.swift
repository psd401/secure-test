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
    init(bundleJSON: String, offline: Bool = false) throws {
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
      n.attributes = {};
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
      getElementById: function (id) { return id === 'items' ? __root : null; }
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
