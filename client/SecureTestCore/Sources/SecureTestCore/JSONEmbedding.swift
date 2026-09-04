import Foundation

/// Makes a JSON string safe to place inside an inline `<script>` element.
///
/// PoC-B embeds its payload as `const items = <json>;` inside `<script>`. JSON
/// encoding does not escape `<` or `/`, so an item whose stem contained the
/// literal text `</script>` would close the element early and everything after
/// it would be parsed as markup. The page's CSP allows `script-src
/// 'unsafe-inline'`, so an injected `<script>` would then RUN, with reach into
/// `window.webkit.messageHandlers` — i.e. it could post fabricated responses.
///
/// Stems are teacher-authored rather than student-authored, so this is not a
/// student-facing escalation on its own. It is still content flowing from a
/// database into an executable context, and the fix is one substitution, so the
/// new client does it rather than inheriting the hazard.
///
/// `<` is used rather than a backslash before `/` because it is valid JSON
/// (a `\/` escape is legal too, but only inside strings — escaping the code
/// point works uniformly and survives re-encoding). U+2028 and U+2029 are legal
/// in JSON strings but are line terminators in older JS parsers, which would
/// break the statement; they are escaped for the same reason.
public enum JSONEmbedding {
    public static func escapeForScriptElement(_ json: String) -> String {
        var out = ""
        out.reserveCapacity(json.count)
        for ch in json {
            switch ch {
            case "<": out += "\\u003c"
            case ">": out += "\\u003e"
            case "&": out += "\\u0026"
            case "\u{2028}": out += "\\u2028"
            case "\u{2029}": out += "\\u2029"
            default: out.append(ch)
            }
        }
        return out
    }

    /// Encodes `value` and returns a string ready to interpolate into a
    /// `<script>` body. Returns `fallback` if encoding fails, so a malformed
    /// payload degrades to an empty render rather than emitting broken JS.
    public static func embeddable<T: Encodable>(
        _ value: T,
        fallback: String = "null"
    ) -> String {
        let encoder = JSONEncoder()
        // Stable key order keeps rendered pages diffable in tests.
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(value),
              let json = String(data: data, encoding: .utf8) else {
            return fallback
        }
        return escapeForScriptElement(json)
    }
}
