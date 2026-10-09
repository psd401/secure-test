import Foundation

/// Row NM (docs/roadmap-2026-09.md; CLAUDE.md "Naming"): the product name a
/// student reads, in one place. The app's Info.plist takes the same name from
/// the `PRODUCT_DISPLAY_NAME` build setting; `BrandTests` keeps the two equal
/// and refuses a hand-typed old form in the client's sources. Identifiers
/// (`SecureTest.app`, the bundle id, the managed-preferences domain) are not
/// derived from it and never change with it.
public enum Brand {
    public static let productName = "SecureTest"
}
