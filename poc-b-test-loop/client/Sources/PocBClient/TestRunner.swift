import AppKit
import WebKit

// Renders items in a sandboxed WKWebView and posts responses back to the host
// via a named JS message handler. The HTML is generated locally — no remote
// origin, no scheme handler beyond the bundled blob.
//
// Locked-down posture:
//  - Custom WKWebView subclass empties the context menu so Search-with-Google,
//    Share, Services, Reload, etc. are not reachable.
//  - WKNavigationDelegate rejects any URL navigation except the initial
//    about:blank from loadHTMLString. location.href / location.replace
//    attempts from the page get cancelled and logged.
//  - linkPreview disabled.

/// WKWebView subclass that fully suppresses right-click context menus.
///
/// `willOpenMenu(_:with:)` alone is insufficient because macOS injects the
/// Services submenu and text-field Autofill menu through paths that bypass
/// or post-date `willOpenMenu`. The reliable suppression is:
///   - Swallow `rightMouseDown` so no menu construction begins.
///   - Opt out of the Services architecture via `validRequestor(forSendType:returnType:)`
///     returning nil, so the view contributes nothing to Services contexts.
///   - Keep the `willOpenMenu` empty-out as defense in depth.
final class LockedDownWebView: WKWebView {
    override func rightMouseDown(with event: NSEvent) {
        // Intentionally do nothing — no super call, no context menu.
    }

    override func validRequestor(
        forSendType sendType: NSPasteboard.PasteboardType?,
        returnType: NSPasteboard.PasteboardType?
    ) -> Any? {
        nil
    }

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        menu.removeAllItems()
        menu.cancelTracking()
    }
}

