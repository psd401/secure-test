import Foundation

/// Text-to-speech slice 1 (`docs/speech-tools-design.md`, D-4 = b): the spoken
/// form of one KaTeX expression, for the read-aloud of a stem, a stimulus or a
/// source.
///
/// A small mapper for the subset teachers actually write — numbers, the four
/// operations, comparisons, fractions, powers, roots, subscripts, brackets,
/// Greek letters, degrees and percent, plus the shared K-12 macros
/// (`GeneratedKatexMacros`). It is deliberately all-or-nothing per expression:
/// anything outside the subset (an unknown command, an unbalanced brace) makes
/// the WHOLE expression read as "math expression" rather than half of it read
/// and half skipped, because a partial reading of a formula is worse than an
/// honest placeholder. D-4: a gap here must never delay the rollout, and it
/// never breaks the prose around it — that is read verbatim either way.
///
/// Pure Swift, no state: `SpeechScript` calls it once per math segment.
public enum MathSpeech {
    /// What an expression the mapper cannot read is spoken as.
    public static let fallback = "math expression"

    /// The words for `tex` — the source between the `$` delimiters, without
    /// them. Never empty: an expression that maps to nothing is the fallback.
    public static func words(_ tex: String) -> String {
        var parser = Parser(tex)
        guard let words = parser.parseAll() else { return fallback }
        let spoken = join(words)
        return spoken.isEmpty ? fallback : spoken
    }

    /// Words with single spaces, a comma hugging the word before it so the
    /// synthesizer pauses there rather than saying "comma".
    static func join(_ words: [String]) -> String {
        var out = ""
        for word in words where !word.isEmpty {
            if word == "," {
                if !out.isEmpty, !out.hasSuffix(",") { out += "," }
                continue
            }
            if !out.isEmpty { out += " " }
            out += word
        }
        while out.hasSuffix(",") { out.removeLast() }
        return out
    }

    // MARK: - Vocabulary

    /// Commands that are one word (or phrase) and take no argument.
    static let symbolWords: [String: String] = [
        "times": "times", "cdot": "times", "ast": "times",
        "div": "divided by",
        "pm": "plus or minus", "plusminus": "plus or minus", "mp": "minus or plus",
        "lt": "is less than", "gt": "is greater than",
        "le": "is less than or equal to", "leq": "is less than or equal to",
        "leqslant": "is less than or equal to",
        "ge": "is greater than or equal to", "geq": "is greater than or equal to",
        "geqslant": "is greater than or equal to",
        "ne": "is not equal to", "neq": "is not equal to",
        "approx": "is approximately equal to",
        "cong": "is congruent to", "sim": "is similar to",
        "perp": "is perpendicular to", "parallel": "is parallel to",
        "infty": "infinity", "angle": "angle", "triangle": "triangle",
        "circ": "degrees", "degree": "degrees",
        "%": "percent", "percent": "percent",
        "$": "dollars", "&": "and", "#": "number",
        "{": "open brace", "}": "close brace",
        "ldots": "dot dot dot", "dots": "dot dot dot", "cdots": "dot dot dot",
        "rightarrow": "goes to", "to": "goes to",
        "half": "one half", "third": "one third", "quarter": "one quarter",
        "sin": "sine", "cos": "cosine", "tan": "tangent",
        "sec": "secant", "csc": "cosecant", "cot": "cotangent",
        "log": "log", "ln": "natural log", "exp": "exp",
        "min": "min", "max": "max",
    ]

    /// Lower-case Greek, by command name; the capitals add "capital".
    static let greek: [String] = [
        "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta",
        "iota", "kappa", "lambda", "mu", "nu", "xi", "omicron", "pi", "rho",
        "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega",
    ]
    static let greekVariants: [String: String] = [
        "varepsilon": "epsilon", "vartheta": "theta", "varphi": "phi",
        "varpi": "pi", "varrho": "rho", "varsigma": "sigma",
    ]

    /// Commands that are layout only — sizing, spacing — and say nothing.
    static let silentCommands: Set<String> = [
        "left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl",
        "Bigr", "displaystyle", "textstyle", "scriptstyle",
        ",", ";", ":", "!", " ", "quad", "qquad",
    ]

    /// Commands whose argument is TEXT, read as written.
    static let textCommands: Set<String> = [
        "text", "textrm", "textbf", "textit", "textsf", "mathrm", "mathbf",
        "mathit", "mathsf", "operatorname", "mbox",
    ]

