import AppKit
import SecureTestCore
import WebKit

/// UX pass 2 slice 9: the one piece of sign-in that needs a window — now our
/// own web view instead of `ASWebAuthenticationSession`.
///
/// The system sheet was abandoned because its cookie jar lives in the
/// AuthenticationServices daemon, outside the app: a lingering Google web
/// session survived `prefersEphemeralWebBrowserSession = true`, every `prompt`
/// value, app relaunches, and was not visible in Safari — on a shared lab Mac
/// the previous student stayed one click away. Owning the web view means
/// owning the cookie store: `WKWebsiteDataStore.nonPersistent()`, created
/// fresh per attempt and discarded with it, so nothing CAN persist.
///
/// The reverse-client-id callback is intercepted in the navigation delegate,
/// so no `CFBundleURLTypes` registration is needed here either (the scheme
/// never leaves this web view). Everything around this — the URL, the PKCE
/// proof, the token exchange, the nonce check, the design-tool exchange —
/// lives in `GoogleSignInFlow` in the package, and is tested there. This
/// class cannot be (no window server under `swift test`), so it does as
/// little as possible: present, wait, return the URL or the reason there is
/// none.
///
/// Known trade-off: Google refuses OAuth in web views it recognises as
/// embedded ("disallowed_useragent"), keyed on the user agent. The
/// Safari-shaped `applicationNameForUserAgent` below is what keeps the page
/// serving; Google could tighten detection on their side at any time, which
/// is why MANUAL-CHECKS gates this slice on the authorize page rendering.
final class WebViewAuthPresenter: NSObject, WKNavigationDelegate, WKUIDelegate {
    private weak var hostWindow: NSWindow?

    // Per-attempt state; `finish` clears all of it, exactly once.
    private var continuation: CheckedContinuation<URL, Error>?
    private var sheetWindow: NSWindow?
    private var webView: WKWebView?
    private var callbackScheme = ""

    private enum PresenterError: Error {
        case webContentProcessTerminated
    }

    /// The sheet's window: catches Cmd-Q before the WKWebView can swallow it.
    /// With the web view as first responder, WebKit consumes Cmd-key
    /// equivalents ahead of the main menu (the same mechanism as the Cmd-E
    /// beep finding, 2026-08-31), so the Quit item never fired and Cmd-Q
    /// beeped with the sheet open. Everything else falls through.
    private final class AuthSheetWindow: NSWindow {
        var onQuitKey: (() -> Void)?

        override func performKeyEquivalent(with event: NSEvent) -> Bool {
            if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
               event.charactersIgnoringModifiers == "q" {
                onQuitKey?()
                return true
            }
            return super.performKeyEquivalent(with: event)
        }
    }

    private static let sheetSize = NSSize(width: 520, height: 760)
    private static let headerHeight: CGFloat = 40

    init(window: NSWindow?) {
        self.hostWindow = window
    }

    func present(_ url: URL, callbackScheme: String) async throws -> URL {
        guard continuation == nil else { throw SignInError.cancelled }
        guard let hostWindow else { throw SignInError.cancelled }
        self.callbackScheme = callbackScheme

        let configuration = WKWebViewConfiguration()
        // The point of the slice: an in-memory store, new per attempt, gone
        // with it. Never assign a persistent store here.
        configuration.websiteDataStore = .nonPersistent()
        // Without the Safari suffix WKWebView's UA reads as an embedded web
        // view and Google answers "this browser or app may not be secure".
        configuration.applicationNameForUserAgent = "Version/17.6 Safari/605.1.15"
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false

        // A plain WKWebView, not LockedDownWebView: sign-in happens on the
        // entry screen, outside any AAC session, and students need the paste /
        // context-menu affordances the lockdown view strips.
        let webView = WKWebView(
            frame: NSRect(
                x: 0, y: 0,
                width: Self.sheetSize.width,
                height: Self.sheetSize.height - Self.headerHeight
            ),
            configuration: configuration
        )
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsLinkPreview = false
        webView.autoresizingMask = [.width, .height]
        self.webView = webView

        let sheet = AuthSheetWindow(
            contentRect: NSRect(origin: .zero, size: Self.sheetSize),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        sheet.isReleasedWhenClosed = false
        sheet.contentView = makeSheetContent(webView: webView)
        // Cmd-Q mid-sign-in: tear the sheet down first (the continuation
        // resumes cancelled), then quit through the normal path so the
        // lockdown guard in applicationShouldTerminate still runs.
        sheet.onQuitKey = { [weak self] in
            self?.finish(.failure(SignInError.cancelled))
            NSApp.terminate(nil)
        }
        self.sheetWindow = sheet

        // The completion-handler form: in an async context the bare
        // `beginSheet(_:)` imports as async and would suspend until endSheet.
        hostWindow.beginSheet(sheet, completionHandler: nil)
        webView.load(URLRequest(url: url))

        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
        }
    }

