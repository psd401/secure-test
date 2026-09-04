import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var runner: TestRunner!

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()

        let frame = NSRect(x: 0, y: 0, width: 900, height: 640)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "PoC-B — Test Delivery Loop"
        window.center()

        guard let items = ItemLoader.loadBundledItems() else {
            window.title = "PoC-B — items.json missing or invalid"
            window.makeKeyAndOrderFront(nil)
            return
        }

        runner = TestRunner(items: items) { line in
            FileHandle.standardError.write(Data("[security] \(line)\n".utf8))
        }
        window.contentView = runner.view
        window.makeKeyAndOrderFront(nil)
    }

    /// Build a minimal main menu so Cmd-V / Cmd-X / Cmd-C / Cmd-A / Cmd-Q dispatch
    /// to the standard responder chain (WKWebView's content). Without this, a
    /// programmatic AppKit app has no Edit menu and keyboard shortcuts silently
    /// no-op.
    private func installMainMenu() {
        let mainMenu = NSMenu()

        // Application menu (Quit only)
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(
            NSMenuItem(
                title: "Quit PocB Client",
                action: #selector(NSApplication.terminate(_:)),
                keyEquivalent: "q"
            )
        )
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        // Edit menu — Cut / Copy / Paste / Select All only. Intentionally omits
        // Undo/Redo for the secure-test context.
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        NSApplication.shared.mainMenu = mainMenu
    }
}