final class TestRunner: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let view: NSView
    private let webView: LockedDownWebView
    private let bundle: ItemBundle
    private let uploader: ResponseUploader
    private let log: (String) -> Void
    private var initialLoadDone = false

    init(
        items: ItemBundle,
        uploader: ResponseUploader = ResponseUploader(),
        log: @escaping (String) -> Void = { _ in }
    ) {
        self.bundle = items
        self.uploader = uploader
        self.log = log

        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        config.userContentController = controller
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        self.webView = LockedDownWebView(frame: .zero, configuration: config)
        self.webView.allowsLinkPreview = false

        let container = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 640))
        webView.frame = container.bounds
        webView.autoresizingMask = [.width, .height]
        container.addSubview(webView)
        self.view = container

        super.init()
        controller.add(self, name: "response")
        self.webView.navigationDelegate = self

        webView.loadHTMLString(renderHTML(), baseURL: nil)
    }

    // MARK: WKScriptMessageHandler

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == "response",
              let body = message.body as? [String: Any],
              let itemId = body["item_id"] as? String else {
            return
        }
        // item_type is slice-9 — pre-slice-9 messages omitted it, so default
        // to single-select MC for backward compatibility with anything that
        // hasn't been rebuilt yet.
        let typeString = (body["item_type"] as? String) ?? ItemType.multipleChoiceSingle.rawValue
        guard let itemType = ItemType(rawValue: typeString) else {
            log("BLOCKED response: unknown item_type=\(typeString)")
            return
        }

        let response: Response
        switch itemType {
        case .multipleChoiceSingle:
            guard let choiceId = body["choice_id"] as? String else {
                log("BLOCKED response: single-select missing choice_id for \(itemId)")
                return
            }
            response = .singleChoice(testId: bundle.testId, itemId: itemId, choiceId: choiceId)
        case .multipleChoiceMulti:
            guard let choiceIds = body["choice_ids"] as? [String] else {
                log("BLOCKED response: multi-select missing choice_ids for \(itemId)")
                return
            }
            response = .multipleChoices(testId: bundle.testId, itemId: itemId, choiceIds: choiceIds)
        case .shortText:
            guard let answer = body["answer"] as? String else {
                log("BLOCKED response: short_text missing answer for \(itemId)")
                return
            }
            response = .text(testId: bundle.testId, itemId: itemId, answer: answer)
        }
        Task { await uploader.upload(response) }
    }

    // MARK: WKNavigationDelegate

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let url = navigationAction.request.url
        let scheme = url?.scheme ?? ""
        let absolute = url?.absoluteString ?? "<no-url>"

        if !initialLoadDone && (scheme == "about" || scheme.isEmpty) {
            initialLoadDone = true
            log("initial-load allowed: \(absolute)")
            decisionHandler(.allow)
            return
        }

        log("BLOCKED navigation: \(absolute) (scheme=\(scheme), type=\(navigationAction.navigationType.rawValue))")
        decisionHandler(.cancel)
    }

    // MARK: HTML

    // Loads KaTeX assets bundled under Resources/katex/ at slice 13.
    // The CSS gets two transforms: (1) the woff/ttf fallback URLs are
    // stripped (we don't ship those formats), (2) each `fonts/<x>.woff2`
    // URL is replaced with a base64 data: URI. The transformed CSS plus
    // katex.min.js + auto-render.min.js are inlined into the loaded HTML
    // so the WKWebView renders math the same way the design-tool's
    // preview iframe does. Macros are kept in sync with
    // design-tool/lib/math/macros.ts — see ADR 0009.
    private static func loadKatexBundle(log: (String) -> Void) -> (css: String, js: String, autoRender: String) {
        let bundle = Bundle.module
        var css = bundle.url(forResource: "katex.min", withExtension: "css", subdirectory: "katex")
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""

        if css.isEmpty {
            log("KATEX: katex.min.css missing from bundle")
        }

        // Drop `,url(fonts/X.woff) format("woff")` and `,url(fonts/X.ttf) format("truetype")`
        // so the browser only ever tries woff2 (which we ship).
        if let stripRegex = try? NSRegularExpression(
            pattern: #",url\(fonts/[^)]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)"#,
            options: []
        ) {
            let range = NSRange(css.startIndex..., in: css)
            css = stripRegex.stringByReplacingMatches(in: css, options: [], range: range, withTemplate: "")
        }

        if let fontsDir = bundle.url(forResource: "fonts", withExtension: nil, subdirectory: "katex"),
           let files = try? FileManager.default.contentsOfDirectory(at: fontsDir, includingPropertiesForKeys: nil) {
            for fontURL in files where fontURL.pathExtension == "woff2" {
                guard let data = try? Data(contentsOf: fontURL) else {
                    log("KATEX: could not read \(fontURL.lastPathComponent)")
                    continue
                }
                let uri = "data:font/woff2;base64,\(data.base64EncodedString())"
                css = css.replacingOccurrences(of: "fonts/\(fontURL.lastPathComponent)", with: uri)
            }
        } else {
            log("KATEX: fonts subdirectory missing from bundle")
        }

        let js = bundle.url(forResource: "katex.min", withExtension: "js", subdirectory: "katex")
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
        if js.isEmpty { log("KATEX: katex.min.js missing from bundle") }

        let autoRender = bundle.url(forResource: "auto-render.min", withExtension: "js", subdirectory: "katex")
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
        if autoRender.isEmpty { log("KATEX: auto-render.min.js missing from bundle") }

        return (css, js, autoRender)
    }

    private func renderHTML() -> String {
        let itemsJSON = (try? JSONEncoder().encode(bundle.items)).flatMap {
            String(data: $0, encoding: .utf8)
        } ?? "[]"
        let assetsJSON = (try? JSONEncoder().encode(bundle.assets ?? [:])).flatMap {
            String(data: $0, encoding: .utf8)
        } ?? "{}"

        let katex = TestRunner.loadKatexBundle(log: log)

        return """
        <!doctype html>
        <html><head>
          <meta http-equiv="Content-Security-Policy"
                content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; img-src data: 'self'">
          <style>\(katex.css)</style>
          <script>\(katex.js)</script>
          <script>\(katex.autoRender)</script>
          <style>
            body { font: 16px -apple-system; margin: 32px; color: #222; }
            h1 { font-size: 22px; }
            h2 { font-size: 16px; margin-top: 24px; color: #444; }
            .item { padding: 16px 0; border-bottom: 1px solid #eee; }
            .choice { display: block; margin: 6px 0; }
            .sandbox { background: #f5f5f7; padding: 12px 16px; border-radius: 6px; margin-bottom: 24px; }
            .sandbox table { width: 100%; border-collapse: collapse; font-size: 13px; }
            .sandbox td { padding: 3px 8px; border-bottom: 1px solid #eaeaec; }
            .sandbox td:first-child { white-space: nowrap; color: #666; }
            .sandbox .blocked { color: #056b00; font-weight: 600; }
            .sandbox .allowed { color: #9b0000; font-weight: 600; }
            .sandbox .note    { color: #555; font-style: italic; }
            #drag-target { background: #fffae6; padding: 8px; margin: 8px 0; border: 1px dashed #c1a200; user-select: text; }
            button { margin-left: 8px; padding: 4px 10px; }
          </style>
        </head><body>
          <h1>\(bundle.title)</h1>

          <div class="sandbox">
            <h2 style="margin-top:0">Sandbox-escape probes (auto-run)</h2>
            <table id="sandbox-results"></table>
            <p class="note">Manual checks: right-click anywhere, try to drag the yellow box below, paste from clipboard into the search field, try Cmd-F.</p>
            <button onclick="tryNavigate()">Test navigation block (should be blocked by WKNavigationDelegate)</button>
            <div id="drag-target">drag-target — try to drag this content out of the WebView</div>
            <input id="paste-target" placeholder="paste-target — Cmd-V here" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" style="width:100%; padding:4px 6px;">
          </div>

          <h2>Test items</h2>
          <div id="items"></div>

          <script>
            // ---- sandbox probes ----
            const results = [];
            function record(name, blocked, detail) {
              results.push({ name, blocked, detail });
            }

            try {
              const w = window.open('https://example.com', '_blank');
              record('window.open(https://example.com)', !w, w ? 'returned window object — NOT blocked' : 'returned null — blocked');
            } catch (e) { record('window.open(https://example.com)', true, 'threw: ' + e.message); }

            (async () => {
              try {
                const r = await fetch('https://example.com');
                record('fetch(https://example.com)', false, 'status ' + r.status + ' — NOT blocked');
                renderResults();
              } catch (e) {
                record('fetch(https://example.com)', true, 'threw: ' + e.message);
                renderResults();
              }
            })();

            try {
              localStorage.setItem('probe', 'x');
              const ok = localStorage.getItem('probe') === 'x';
              localStorage.removeItem('probe');
              record('localStorage.setItem', !ok, ok ? 'persisted — NOT blocked' : 'did not persist — blocked');
            } catch (e) { record('localStorage.setItem', true, 'threw: ' + e.message); }

            try {
              document.cookie = 'probe=x';
              const ok = document.cookie.includes('probe=');
              record('document.cookie write', !ok, ok ? 'cookie set — NOT blocked' : 'cookie not set — blocked');
            } catch (e) { record('document.cookie write', true, 'threw: ' + e.message); }

            try {
              const supported = typeof location.assign === 'function';
              record('location.assign (capability check)', false, supported ? 'function exists — would navigate unless WKNavigationDelegate intervenes' : 'unavailable');
            } catch (e) { record('location.assign', true, 'threw: ' + e.message); }

            (async () => {
              try {
                const t = await navigator.clipboard.readText();
                record('navigator.clipboard.readText', false, 'returned ' + t.length + ' chars — NOT blocked');
              } catch (e) {
                record('navigator.clipboard.readText', true, 'threw: ' + e.message);
              }
              renderResults();
            })();

            function tryNavigate() {
              location.replace('https://example.com/should-be-blocked-by-WKNavigationDelegate');
            }

            function renderResults() {
              const table = document.getElementById('sandbox-results');
              table.innerHTML = '';
              results.forEach(r => {
                const tr = document.createElement('tr');
                const td1 = document.createElement('td');
                td1.textContent = r.name;
                const td2 = document.createElement('td');
                td2.className = r.blocked ? 'blocked' : 'allowed';
                td2.textContent = (r.blocked ? 'BLOCKED' : 'ALLOWED') + ' — ' + r.detail;
                tr.appendChild(td1);
                tr.appendChild(td2);
                table.appendChild(tr);
              });
            }
            renderResults();

            // ---- test items ----
            // Three wire-format types; defaults to single-select MC when
            // `type` is absent (pre-slice-8 fixtures). All three types now
            // POST answers back to the Lambda (slice 9):
            //   single-select:  { item_id, item_type, choice_id }
            //   multi-select:   { item_id, item_type, choice_ids: [...] }   on every toggle
            //   short_text:     { item_id, item_type, answer }              on change (blur)
            function postResponse(body) {
              try {
                window.webkit.messageHandlers.response.postMessage(body);
              } catch (e) {
                console.log('response post failed:', e && e.message);
              }
            }

            const items = \(itemsJSON);
            // Slice 15: bundled assets (uuid → {content_type, base64})
            // come from the @secure-test/schema BundleAsset shape. We
            // build DOM fragments rather than using innerHTML so a
            // malicious-looking stem string can't smuggle script tags
            // through (alt text is set via element.alt which the browser
            // attribute-escapes).
            const ASSETS = \(assetsJSON);
            const ASSET_REF_RE = /!\\[([^\\]]*)\\]\\(asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\)/gi;

            function renderTextWithAssets(text) {
              const frag = document.createDocumentFragment();
              if (typeof text !== 'string' || text.length === 0) return frag;
              let last = 0;
              ASSET_REF_RE.lastIndex = 0;
              let m;
              while ((m = ASSET_REF_RE.exec(text)) !== null) {
                if (m.index > last) {
                  frag.appendChild(document.createTextNode(text.slice(last, m.index)));
                }
                const alt = m[1] || '';
                const id = m[2].toLowerCase();
                const a = ASSETS[id];
                if (a && a.base64 && a.content_type) {
                  const img = document.createElement('img');
                  img.src = 'data:' + a.content_type + ';base64,' + a.base64;
                  img.alt = alt;
                  img.style.maxWidth = '100%';
                  img.style.maxHeight = '360px';
                  img.style.display = 'block';
                  img.style.margin = '8px 0';
                  img.style.border = '1px solid #eee';
                  img.style.borderRadius = '4px';
                  frag.appendChild(img);
                } else {
                  const span = document.createElement('span');
                  span.textContent = '[image not found: ' + (alt || id) + ']';
                  span.style.color = '#cc0000';
                  span.style.fontFamily = 'monospace';
                  span.style.fontSize = '12px';
                  frag.appendChild(span);
                }
                last = m.index + m[0].length;
              }
              if (last < text.length) {
                frag.appendChild(document.createTextNode(text.slice(last)));
              }
              return frag;
            }

            const root = document.getElementById('items');
            items.forEach(it => {
              const type = it.type || 'multiple_choice_single';
              const div = document.createElement('div');
              div.className = 'item';
              const stem = document.createElement('p');
              stem.appendChild(renderTextWithAssets(it.stem));
              div.appendChild(stem);

              if (type === 'short_text') {
                const input = document.createElement('input');
                input.type = 'text';
                input.name = 'q-' + it.id;
                input.placeholder = 'Type your answer…';
                input.autocomplete = 'off';
                input.style.width = '100%';
                input.style.padding = '6px 8px';
                input.style.border = '1px solid #ccc';
                input.style.borderRadius = '4px';
                input.onchange = () => {
                  postResponse({
                    item_id: it.id,
                    item_type: type,
                    answer: input.value
                  });
                };
                div.appendChild(input);
              } else {
                const isMulti = (type === 'multiple_choice_multi');
                const inputs = [];
                (it.choices || []).forEach(ch => {
                  const label = document.createElement('label');
                  label.className = 'choice';
                  const inp = document.createElement('input');
                  inp.type = isMulti ? 'checkbox' : 'radio';
                  inp.name = 'q-' + it.id;
                  inp.value = ch.id;
                  inputs.push(inp);
                  if (isMulti) {
                    inp.onchange = () => {
                      const choiceIds = inputs.filter(x => x.checked).map(x => x.value);
                      postResponse({
                        item_id: it.id,
                        item_type: type,
                        choice_ids: choiceIds
                      });
                    };
                  } else {
                    inp.onchange = () => {
                      postResponse({
                        item_id: it.id,
                        item_type: type,
                        choice_id: ch.id
                      });
                    };
                  }
                  label.appendChild(inp);
                  label.appendChild(document.createTextNode(' '));
                  label.appendChild(renderTextWithAssets(ch.text));
                  div.appendChild(label);
                });
              }
              root.appendChild(div);
            });

            // ---- KaTeX math rendering (slice 13) ----
            // Auto-render scans the body for `$...$` (inline) and `$$...$$`
            // (display) delimiters and renders each via KaTeX. Macros come
            // from the slice-16 generated constant
            // (GeneratedKatexMacros.json), which is built from the
            // canonical @secure-test/schema K12_MACROS set — no hand-sync
            // between this file and the design tool. See ADR 0009.
            // Errors render inline-red via errorColor; we don't throw so
            // a single bad stem can't break the whole test loop.
            if (typeof renderMathInElement === 'function') {
              try {
                renderMathInElement(document.body, {
                  delimiters: [
                    { left: '$$', right: '$$', display: true },
                    { left: '$', right: '$', display: false }
                  ],
                  throwOnError: false,
                  errorColor: '#cc0000',
                  macros: \(GeneratedKatexMacros.json)
                });
              } catch (e) {
                console.log('KaTeX renderMathInElement failed:', e && e.message);
              }
            } else {
              console.log('KaTeX renderMathInElement not loaded');
            }
          </script>
        </body></html>
        """
    }
}
