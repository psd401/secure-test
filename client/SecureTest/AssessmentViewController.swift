import AppKit
import SecureTestCore
import WebKit

/// Hosts the locked-down WKWebView that presents the assessment.
///
/// Slice 53 renders multiple-choice and short-text items from a delivery
/// bundle. The remaining five types show a "not available yet" notice rather
/// than an unanswerable stem; slices 54-57 fill them in.
///
/// `.server` fetches the bundle for a joined attempt. `.file` reads one from
/// disk with no server behind it — the embedded sample, `--bundle <path>`, or
/// a File → Open Test Bundle… pick — for exercising the renderer without a
/// rebuild; that path records nothing, reports nothing and never locks down.
final class AssessmentViewController: NSObject, WKScriptMessageHandler, WKNavigationDelegate,
                                       WKUIDelegate {
    /// The one named channel the page may use to reach the host. CSP blocks
    /// fetch/XHR/WebSocket, so this is the only way out of the document.
    static let responseChannel = "response"
    /// Slice 68: drawings come over their own channel because the page cannot
    /// upload anything itself — its CSP forbids every network request — so the
    /// host takes the bytes and does the upload on its behalf.
    static let uploadChannel = "upload"
    /// Slice 73: handing the test in. The host makes the call and then clears
    /// the local queue, which the page cannot do for itself.
    static let submitChannel = "submit"
    /// UX pass 2 (James, 2026-08-31): the in-page "Back to your tests"
    /// button beside the handed-in notice. The page can only ask; the host
    /// owns the navigation.
    static let homeChannel = "home"
    /// Client-fixes batch 1b (#3, 2026-09-03): "Clear answer" on a
    /// multiple-choice item. The page cannot delete its own saved response —
    /// the ingest API is server-side — so it asks the host to withdraw it.
    static let withdrawChannel = "withdraw"

    let view: NSView
    private let webView: LockedDownWebView
    private let log: (String) -> Void
    /// On-demand peek: the student-facing notice strip (decision 6.6). The
    /// state is Core's `PeekNotice` (finding 8.1: dismissable, re-shown by
    /// every later peek); the strip below mirrors it — one label plus a
    /// Dismiss button, created on first use, updated in place after that —
    /// "is viewing" at request time, "viewed at H:MM" once the frame has
    /// gone.
    private var peekNotice = PeekNotice()
    private var peekBanner: NSView?
    private var peekLabel: NSTextField?
    /// How many navigations the HOST still owes the web view. Every
    /// `loadHTMLString` this controller issues goes through `loadHostPage`,
    /// which increments this; the navigation delegate allows an `about:`
    /// navigation only while it is positive. A bool was the original shape and
    /// blanked the `.server` path, which legitimately loads twice — the
    /// "Loading your test…" notice and then the real page.
    private var pendingHostLoads = 0

    /// Observability slice 4: the `BLOCKED …` family in one place. The stderr
    /// text is unchanged — the file line is the addition. `what` is the short
    /// stable token that becomes the error kind's context; nothing from the
    /// page's content ever goes in (redaction rule, design page).
    private func blocked(_ what: String, detail: String = "") {
        log("BLOCKED \(what)\(detail.isEmpty ? "" : ": \(detail)")")
        var context = ["what": what]
        if !detail.isEmpty { context["detail"] = detail }
        AppDelegate.logError(kind: "blocked", message: what, context: context)
    }

    /// Kept so later slices can resolve an item id back to the item it answers
    /// (word caps, required-item checks) without re-parsing the payload.
    private(set) var bundle: DeliveryBundle?

    /// Slice 69: the clipboard policy lives on the bundle, so the host cannot
    /// know it until the bundle arrives. Called on the main actor once it has.
    var onBundleLoaded: ((DeliveryBundle) -> Void)?
    /// AAC-1: fires after the server CONFIRMS the hand-in. The host ends the
    /// assessment session here — hand-in returns the Mac to the student.
    var onHandedIn: (() -> Void)?

    /// UX pass 2: the page asked to go back to "Your tests" (post-hand-in).
    var onBackToTests: (() -> Void)?

    /// Where the assessment comes from. `.file` keeps the offline path that
    /// slice 53 established — it is the only way to look at the renderer in this
    /// environment — while `.server` is the real one. The file URL is whatever
    /// the host resolved (argv, embedded sample, or an open-panel pick, which
    /// is the one the sandbox's `files.user-selected` entitlement covers); nil
    /// shows the "no bundle" notice.
    enum Source {
        case file(URL?)
        case server(client: APIClient, assessmentID: String, attemptID: String)
    }

    private let source: Source
    private var spool: ResponseSpool?

    init(source: Source = .file(nil), log: @escaping (String) -> Void = { _ in }) {
        self.source = source
        self.log = log

        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        config.userContentController = controller
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        // AAC-2b follow-up 3.2: inline predictions default OFF on macOS, so
        // the `word_completion` accommodation could never render (2026-08-28
        // hand-run). Unconditionally true is safe: the bundle isn't known
        // when this configuration is built, and inside a real session the
        // AAC `allowsPredictiveKeyboard` knob (slice 94's plan) enforces
        // per-student — an ungranted student's session keeps it suppressed.
        config.allowsInlinePredictions = true

        self.webView = LockedDownWebView(frame: .zero, configuration: config)
        self.webView.allowsLinkPreview = false

        let container = NSView(frame: NSRect(x: 0, y: 0, width: 980, height: 700))
        webView.frame = container.bounds
        webView.autoresizingMask = [.width, .height]
        container.addSubview(webView)
        self.view = container

        super.init()
        controller.add(self, name: Self.responseChannel)
        controller.add(self, name: Self.uploadChannel)
        controller.add(self, name: Self.submitChannel)
        controller.add(self, name: Self.homeChannel)
        controller.add(self, name: Self.withdrawChannel)
        webView.navigationDelegate = self
        webView.uiDelegate = self

        // baseURL: nil produces a no-origin document, which WebKit denies
        // localStorage and document.cookie outright (PoC-B auto-probes). A test
        // page therefore cannot persist anything across items or relaunches.
        switch source {
        case .file(let url):
            loadHostPage(loadPage(from: url))
        case .server(let client, let assessmentID, _):
            loadHostPage(Self.noticePage("Loading your test…", detail: ""))
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    let (bundle, json) = try await client.fetchBundle(assessmentID: assessmentID)
                    self.bundle = bundle
                    self.log("bundle fetched: \(bundle.items.count) items")
                    self.onBundleLoaded?(bundle)
                    self.loadHostPage(AssessmentPage.html(title: bundle.title, bundleJSON: json))
                } catch {
                    // Refusing beats rendering a partial test: a student handed
                    // fewer items than assigned has no way to know.
                    self.log("BUNDLE FETCH FAILED: \(error)")
                    AppDelegate.logError(
                        kind: "bundle_fetch_failed",
                        message: "\(error)",
                        context: ["assessment_id": assessmentID]
                    )
                    self.loadHostPage(Self.noticePage(
                        "This test could not be opened.",
                        detail: SessionEntryViewController.message(for: error)
                    ))
                }
            }
        }
    }

    // MARK: Page construction

    /// The ONLY way this controller loads content into the web view: the
    /// navigation it triggers is pre-authorized by the counter the delegate
    /// spends. `baseURL: nil` keeps the no-origin posture.
    private func loadHostPage(_ html: String) {
        pendingHostLoads += 1
        webView.loadHTMLString(html, baseURL: nil)
    }

    /// The offline path. Reading happens here, in the app, because it is the
    /// process the sandbox granted: an open-panel pick is readable for this
    /// launch by `files.user-selected.read-only`, an argv path only from the
    /// app's own container. What the bytes become is `OfflineBundle.load`
    /// (Core, tested): decode to prove them sound, then hand the page the
    /// ORIGINAL text — re-encoding from the model would silently drop any
    /// field this build does not yet know about.
    private func loadPage(from url: URL?) -> String {
        guard let url else {
            return Self.noticePage(
                "No assessment bundle available.",
                detail: "Use File → Open Test Bundle…, pass --bundle <path>, or rebuild with Resources/sample-delivery.json in place."
            )
        }
        guard let data = try? Data(contentsOf: url) else {
            log("could not read bundle at \(url.path)")
            return Self.noticePage(
                "No assessment bundle available.",
                detail: "The file could not be read: \(url.lastPathComponent)"
            )
        }
        log("bundle source: \(url.path)")
        do {
            let loaded = try OfflineBundle.load(data)
            self.bundle = loaded.bundle
            log("bundle loaded: \(loaded.bundle.items.count) items, test_id=\(loaded.bundle.testId)")
            onBundleLoaded?(loaded.bundle)
            // Finding 8.5: the page is told this is the offline path, so its
            // save / hand-in labels state that instead of waiting on a host
            // callback that (by design, above) never comes.
            return AssessmentPage.html(title: loaded.bundle.title, bundleJSON: loaded.json, offline: true)
        } catch {
            // An undecodable bundle means client/design-tool version skew (or,
            // from the open panel, simply not a bundle). Refusing beats
            // rendering a partial test: a student handed fewer items than
            // assigned has no way to know.
            log("BUNDLE REJECTED: \(error)")
            AppDelegate.logError(kind: "bundle_rejected", message: "\(error)")
            return Self.noticePage(
                "This assessment could not be opened.",
                detail: "The test package is not readable by this version of the app."
            )
        }
    }

    private static func noticePage(_ message: String, detail: String) -> String {
        PageShell.document(
            title: "Secure Test",
            body: """
            <h1>Secure Test</h1>
            <div class="item">
              <p class="stem">\(HTMLEscape.text(message))</p>
              <p class="stem" style="color:#6b6b70;font-size:14px">\(HTMLEscape.text(detail))</p>
            </div>
            """
        )
    }

    // MARK: on-demand peek (P2)

    /// The student's notice, shown BEFORE any pixel leaves the machine and
    /// kept once it flips to the "viewed at" form until the student closes
    /// it — the notified contract from docs/on-demand-peek-design.md 6.6,
    /// with hand-run finding 8.1's Dismiss. Every call shows: a dismissal
    /// never outlives the next peek (the rule lives in Core's `PeekNotice`,
    /// under test). An overlay strip rather than a layout change, so showing
    /// it cannot disturb the page mid-answer; it deliberately sits inside the
    /// view the render captures, so the teacher's frame shows the student
    /// was told.
    func showPeekNotice(_ text: String) {
        peekNotice.show(text)
        syncPeekBanner()
    }

    /// Finding 8.1: the Dismiss button. Only the strip goes — nothing is
    /// reported, nothing server-side changes — and the next peek's
    /// `showPeekNotice` brings it back.
    @objc private func dismissPeekNotice(_ sender: Any?) {
        peekNotice.dismiss()
        syncPeekBanner()
    }

    /// Mirror the `PeekNotice` value into the strip: hidden while there is
    /// nothing to say, otherwise built on first use and updated in place.
    private func syncPeekBanner() {
        guard let text = peekNotice.text else {
            peekBanner?.isHidden = true
            return
        }
        let banner = peekBanner ?? makePeekBanner()
        peekLabel?.stringValue = text
        banner.isHidden = false
    }

    private func makePeekBanner() -> NSView {
        let height: CGFloat = 24
        let banner = PeekBannerView(
            frame: NSRect(
                x: 0,
                y: view.bounds.height - height,
                width: view.bounds.width,
                height: height
            )
        )
        banner.autoresizingMask = [.width, .minYMargin]

        let label = NSTextField(labelWithString: "")
        label.alignment = .center
        label.font = .systemFont(ofSize: 12, weight: .semibold)
        label.textColor = .white
        label.frame = banner.bounds
        label.autoresizingMask = [.width, .height]
        banner.addSubview(label)

        // Borderless white × at the right edge (James, 2026-08-28: an icon,
        // not the word). It refuses first responder so a click never pulls
        // the keyboard out of the test page.
        let dismiss = NSButton(
            title: "×",
            target: self,
            action: #selector(dismissPeekNotice(_:))
        )
        dismiss.isBordered = false
        dismiss.attributedTitle = NSAttributedString(
            string: "×",
            attributes: [
                .foregroundColor: NSColor.white,
                .font: NSFont.systemFont(ofSize: 18, weight: .semibold),
            ]
        )
        dismiss.refusesFirstResponder = true
        dismiss.toolTip = "Hide this notice"
        dismiss.setAccessibilityLabel("Dismiss the teacher viewing notice")
        dismiss.sizeToFit()
        dismiss.frame = NSRect(
            x: banner.bounds.width - dismiss.frame.width - 12,
            y: 0,
            width: dismiss.frame.width,
            height: height
        )
        dismiss.autoresizingMask = [.minXMargin, .height]
        banner.addSubview(dismiss)

        view.addSubview(banner)
        peekBanner = banner
        peekLabel = label
        return banner
    }

    /// PoC-A finding #14's mechanism on the shipping client: the app renders
    /// its own view tree — no ScreenCaptureKit, no window-server capture, no
    /// TCC — which is what survives a real AAC session with full content.
    /// Downscaled to ≤1280 px wide, JPEG 0.7 (~100-250 KB), base64 for the
    /// upload route. Main-thread by requirement (`cacheDisplay`) and by
    /// choice for the encode too: a quarter-megabyte JPEG is milliseconds,
    /// and PoC-A measured this exact path inline.
    func renderPeekFrame() -> String? {
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            return nil
        }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let full = rep.cgImage else { return nil }

        let scale = min(1.0, 1280.0 / CGFloat(full.width))
        let width = max(1, Int(CGFloat(full.width) * scale))
        let height = max(1, Int(CGFloat(full.height) * scale))
        guard
            let context = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
            )
        else { return nil }
        context.interpolationQuality = .medium
        context.draw(full, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let scaled = context.makeImage() else { return nil }

        let out = NSBitmapImageRep(cgImage: scaled)
        guard
            let jpeg = out.representation(
                using: .jpeg,
                properties: [.compressionFactor: 0.7]
            )
        else { return nil }
        return jpeg.base64EncodedString()
    }

    // MARK: WKScriptMessageHandler

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        if message.name == Self.uploadChannel {
            handleDrawing(message.body)
            return
        }
        if message.name == Self.submitChannel {
            handleSubmit()
            return
        }
        if message.name == Self.homeChannel {
            onBackToTests?()
            return
        }
        if message.name == Self.withdrawChannel {
            handleWithdraw(message.body)
            return
        }
        guard message.name == Self.responseChannel else {
            blocked("message on unexpected channel", detail: message.name)
            return
        }
        do {
            let parsed = try ItemResponseMessage.decode(fromMessageBody: message.body)
            log("response: item=\(parsed.itemID) type=\(parsed.response.typeName)")
            record(parsed)
        } catch {
            // The page is ours, so a malformed message means a renderer bug —
            // but this is the one boundary the document can reach the host
            // through, so it validates rather than trusts.
            blocked("malformed response message", detail: "\(error)")
        }
    }

    /// Finding 10.1: the spool drops what the server refuses permanently
    /// (409 on a submitted attempt being the case seen live); say so in the
    /// [security] log rather than letting the answers vanish silently.
    @discardableResult
    private func noteDropped(_ result: ResponseSpool.FlushResult) -> ResponseSpool.FlushResult {
        if result.dropped > 0 {
            log("responses DROPPED: \(result.dropped) refused permanently by the server (attempt already handed in?)")
            // Slice 4: the single most consequential client failure there is
            // — a student's answers refused for good. In-attempt, so it also
            // lights "Needs attention" on the teacher's monitor (D-4).
            AppDelegate.logError(
                kind: "responses_dropped",
                message: "\(result.dropped) response(s) refused permanently by the server",
                context: ["dropped": String(result.dropped)]
            )
        }
        return result
    }

    // MARK: handing in

    /// Flush whatever is still queued, then submit, then clear.
    ///
    /// The order is the point. Submitting before flushing would hand in an
    /// attempt the server has an incomplete picture of, and the server stops
    /// accepting writes the moment it is submitted — so an answer still sitting
    /// in the spool at that instant could never be delivered. The flush has to
    /// succeed COMPLETELY or the hand-in does not happen.
    ///
    /// The queue is cleared only after the submit returns. Until then the
    /// student's answers exist in exactly one place that survives a crash, and
    /// that place is this machine.
    private func handleSubmit() {
        guard case .server(let client, _, let attemptID) = source else {
            log("submit ignored: no server session")
            return
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let spool = try await self.spoolForSession()
                let flushed = self.noteDropped(await spool.flush(using: client))
                guard flushed.remaining == 0 else {
                    self.log("submit refused: \(flushed.remaining) answers still unsent")
                    AppDelegate.logError(
                        kind: "submit_blocked",
                        message: "\(flushed.remaining) answer(s) still unsent",
                        context: ["remaining": String(flushed.remaining)]
                    )
                    self.reportSubmit(ok: false)
                    return
                }
                try await client.submit(attemptID: attemptID)
                // Now residue: the server has them, and the local copies are a
                // second copy of a child's work sitting on a shared machine.
                try await spool.clear(attemptID: attemptID)
                self.log("attempt \(attemptID) handed in")
                self.onHandedIn?()
                self.reportSubmit(ok: true)
            } catch {
                self.log("SUBMIT FAILED: \(error)")
                AppDelegate.logError(kind: "submit_failed", message: "\(error)")
                self.reportSubmit(ok: false)
            }
        }
    }

    private func reportSubmit(ok: Bool) {
        webView.evaluateJavaScript(
            "window.__secureTestSubmitResult(\(ok));",
            completionHandler: nil
        )
    }

    // MARK: drawing uploads

    /// Take a data: URL from the page, put the bytes in storage, then write the
    /// response that points at them.
    ///
    /// The response is written only AFTER the upload succeeds. The server
    /// refuses a response naming a slot with no bytes, so doing it the other way
    /// round would simply fail — and the student would be told their drawing was
    /// saved when nothing had been stored.
    private func handleDrawing(_ body: Any) {
        guard case .server(let client, _, let attemptID) = source else {
            log("drawing ignored: no server session")
            return
        }
        guard let payload = body as? [String: Any],
              let itemID = payload["item_id"] as? String,
              let dataURL = payload["data_url"] as? String,
              let bytes = Self.pngBytes(fromDataURL: dataURL) else {
            blocked("malformed drawing message")
            return
        }

        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                // The size is declared before the URL is signed: a presigned
                // PUT binds an exact Content-Length and cannot express a
                // maximum, so the server applies its cap to the declaration.
                // An oversized drawing is refused there, not here.
                let target = try await client.requestUpload(
                    attemptID: attemptID,
                    itemID: itemID,
                    contentType: "image/png",
                    contentLength: bytes.count
                )
                try await client.uploadBytes(bytes, to: target)

                let response = ItemResponse.drawingUpload(uploadID: target.uploadID)
                let encoded = try JSONEncoder().encode(response)
                guard let json = String(data: encoded, encoding: .utf8) else { return }
                let spool = try await self.spoolForSession()
                try await spool.enqueue(attemptID: attemptID, itemID: itemID, responseJSON: json)
                _ = self.noteDropped(await spool.flush(using: client))

                self.log("drawing saved for item \(itemID)")
                self.reportDrawing(itemID: itemID, ok: true)
            } catch {
                self.log("DRAWING UPLOAD FAILED: \(error)")
                AppDelegate.logError(
                    kind: "drawing_upload_failed",
                    message: "\(error)",
                    context: ["item_id": itemID]
                )
                self.reportDrawing(itemID: itemID, ok: false)
            }
        }
    }

    /// Only a data: URL with base64 PNG bytes is accepted. The page is ours, so
    /// anything else is a renderer bug — but this is a channel the document can
    /// reach the host through, so it validates rather than trusts.
    static func pngBytes(fromDataURL dataURL: String) -> Data? {
        let prefix = "data:image/png;base64,"
        guard dataURL.hasPrefix(prefix) else { return nil }
        return Data(base64Encoded: String(dataURL.dropFirst(prefix.count)))
    }

    private func reportDrawing(itemID: String, ok: Bool) {
        let escaped = itemID.replacingOccurrences(of: "\"", with: "")
        webView.evaluateJavaScript(
            "window.__secureTestDrawingResult(\"\(escaped)\", \(ok));",
            completionHandler: nil
        )
    }

    // MARK: response spooling

    /// Slice 67: written to disk FIRST, sent afterwards.
    ///
    /// A classroom Mac loses its network mid-test often enough that treating an
    /// upload failure as lost work is not acceptable — the student cannot tell
    /// it happened, and the teacher only finds out at scoring time.
    private func record(_ message: ItemResponseMessage) {
        guard case .server(let client, _, let attemptID) = source else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                let spool = try await self.spoolForSession()
                let payload = try JSONEncoder().encode(message.response)
                guard let json = String(data: payload, encoding: .utf8) else { return }
                try await spool.enqueue(
                    attemptID: attemptID,
                    itemID: message.itemID,
                    responseJSON: json,
                )
                let result = self.noteDropped(await spool.flush(using: client))
                if result.remaining > 0 {
                    // Not an error the student should see: the answer is safe on
                    // disk and the next flush will carry it.
                    self.log("spool: \(result.sent) sent, \(result.remaining) still queued")
                }
            } catch {
                self.log("SPOOL FAILED: \(error)")
                AppDelegate.logError(kind: "spool_failed", message: "\(error)")
            }
        }
    }

    /// Client-fixes batch 1b (#3): "Clear answer" on a multiple-choice item.
    /// Mirrors `record` — enqueue, then flush — except the payload is a
    /// withdrawal (nil, not a response) and there is no typed decoder for it,
    /// so the shape is validated here the way `handleDrawing` validates its
    /// own page→host payload.
    private func handleWithdraw(_ body: Any) {
        guard case .server(let client, _, let attemptID) = source else {
            log("withdraw ignored: no server session")
            return
        }
        guard let payload = body as? [String: Any],
              let itemID = payload["item_id"] as? String else {
            blocked("malformed withdraw message")
            return
        }
        log("withdraw: item=\(itemID)")
        Task { [weak self] in
            guard let self else { return }
            do {
                let spool = try await self.spoolForSession()
                try await spool.enqueueWithdrawal(attemptID: attemptID, itemID: itemID)
                let result = self.noteDropped(await spool.flush(using: client))
                if result.remaining > 0 {
                    // Not an error the student should see: the withdrawal is
                    // safe on disk and the next flush will carry it.
                    self.log("withdraw: \(result.sent) sent, \(result.remaining) still queued")
                }
            } catch {
                self.log("SPOOL FAILED: \(error)")
                AppDelegate.logError(kind: "spool_failed", message: "\(error)")
            }
        }
    }

    private func spoolForSession() async throws -> ResponseSpool {
        if let spool { return spool }
        let created = try ResponseSpool(path: Self.spoolPath())
        spool = created
        return created
    }

    /// Application Support rather than a temporary directory: the queue has to
    /// outlive a relaunch, which is most of the reason it exists.
    static func spoolPath() -> String {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let directory = base.appendingPathComponent("SecureTest", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("responses.sqlite").path
    }

    // MARK: WKUIDelegate

    /// Slice 72: the third gap PoC-B left open — "multi-instance behaviour is
    /// undefined".
    ///
    /// Returning nil refuses to create a second web view. `target="_blank"`, a
    /// window.open that slipped past the preference, and WebKit's own
    /// auxiliary-view paths all land here, so the assessment cannot acquire a
    /// second surface that none of this controller's hardening is attached to.
    /// That is what made the undefined behaviour worth closing: a second view
    /// would have had no navigation delegate, no message handlers and no
    /// context-menu suppression.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        blocked("attempt to open a second web view")
        return nil
    }

    /// A file picker is a filesystem browser. `<input type="file">` should not
    /// be reachable from an assessment page — the drawing item uploads through
    /// the host, and nothing else has a reason to read the disk.
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        blocked("file picker request")
        completionHandler(nil)
    }

    /// JS dialogs are dismissed rather than shown. A modal alert during an
    /// assessment is at best a distraction and at worst a way to make the window
    /// look like it is asking for something it is not.
    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        blocked("js alert")
        completionHandler()
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        blocked("js confirm")
        completionHandler(false)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        blocked("js prompt")
        completionHandler(nil)
    }

    // MARK: WKNavigationDelegate

    /// Allows only the navigations this controller itself triggered through
    /// `loadHostPage` — the counter is spent one allow per host load — and
    /// cancels every other one.
    ///
    /// The scheme is checked alongside the counter rather than relying on the
    /// counter alone, so a page navigating anywhere real is refused even while
    /// a host load is in flight (PoC-B's note on this exact ordering). The
    /// original one-shot flag blanked the `.server` path, whose notice page
    /// and real page are two legitimate host loads.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let url = navigationAction.request.url
        let scheme = url?.scheme ?? ""
        let absolute = url?.absoluteString ?? "<no-url>"

        if pendingHostLoads > 0 && (scheme == "about" || scheme.isEmpty) {
            pendingHostLoads -= 1
            decisionHandler(.allow)
            return
        }
        blocked("navigation", detail: absolute)
        decisionHandler(.cancel)
    }
}

/// The peek notice's strip (finding 8.1). Its background is drawn in
/// `draw(_:)` rather than set on a layer so `cacheDisplay` — the peek render
/// itself — paints it the way the original background-drawing label was:
/// the teacher's frame keeps showing the student was told.
private final class PeekBannerView: NSView {
    override var isOpaque: Bool { false }

    override func draw(_ dirtyRect: NSRect) {
        // PSD Whulge #346780 (client-ui-pass-design.md §C) rather than
        // systemIndigo: the strip is district chrome, and a system colour
        // shifts with the OS accent. Literal sRGB so the captured peek frame
        // is the same colour on every Mac.
        NSColor(srgbRed: 0x34 / 255.0, green: 0x67 / 255.0, blue: 0x80 / 255.0, alpha: 1.0)
            .withAlphaComponent(0.92)
            .setFill()
        bounds.fill()
    }
}
