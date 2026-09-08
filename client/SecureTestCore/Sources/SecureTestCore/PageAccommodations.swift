import Foundation

/// Client UI pass slice B (`docs/client-ui-pass-design.md` §B): the three
/// accommodations that are purely a matter of how the page is PAINTED —
/// `color_contrast`, `optional_font`, `zoom`.
///
/// They are resolved once, in Swift, at page-build time, into attributes on
/// `<html>`; the CSS in `PageShell.accommodationStyles` does the rest. The
/// renderer script never learns any of this, which is the point: an
/// accommodation that changed the DOM would change what a peek shows the
/// teacher and what `cacheDisplay` captures, and it would have to be re-applied
/// on every page turn.
///
/// The values are TIDE's own strings, verbatim
/// (`design-tool/lib/accommodations/tide-catalog.json`, mapped in
/// `docs/accommodations-data-dictionary.md`) — not a re-encoding. A value this
/// client has not heard of emits NO attribute and the student reads the default
/// page, which is the same direction every other unknown-value decision in the
/// bundle takes.
public enum PageAccommodations {
    public static let contrastAttribute = "data-contrast"
    public static let fontAttribute = "data-font"
    public static let zoomAttribute = "data-zoom"

    /// One `color_contrast` pair, as the twelve tokens `baseStyles` declares.
    ///
    /// Every set defines ALL twelve. A set that defined only `--paper` and
    /// `--ink` would leave the panels, the hairlines, the accent and the three
    /// state colours sitting in the PSD palette on a black or a rose ground —
    /// which is the failure mode this shape exists to make impossible.
    public struct ContrastSet: Sendable {
        /// TIDE's value string, used both as the attribute value and in the
        /// selector.
        public let value: String
        public let paper: String
        public let ink: String
        public let inkSoft: String
        public let line: String
        public let lineStrong: String
        public let panel: String
        public let panelLine: String
        public let accent: String
        public let accentInk: String
        public let ok: String
        public let warn: String
        public let danger: String
        /// The measured WCAG 2.x contrast of `ink` on `paper`. Recorded here
        /// and asserted in `PageShellTests` so a future edit to a hex cannot
        /// quietly drop a set below AA.
        public let bodyRatio: Double

        public var css: String {
            """
            html[\(PageAccommodations.contrastAttribute)="\(value)"] {
              --paper: \(paper);
              --ink: \(ink);
              --ink-soft: \(inkSoft);
              --line: \(line);
              --line-strong: \(lineStrong);
              --panel: \(panel);
              --panel-line: \(panelLine);
              --accent: \(accent);
              --accent-ink: \(accentInk);
              --ok: \(ok);
              --warn: \(warn);
              --danger: \(danger);
            }
            """
        }
    }

