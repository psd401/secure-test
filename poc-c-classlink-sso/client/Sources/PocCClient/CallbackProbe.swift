import AuthenticationServices
import AppKit
import Foundation

// Mock probe to verify that ASWebAuthenticationSession routes a callback URL
// with our custom scheme `securetestpoc://callback` to the completion handler
// when running as a SwiftPM executable (no Info.plist URL Type registration).
//
// The probe does NOT touch ClassLink. It opens a `data:` URL whose embedded
// JavaScript immediately navigates to `securetestpoc://callback?code=mock`.
// If ASWebAuthenticationSession's web view sees that navigation and routes
// the URL back through the completion handler, we know the SwiftPM client is
// architecturally sufficient for the real ClassLink flow.

final class CallbackProbe: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    var onLog: ((String) -> Void)?

    static let callbackScheme = "securetestpoc"
    static let mockCode = "test_value_42"

    func run() {
        // The HTML body fits in a data: URL; the inline JS runs as soon as
        // the embedded web view loads it and navigates to our custom scheme.
        let html = """
        <!doctype html>
        <html><head><meta charset="utf-8"></head>
        <body><p>redirecting…</p>
        <script>
          location.replace('\(Self.callbackScheme)://callback?code=\(Self.mockCode)');
        </script>
        </body></html>
        """

        guard let encoded = html.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let dataURL = URL(string: "data:text/html;charset=utf-8,\(encoded)") else {
            onLog?("Probe: failed to construct data: URL.")
            return
        }
        onLog?("Probe: starting ASWebAuthenticationSession with data: URL (no ClassLink).")

        let session = ASWebAuthenticationSession(
            url: dataURL,
            callbackURLScheme: Self.callbackScheme
        ) { [weak self] callbackURL, error in
            self?.handleResult(callbackURL: callbackURL, error: error)
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = true
        self.session = session
        session.start()
    }

    private func handleResult(callbackURL: URL?, error: Error?) {
        if let error {
            onLog?("Probe: completion handler fired with ERROR — \(error.localizedDescription)")
            onLog?("Probe: SwiftPM client likely insufficient. Convert PoC-C to Xcode project.")
            return
        }
        guard let callbackURL else {
            onLog?("Probe: completion handler fired with no URL and no error. Unexpected.")
            return
        }
        let scheme = callbackURL.scheme ?? "<none>"
        let code = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "code" })?.value ?? "<missing>"
        onLog?("Probe: SUCCESS — scheme=\(scheme), code=\(code)")
        if code == Self.mockCode && scheme == Self.callbackScheme {
            onLog?("Probe: callback routing works in SwiftPM. No Xcode conversion needed.")
        } else {
            onLog?("Probe: callback fired but value mismatch — investigate before relying on this.")
        }
    }

    // MARK: ASWebAuthenticationPresentationContextProviding

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApplication.shared.windows.first ?? ASPresentationAnchor()
    }
}
