import AppKit

/// The PSD palette, once, for the AppKit side of the client.
///
/// Batch 4 slice D (`docs/client-ui-pass-design.md` §D). The web page has its
/// tokens in `PageShell.baseStyles` (slice A); this is the same palette for
/// everything AppKit draws — the window ground, the entry screen, the titlebar
/// buttons, the peek strip.
///
/// Literal sRGB components on purpose, not `NSColor(named:)`: two of these
/// colours are captured into the peek frame (`cacheDisplay`), and a named
/// asset colour would resolve differently under a different appearance or
/// display profile. The values are the same hexes the design tool uses
/// (`design-tool/app/globals.css`, `docs/ux-pass-1.md` §tokens).
enum PSDColor {
    /// #25424C — Pacific. Ink on paper, and the app's ground.
    static let pacific = srgb(0x25, 0x42, 0x4C)
    /// #5A6C73 — Pacific softened. Secondary label text.
    static let inkSoft = srgb(0x5A, 0x6C, 0x73)
    /// #346780 — Whulge. The accent: primary buttons and the peek strip.
    static let whulge = srgb(0x34, 0x67, 0x80)
    /// Whulge pressed — the same hue, darkened, for a held button.
    static let whulgePressed = srgb(0x27, 0x4E, 0x62)
    /// #FFFAEC — Skylight. Text and glyphs on Whulge or Pacific.
    static let skylight = srgb(0xFF, 0xFA, 0xEC)
    /// #466857 — Cedar. "Done", and anything that reads as complete.
    static let cedar = srgb(0x46, 0x68, 0x57)
    /// #EEEBE4 — Sea Foam. Quiet panel fill.
    static let seaFoam = srgb(0xEE, 0xEB, 0xE4)
    /// #D7CDBE — Driftwood. The line around a Sea Foam panel.
    static let driftwood = srgb(0xD7, 0xCD, 0xBE)
    /// #F3F8FA — Mist. The design tool's ground; used here only where a
    /// surface needs to sit back from white without going to Sea Foam.
    static let mist = srgb(0xF3, 0xF8, 0xFA)
    /// #FFFFFF — paper. The card the entry screen's content sits on.
    static let paper = srgb(0xFF, 0xFF, 0xFF)
    /// #CDDADF — the hairline on paper.
    static let line = srgb(0xCD, 0xDA, 0xDF)
    /// #8D5D1C — warn.
    static let warn = srgb(0x8D, 0x5D, 0x1C)
    /// #A04034 — danger.
    static let danger = srgb(0xA0, 0x40, 0x34)

    private static func srgb(_ r: Int, _ g: Int, _ b: Int) -> NSColor {
        NSColor(
            srgbRed: CGFloat(r) / 255.0,
            green: CGFloat(g) / 255.0,
            blue: CGFloat(b) / 255.0,
            alpha: 1.0
        )
    }
}

/// A filled Whulge button with Skylight text — the client's primary action.
///
/// Borderless and drawn here rather than an `NSButton` with `bezelColor`,
/// which AppKit ignores for several bezel styles; the focus ring is still
/// AppKit's own (`drawFocusRingMask`), so keyboard focus stays visible and
/// nothing about the responder chain changes. Used for Join / Resume / Sign in
/// on the entry screen and for the titlebar actions, whose targets, actions,
/// key equivalents and titles are untouched.
final class PSDPrimaryButton: NSButton {
    /// Horizontal padding around the title, on top of the intrinsic size.
    private let horizontalPadding: CGFloat = 18
    private let minimumHeight: CGFloat = 30
    private let cornerRadius: CGFloat = 6

    convenience init(title: String, target: AnyObject?, action: Selector?) {
        self.init(frame: .zero)
        self.isBordered = false
        self.bezelStyle = .rounded
        self.target = target
        self.action = action
        self.font = .systemFont(ofSize: 13, weight: .semibold)
        self.contentTintColor = PSDColor.skylight
        self.buttonTitle = title
        applyTitle()
    }

    /// The title is held here rather than read back from `title`: setting
    /// `attributedTitle` writes AppKit's own title storage, so observing
    /// `title` to restyle would re-enter itself.
    private var buttonTitle = ""

    override var isEnabled: Bool {
        didSet { applyTitle(); needsDisplay = true }
    }

    private func applyTitle() {
        let colour = isEnabled ? PSDColor.skylight : PSDColor.skylight.withAlphaComponent(0.6)
        attributedTitle = NSAttributedString(
            string: buttonTitle,
            attributes: [
                .foregroundColor: colour,
                .font: font ?? NSFont.systemFont(ofSize: 13, weight: .semibold),
            ]
        )
    }

    override var intrinsicContentSize: NSSize {
        let base = super.intrinsicContentSize
        return NSSize(
            width: base.width + horizontalPadding * 2,
            height: max(base.height, minimumHeight)
        )
    }

    override func draw(_ dirtyRect: NSRect) {
        let fill: NSColor
        if !isEnabled {
            fill = PSDColor.whulge.withAlphaComponent(0.4)
        } else if isHighlighted {
            fill = PSDColor.whulgePressed
        } else {
            fill = PSDColor.whulge
        }
        fill.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: cornerRadius, yRadius: cornerRadius).fill()
        super.draw(dirtyRect)
    }

    override func drawFocusRingMask() {
        NSBezierPath(roundedRect: bounds, xRadius: cornerRadius, yRadius: cornerRadius).fill()
    }

    override var focusRingMaskBounds: NSRect { bounds }
}