    private func makeSheetContent(webView: WKWebView) -> NSView {
        let content = NSView(frame: NSRect(origin: .zero, size: Self.sheetSize))

        let header = NSView(frame: NSRect(
            x: 0, y: Self.sheetSize.height - Self.headerHeight,
            width: Self.sheetSize.width, height: Self.headerHeight
        ))
        header.autoresizingMask = [.width, .minYMargin]
        // The sheet's one piece of branding (client-ui-pass-design.md §C).
        // The emblem asset is white, so the header carries a Pacific ground
        // for it to read against; the title goes white to match. Nothing
        // below the header changes — the web view is still Google's page.
        header.wantsLayer = true
        // Slice D: the same literal, now named once in `PSDColor`.
        header.layer?.backgroundColor = PSDColor.pacific.cgColor

        let emblem = NSImageView(frame: NSRect(x: 16, y: 10, width: 20, height: 20))
        emblem.image = NSImage(named: "psd-emblem-white")
        emblem.imageScaling = .scaleProportionallyUpOrDown
        emblem.setAccessibilityLabel("Peninsula School District")
        header.addSubview(emblem)

        let title = NSTextField(labelWithString: "Sign in with your school account")
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        title.textColor = .white
        title.frame = NSRect(x: 44, y: 11, width: 320, height: 18)
        header.addSubview(title)

        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelPressed))
        cancel.bezelStyle = .rounded
        cancel.controlSize = .small
        cancel.keyEquivalent = "\u{1b}"
        cancel.frame = NSRect(x: Self.sheetSize.width - 86, y: 7, width: 70, height: 24)
        cancel.autoresizingMask = [.minXMargin]
        header.addSubview(cancel)

        content.addSubview(header)
        content.addSubview(webView)
        return content
    }

    @objc private func cancelPressed() {
        finish(.failure(SignInError.cancelled))
    }

    /// The single exit path: resumes the continuation exactly once (the
    /// nil-check is the guard — everything here is main-actor) and tears the
    /// sheet and web view down so nothing survives the attempt.
    private func finish(_ result: Result<URL, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
        if let sheetWindow { hostWindow?.endSheet(sheetWindow) }
        sheetWindow = nil
        webView = nil
        continuation.resume(with: result)
    }

    // MARK: WKNavigationDelegate

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let scheme = navigationAction.request.url?.scheme ?? ""
        if scheme == callbackScheme, let url = navigationAction.request.url {
            finish(.success(url))
            decisionHandler(.cancel)
            return
        }
        // No hostname allowlist: Google's flow legitimately traverses several
        // of its domains and the set changes under us. Safety rests on PKCE +
        // state/nonce in the package and on the discarded data store, not on
        // where this view browses.
        if scheme == "https" || scheme == "about" {
            decisionHandler(.allow)
            return
        }
        log("sign-in web view blocked navigation: \(scheme)")
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(.failure(error))
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(.failure(error))
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finish(.failure(PresenterError.webContentProcessTerminated))
    }

    // MARK: WKUIDelegate

    /// Never a second web view. A popup-shaped https request ("Forgot
    /// email?"-style helpers) loads in the same view instead.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if navigationAction.request.url?.scheme == "https" {
            webView.load(navigationAction.request)
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        completionHandler(nil)
    }

    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(.deny)
    }

    private func log(_ message: String) {
        AppDelegate.log(message)
    }
}
