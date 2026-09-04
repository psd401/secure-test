import AppKit
import WebKit

/// WKWebView subclass that suppresses the macOS context menu and the Services
/// architecture entirely.
///
/// Ported from PoC-B, where each of these three overrides was verified by hand
/// (poc-b-test-loop/RESULTS.md, "WKWebView hardening implementation and
/// verification"). The measured finding that matters: `willOpenMenu` alone is
/// NOT sufficient. macOS injects the Services submenu and text-field Autofill
/// through paths that bypass or post-date it, so a default WKWebView offers
/// "Search with Google", "Share…" and "Services ›" on selected text — all of
/// them network- or data-egress affordances inside what is meant to be a sealed
/// assessment.
final class LockedDownWebView: WKWebView {
    /// Slice 72: drag-IN was one of three gaps PoC-B recorded as untested
    /// ("Drag-IN to the WebView… is untested. Likely allowed by default").
    ///
    /// It is: WebKit registers for dragged types itself, so a student could drop
    /// a file or a chunk of text from another app onto the page. During an
    /// assessment that is a route for reference material to arrive on the answer
    /// surface, and it bypasses everything the CSP and the navigation delegate
    /// govern because no navigation and no request are involved.
    ///
    /// Unregistering the types is the real fix — nothing is offered, so nothing
    /// is accepted. The NSDraggingDestination overrides below are belt and
    /// braces for anything that re-registers a type later.
    override init(frame: CGRect, configuration: WKWebViewConfiguration) {
        super.init(frame: frame, configuration: configuration)
        unregisterDraggedTypes()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("LockedDownWebView is constructed programmatically")
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        []
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        []
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        false
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        false
    }

    /// The other untested path PoC-B listed. A Touch Bar surfaces text
    /// suggestions, emoji and app-provided controls without ever consulting the
    /// menu bar or the responder chain the Edit menu governs — so the clipboard
    /// policy would simply not apply to it. Returning nil means there is nothing
    /// to consult.
    override func makeTouchBar() -> NSTouchBar? {
        nil
    }

    /// Swallowed with no `super` call, so menu construction never begins. This
    /// is the override that actually closes the hole.
    override func rightMouseDown(with event: NSEvent) {}

    /// Opts the view out of Services contexts, including keyboard-initiated
    /// ones that never touch `rightMouseDown`.
    override func validRequestor(
        forSendType sendType: NSPasteboard.PasteboardType?,
        returnType: NSPasteboard.PasteboardType?
    ) -> Any? {
        nil
    }

    /// Defense in depth. Unreachable in practice now that `rightMouseDown` is
    /// swallowed; kept so the posture survives a future change to that override.
    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        menu.removeAllItems()
        menu.cancelTracking()
    }
}