    /// How each set is derived from its named pair, so the eight below read as
    /// one rule applied eight times rather than ninety-six free choices:
    ///
    /// - `--ink-soft` is the SAME as `--ink`. In the default palette it is a
    ///   softer helper ink at 5.30:1; in a contrast set it must not be, because
    ///   a student who needs Yellow on Blue needs the eyebrow, the hint and the
    ///   status line in it too. Hierarchy is carried by size and weight here.
    /// - `--panel` is the ink mixed 6% into the paper, `--line` / `--panel-line`
    ///   35%. Body text on a panel therefore keeps essentially the body ratio
    ///   (the worst case is Medium Gray at 4.91:1, still AA); the hairlines stay
    ///   decorative, exactly as in the default palette, and every *interactive*
    ///   boundary uses `--line-strong`, which is the ink itself and so passes
    ///   1.4.11 by construction.
    /// - `--accent` is the ink and `--accent-ink` the paper: the filled finish
    ///   button and the current pip invert the pair, so they carry text at the
    ///   body ratio, and the focus ring is the strongest colour on the page.
    ///   (The finish button's own ring is drawn in `--ink` OUTSIDE a `--paper`
    ///   halo for this reason — an ink ring directly on an ink fill would be
    ///   invisible in every set here.)
    /// - `--ok` / `--warn` / `--danger` keep green / amber / red, chosen dark
    ///   for the light-ground sets and light for the dark-ground ones so each
    ///   clears 4.5:1 on both the paper and the panel. They are never the only
    ///   signal — slice A gave the pips their glyphs, and every pip carries its
    ///   state in its `aria-label`.
    ///
    /// Ratios are WCAG 2.x relative luminance, computed against these exact
    /// hexes; the numbers are recorded per set below and on the design page.
    ///
    /// Three of the dictionary's literal pairs cannot ship as written and are
    /// adjusted, keeping the pair's INTENT and its name:
    ///
    /// - **Medium Gray on Light Gray** as `#808080` on `#d3d3d3` is 2.63:1 —
    ///   a designated support that fails AA outright. Darkened to `#595959` on
    ///   `#e0e0e0`: 5.31:1, still unmistakably grey-on-grey and still the
    ///   lowest-contrast set of the eight, which is what the student is asking
    ///   for.
    /// - **Red on White** as `#ff0000` on white is 4.00:1, and **White on Red**
    ///   on that same `#ff0000` is likewise 4.00:1. Deepened to `#d40000`
    ///   (5.53:1) and `#c40000` (6.27:1) — both still read as red.
    public static let contrastSets: [ContrastSet] = [
        // 16.14:1. A pale rose ground; the dictionary's TDS_CCMagenta.
        ContrastSet(
            value: "Black on Rose",
            paper: "#ffd7e8", ink: "#000000", inkSoft: "#000000",
            line: "#a68c97", lineStrong: "#000000",
            panel: "#f0cada", panelLine: "#a68c97",
            accent: "#000000", accentInk: "#ffd7e8",
            ok: "#14532d", warn: "#6b3d09", danger: "#7f1d1d",
            bodyRatio: 16.14),
        // 21.00:1. TDS_CC0 — the maximum-contrast set, not the page default.
        ContrastSet(
            value: "Black on White",
            paper: "#ffffff", ink: "#000000", inkSoft: "#000000",
            line: "#a6a6a6", lineStrong: "#000000",
            panel: "#f0f0f0", panelLine: "#a6a6a6",
            accent: "#000000", accentInk: "#ffffff",
            ok: "#14532d", warn: "#6b3d09", danger: "#7f1d1d",
            bodyRatio: 21.00),
        // 5.31:1 — adjusted from the dictionary's literal 2.63:1 (see above).
        ContrastSet(
            value: "Medium Gray on Light Gray",
            paper: "#e0e0e0", ink: "#595959", inkSoft: "#595959",
            line: "#b1b1b1", lineStrong: "#595959",
            panel: "#d8d8d8", panelLine: "#b1b1b1",
            accent: "#595959", accentInk: "#e0e0e0",
            ok: "#14532d", warn: "#6b3d09", danger: "#7f1d1d",
            bodyRatio: 5.31),
        // 5.53:1 — adjusted from #ff0000's 4.00:1.
        ContrastSet(
            value: "Red on White",
            paper: "#ffffff", ink: "#d40000", inkSoft: "#d40000",
            line: "#f0a6a6", lineStrong: "#d40000",
            panel: "#fcf0f0", panelLine: "#f0a6a6",
            accent: "#d40000", accentInk: "#ffffff",
            ok: "#14532d", warn: "#6b3d09", danger: "#7f1d1d",
            bodyRatio: 5.53),
        // 21.00:1. TDS_CCInvert — white on black.
        ContrastSet(
            value: "Reverse Contrast",
            paper: "#000000", ink: "#ffffff", inkSoft: "#ffffff",
            line: "#595959", lineStrong: "#ffffff",
            panel: "#0f0f0f", panelLine: "#595959",
            accent: "#ffffff", accentInk: "#000000",
            ok: "#c8fad6", warn: "#ffeeb3", danger: "#ffdada",
            bodyRatio: 21.00),
        // 6.27:1 — adjusted ground, from #ff0000's 4.00:1.
        ContrastSet(
            value: "White on Red",
            paper: "#c40000", ink: "#ffffff", inkSoft: "#ffffff",
            line: "#d95959", lineStrong: "#ffffff",
            panel: "#c80f0f", panelLine: "#d95959",
            accent: "#ffffff", accentInk: "#c40000",
            ok: "#c8fad6", warn: "#ffeeb3", danger: "#ffdada",
            bodyRatio: 6.27),
        // 19.56:1.
        ContrastSet(
            value: "Yellow on Black",
            paper: "#000000", ink: "#ffff00", inkSoft: "#ffff00",
            line: "#595900", lineStrong: "#ffff00",
            panel: "#0f0f00", panelLine: "#595900",
            accent: "#ffff00", accentInk: "#000000",
            ok: "#c8fad6", warn: "#ffeeb3", danger: "#ffdada",
            bodyRatio: 19.56),
        // 10.45:1.
        ContrastSet(
            value: "Yellow on Blue",
            paper: "#0000cc", ink: "#ffff00", inkSoft: "#ffff00",
            line: "#595985", lineStrong: "#ffff00",
            panel: "#0f0fc0", panelLine: "#595985",
            accent: "#ffff00", accentInk: "#0000cc",
            ok: "#c8fad6", warn: "#ffeeb3", danger: "#ffdada",
            bodyRatio: 10.45),
    ]

