import Foundation

/// Escapes text destined for HTML *markup* the client assembles in Swift.
///
/// Item content does NOT come through here — the page builds item DOM with
/// `createElement` / `textContent`, which is escape-free by construction and
/// stays that way (see PageShell's notes). This is for the handful of values the
/// Swift side interpolates into the document itself, `<title>` chiefly among
/// them, where a raw `<` really would open a tag.
public enum HTMLEscape {
    public static func text(_ input: String) -> String {
        var out = ""
        out.reserveCapacity(input.count)
        for ch in input {
            switch ch {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&#39;"
            default: out.append(ch)
            }
        }
        return out
    }
}