    /// Single characters outside the letters and digits.
    static let characterWords: [Character: String] = [
        "+": "plus", "=": "equals", "<": "is less than", ">": "is greater than",
        "×": "times", "*": "times", "·": "times", "÷": "divided by", "/": "divided by",
        "≤": "is less than or equal to", "≥": "is greater than or equal to",
        "≠": "is not equal to", "≈": "is approximately equal to", "±": "plus or minus",
        "(": "open paren", ")": "close paren", "[": "open bracket", "]": "close bracket",
        "|": "bar", "!": "factorial", "'": "prime", ":": "to", "%": "percent",
        "°": "degrees", "π": "pi", "θ": "theta", "α": "alpha", "β": "beta",
        "γ": "gamma", "μ": "mu", "σ": "sigma", "Δ": "capital delta",
        "Σ": "capital sigma", "Ω": "capital omega", "∞": "infinity", ",": ",",
    ]

    /// After one of these a `-` is a sign ("negative"), not subtraction.
    static let operatorWords: Set<String> = [
        "plus", "minus", "negative", "times", "divided by", "equals",
        "is less than", "is greater than", "is less than or equal to",
        "is greater than or equal to", "is not equal to",
        "is approximately equal to", "plus or minus", "minus or plus",
        "open paren", "open bracket", "over", ",",
    ]

    // MARK: - Parser

    private enum Token: Equatable {
        case command(String)
        case open
        case close
        case char(Character)
    }

    private struct Parser {
        private let tokens: [Token]
        private var at = 0

        init(_ tex: String) {
            var tokens: [Token] = []
            let chars = Array(tex)
            var i = 0
            while i < chars.count {
                let c = chars[i]
                if c == "\\" {
                    var j = i + 1
                    if j < chars.count, chars[j].isLetter, chars[j].isASCII {
                        while j < chars.count, chars[j].isLetter, chars[j].isASCII { j += 1 }
                        tokens.append(.command(String(chars[(i + 1)..<j])))
                        i = j
                    } else if j < chars.count {
                        tokens.append(.command(String(chars[j])))
                        i = j + 1
                    } else {
                        // A trailing backslash is not TeX at all.
                        tokens.append(.command(""))
                        i = j
                    }
                    continue
                }
                if c == "{" { tokens.append(.open) } else if c == "}" { tokens.append(.close) } else { tokens.append(.char(c)) }
                i += 1
            }
            self.tokens = tokens
        }

        /// The whole expression, or nil when any part of it is outside the
        /// subset — including a brace left open or closed twice.
        mutating func parseAll() -> [String]? {
            guard let words = parseSequence(until: nil) else { return nil }
            return at == tokens.count ? words : nil
        }

        private var peek: Token? { at < tokens.count ? tokens[at] : nil }

        private func isSpace(_ t: Token?) -> Bool {
            if case .char(let c)? = t { return c.isWhitespace || c == "~" }
            return false
        }

        private mutating func skipSpaces() {
            while isSpace(peek) { at += 1 }
        }

        /// Items until `stop` (a closing brace, or `]` for a root's index) or
        /// the end. The stop token itself is consumed.
        private mutating func parseSequence(until stop: Token?) -> [String]? {
            var words: [String] = []
            while true {
                skipSpaces()
                guard let token = peek else {
                    return stop == nil ? words : nil
                }
                if let stop, token == stop {
                    at += 1
                    return words
                }
                if token == .close { return nil }
                guard let item = parseItem(after: words) else { return nil }
                words += item
            }
        }

        /// One argument: a braced group, or a single token (TeX's `x^23` is
        /// `x^{2}3`).
        private mutating func parseArgument() -> [String]? {
            skipSpaces()
            guard let token = peek else { return nil }
            if token == .open {
                at += 1
                return parseSequence(until: .close)
            }
            if case .char(let c) = token, c.isNumber {
                at += 1
                return [String(c)]
            }
            return parseItem(after: [])
        }

        /// The raw characters of a `{…}` group, for `\text{…}`.
        private mutating func rawGroup() -> String? {
            skipSpaces()
            guard peek == .open else { return nil }
            at += 1
            var depth = 1
            var out = ""
            while let token = peek {
                at += 1
                switch token {
                case .open:
                    depth += 1
                    out.append("{")
                case .close:
                    depth -= 1
                    if depth == 0 { return out }
                    out.append("}")
                case .char(let c):
                    out.append(c)
                case .command(let name):
                    // `\$`, `\%`, `\&` inside text are the characters.
                    if name.count == 1, !(name.first?.isLetter ?? false) { out.append(contentsOf: name) } else { out.append(" ") }
                }
            }
            return nil
        }