    /// The value the `optional_font` attribute takes. One value, not the face's
    /// name: the catalog's label is "Optional Font (dyslexia-friendly)" with an
    /// On/Off value, so the page is told THAT a different face was asked for,
    /// and D-B1 decides which face that is.
    public static let optionalFontValue = "optional"

    /// Atkinson Hyperlegible in front of the brand stack, for body AND
    /// headings — a student who needs it for a stem needs it for the page
    /// heading and the pager label too. Inter stays behind it so a face that
    /// fails to decode lands somewhere deliberate.
    public static let optionalFontCSS = """
    html[\(fontAttribute)="\(optionalFontValue)"] {
      --font-body: 'Atkinson Hyperlegible', 'Inter', -apple-system, system-ui, sans-serif;
      --font-heading: 'Atkinson Hyperlegible', 'Inter', -apple-system, system-ui, sans-serif;
    }
    """

    /// One `Zoom Test Level`. `multiplier` scales the root font size, and every
    /// type size and every spacing value that has to keep pace with it is in
    /// `rem` (slice A), so this is the only knob.
    public struct ZoomLevel: Sendable {
        public let value: String
        public let multiplier: String

        public var css: String {
            "html[\(PageAccommodations.zoomAttribute)=\"\(value)\"] { --zoom: \(multiplier); }"
        }
    }

    /// The nine TIDE levels.
    ///
    /// The five ordinary ones map to the number in their name. The four
    /// "(Streamlined Mode Only)" levels are TIDE's much larger print sizes and
    /// are valid only alongside `streamlined_layout`, which this client does
    /// NOT implement — rendering one literally would hand a student a page with
    /// two words on it. They ramp monotonically to the top of the range this
    /// layout is verified to hold instead (1.5 → 3.0), so a student entitled to
    /// one still gets a bigger page, and a bigger level still gets a bigger
    /// page. **Open for James:** confirm that clamp, or schedule the
    /// streamlined layout, when the first streamlined-level student appears.
    public static let zoomLevels: [ZoomLevel] = [
        ZoomLevel(value: "1X (Default)", multiplier: "1"),
        ZoomLevel(value: "1.5X", multiplier: "1.5"),
        ZoomLevel(value: "1.75X", multiplier: "1.75"),
        ZoomLevel(value: "2.5X", multiplier: "2.5"),
        ZoomLevel(value: "3X", multiplier: "3"),
        ZoomLevel(value: "05X (Streamlined Mode Only)", multiplier: "1.5"),
        ZoomLevel(value: "10X (Streamlined Mode Only)", multiplier: "2"),
        ZoomLevel(value: "15X (Streamlined Mode Only)", multiplier: "2.5"),
        ZoomLevel(value: "20X (Streamlined Mode Only)", multiplier: "3"),
    ]

    /// The tool ids these read, as the server writes them into the bundle.
    static let contrastTool = "color_contrast"
    static let fontTool = "optional_font"
    static let zoomTool = "zoom"

    /// The attributes for one student's effective accommodations map.
    ///
    /// Absent tool, unrecognised value, or an off-ish value → no attribute at
    /// all, so the page is byte-identical to an unaccommodated one. The server
    /// already drops "Off" / "None (Default)" rows before the bundle is built
    /// (`design-tool/lib/accommodations/effective.ts`); the same check is
    /// repeated here because a client that themed a page because a row said
    /// "Off" would be a worse bug than a redundant guard.
    public static func rootAttributes(_ accommodations: [String: String]) -> [String: String] {
        var out: [String: String] = [:]
        if let value = accommodations[contrastTool].flatMap(enabledValue),
           contrastSets.contains(where: { $0.value == value }) {
            out[contrastAttribute] = value
        }
        if accommodations[fontTool].flatMap(enabledValue) != nil {
            out[fontAttribute] = optionalFontValue
        }
        if let value = accommodations[zoomTool].flatMap(enabledValue),
           zoomLevels.contains(where: { $0.value == value }) {
            out[zoomAttribute] = value
        }
        return out
    }

    /// The same off-ish set the server uses, so a row that slipped through
    /// cannot theme the page.
    private static let disabledValues: Set<String> =
        ["", "off", "none", "none (default)", "default"]

    private static func enabledValue(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return disabledValues.contains(trimmed.lowercased()) ? nil : trimmed
    }
}
