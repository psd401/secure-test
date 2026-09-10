import Foundation

/// C-4 / D-7 (2026-09-09, `docs/multi-source-stimulus-design.md`): how far the
/// assessment page may be magnified, and what a zoom step does.
///
/// The rule lives here rather than in the view controller because it is the
/// only part of the pinch-and-menu zoom that can be tested at all — the gesture
/// itself needs a window server (ADR 0013). The host applies it to
/// `WKWebView.magnification` in both directions: the menu asks for a step, and
/// the KVO observer re-clamps whatever a trackpad pinch settled on.
///
/// Steps are multiplicative, so each press changes the page by the same
/// PROPORTION at every level — 1.0 → 1.25 → 1.5625 → … — which is how the
/// browser zoom students already know behaves. The ceiling is 3×: past that a
/// PDF-imported chart is bigger than the window and the student is panning
/// blind.
public enum ZoomLevel {
    /// The page at its authored size. Also the floor: shrinking an assessment
    /// below 100 % has no use case and makes small print unreadable.
    public static let minimum = 1.0
    public static let maximum = 3.0
    /// One press of Zoom In / Zoom Out.
    public static let step = 1.25

    /// Pulls any factor — a pinch's result, a stale value, a NaN — back inside
    /// the range. A non-finite input is treated as "no zoom" rather than
    /// propagated into AppKit.
    public static func clamp(_ factor: Double) -> Double {
        guard factor.isFinite else { return minimum }
        return Swift.min(maximum, Swift.max(minimum, factor))
    }

    /// One step in, never past the ceiling.
    public static func zoomedIn(from factor: Double) -> Double {
        clamp(clamp(factor) * step)
    }

    /// One step out, never below 1× — so Zoom Out at Actual Size is a no-op
    /// rather than a shrink.
    public static func zoomedOut(from factor: Double) -> Double {
        clamp(clamp(factor) / step)
    }
}