        private static func expectsOperand(_ words: [String]) -> Bool {
            guard let last = words.last else { return true }
            return MathSpeech.operatorWords.contains(last)
        }

        private static func isSimple(_ words: [String]) -> Bool {
            words.count == 1 && !words[0].contains(" ")
        }

        private mutating func parseItem(after previous: [String]) -> [String]? {
            guard let token = peek else { return nil }
            switch token {
            case .open:
                at += 1
                return parseSequence(until: .close)
            case .close:
                return nil
            case .char(let c):
                if c.isASCII, c.isNumber || (c == "." && nextIsDigit(from: at + 1)) {
                    return [number()]
                }
                at += 1
                if c.isASCII, c.isLetter { return [String(c)] }
                if c == "-" || c == "−" {
                    return [Self.expectsOperand(previous) ? "negative" : "minus"]
                }
                if c == "^" { return power(after: previous) }
                if c == "_" {
                    guard let sub = parseArgument() else { return nil }
                    return ["sub"] + sub + (Self.isSimple(sub) ? [] : [","])
                }
                if c == "." { return [] }
                if let word = MathSpeech.characterWords[c] { return [word] }
                return nil
            case .command(let name):
                at += 1
                return command(name, after: previous)
            }
        }

        private func nextIsDigit(from index: Int) -> Bool {
            guard index < tokens.count, case .char(let c) = tokens[index] else { return false }
            return c.isASCII && c.isNumber
        }

        /// A run of digits with its decimal point and thousands commas, kept as
        /// written — the synthesizer reads "3.5" and "57,600" correctly.
        private mutating func number() -> String {
            var out = ""
            while let token = peek, case .char(let c) = token {
                if c.isASCII, c.isNumber {
                    out.append(c)
                } else if c == "." || c == ",", nextIsDigit(from: at + 1) {
                    out.append(c)
                } else {
                    break
                }
                at += 1
            }
            return out
        }

        private mutating func power(after previous: [String]) -> [String]? {
            guard let exponent = parseArgument() else { return nil }
            if exponent == ["degrees"] { return ["degrees"] }
            if exponent == ["2"] { return ["squared"] }
            if exponent == ["3"] { return ["cubed"] }
            if exponent == ["prime"] { return ["prime"] }
            return ["to the power"] + exponent + (Self.isSimple(exponent) ? [] : [","])
        }

        private mutating func command(_ name: String, after previous: [String]) -> [String]? {
            if MathSpeech.silentCommands.contains(name) {
                // `\left.` / `\right.` — an invisible delimiter.
                if name == "left" || name == "right", case .char(".")? = peek { at += 1 }
                return []
            }
            if let word = MathSpeech.symbolWords[name] { return [word] }
            if MathSpeech.greek.contains(name) { return [name] }
            if let base = MathSpeech.greekVariants[name] { return [base] }
            if let first = name.first, first.isUppercase,
               MathSpeech.greek.contains(name.lowercased()) {
                return ["capital " + name.lowercased()]
            }
            if MathSpeech.textCommands.contains(name) {
                guard let text = rawGroup() else { return nil }
                let trimmed = text.trimmingCharacters(in: .whitespaces)
                return trimmed.isEmpty ? [] : [trimmed]
            }
            switch name {
            case "frac", "dfrac", "tfrac", "cfrac":
                guard let numerator = parseArgument(), let denominator = parseArgument() else { return nil }
                if Self.isSimple(numerator), Self.isSimple(denominator) {
                    return numerator + ["over"] + denominator
                }
                return ["fraction"] + numerator + ["over"] + denominator + [",", "end fraction", ","]
            case "sqrt":
                var lead = ["square root of"]
                skipSpaces()
                if case .char("[")? = peek {
                    at += 1
                    guard let index = parseSequence(until: .char("]")) else { return nil }
                    if index == ["3"] {
                        lead = ["cube root of"]
                    } else if Self.isSimple(index) {
                        lead = [index[0] + "th root of"]
                    } else {
                        return nil
                    }
                }
                guard let radicand = parseArgument() else { return nil }
                return lead + radicand + (Self.isSimple(radicand) ? [] : [",", "end root", ","])
            default:
                return nil
            }
        }
    }
}
