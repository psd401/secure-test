import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var logView: NSTextView!
    private var oidc: OIDCClient!
    private let probe = CallbackProbe()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let frame = NSRect(x: 0, y: 0, width: 760, height: 520)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "PoC-C — ClassLink PKCE OIDC"
        window.center()

        let content = NSView(frame: frame)

        let loginButton = NSButton(title: "Sign in via ClassLink", target: self, action: #selector(login))
        loginButton.frame = NSRect(x: 16, y: 472, width: 220, height: 32)
        content.addSubview(loginButton)

        let refreshButton = NSButton(title: "Refresh Token", target: self, action: #selector(refresh))
        refreshButton.frame = NSRect(x: 244, y: 472, width: 180, height: 32)
        content.addSubview(refreshButton)

        let probeButton = NSButton(title: "Test Callback (mock)", target: self, action: #selector(runProbe))
        probeButton.frame = NSRect(x: 432, y: 472, width: 200, height: 32)
        content.addSubview(probeButton)

        let scroll = NSScrollView(frame: NSRect(x: 16, y: 16, width: 728, height: 440))
        scroll.hasVerticalScroller = true
        logView = NSTextView(frame: scroll.bounds)
        logView.isEditable = false
        logView.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        logView.autoresizingMask = [.width]
        scroll.documentView = logView
        content.addSubview(scroll)

        window.contentView = content
        window.makeKeyAndOrderFront(nil)

        probe.onLog = { [weak self] in self?.log($0) }

        do {
            let config = try OIDCConfig.load()
            oidc = OIDCClient(config: config)
            oidc.onLog = { [weak self] in self?.log($0) }
            log("Config loaded. issuer=\(config.issuer) clientId=\(config.clientId.prefix(6))… redirect=\(config.redirectURI)")
        } catch {
            log("OIDC config not loaded (\(error.localizedDescription)). Sign in / Refresh disabled.")
            log("Test Callback (mock) does not require config — safe to click.")
        }
    }

    @objc private func login() {
        Task { await oidc?.startAuthFlow() }
    }

    @objc private func refresh() {
        Task { await oidc?.refreshAccessToken() }
    }

    @objc private func runProbe() {
        probe.run()
    }

    private func log(_ msg: String) {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let line = "[\(timestamp)] \(msg)\n"
        DispatchQueue.main.async { [weak self] in
            self?.logView.textStorage?.append(NSAttributedString(string: line))
            self?.logView.scrollToEndOfDocument(nil)
        }
    }
}
