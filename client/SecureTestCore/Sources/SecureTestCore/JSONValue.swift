import Foundation

// Server-delivered renderer slice 4d (docs/server-delivered-renderer-design.md
// D-5): an answer to an item type this shell does not know travels as raw
// JSON. The shell checks it generically (BridgeChecks) and spools it as it
// arrived; exact validation of a new type is the server's.

/// Any JSON value, decoded and re-encoded without loss of meaning: the same
/// strings, booleans, numbers, arrays and objects come back out. Object key
/// order is not preserved (a JSON object has none), so compare encodings with
/// sorted keys.
public enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    /// Integers that fit in 64 bits stay integers, so `3` is not re-encoded
    /// as `3.0` on its way through the spool.
    case int(Int64)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        if let c = try? decoder.container(keyedBy: AnyKey.self) {
            var out: [String: JSONValue] = [:]
            for key in c.allKeys { out[key.stringValue] = try c.decode(JSONValue.self, forKey: key) }
            self = .object(out)
            return
        }
        if var c = try? decoder.unkeyedContainer() {
            var out: [JSONValue] = []
            while !c.isAtEnd { out.append(try c.decode(JSONValue.self)) }
            self = .array(out)
            return
        }
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let i = try? c.decode(Int64.self) { self = .int(i) }
        else if let d = try? c.decode(Double.self) { self = .double(d) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "not a JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .object(let fields):
            var c = encoder.container(keyedBy: AnyKey.self)
            for (key, value) in fields { try c.encode(value, forKey: AnyKey(key)) }
        case .array(let values):
            var c = encoder.unkeyedContainer()
            for value in values { try c.encode(value) }
        case .null:
            var c = encoder.singleValueContainer()
            try c.encodeNil()
        case .bool(let b):
            var c = encoder.singleValueContainer()
            try c.encode(b)
        case .int(let i):
            var c = encoder.singleValueContainer()
            try c.encode(i)
        case .double(let d):
            var c = encoder.singleValueContainer()
            try c.encode(d)
        case .string(let s):
            var c = encoder.singleValueContainer()
            try c.encode(s)
        }
    }

    /// Containers on the deepest path: a scalar is 0, `{}` / `[]` is 1.
    public var depth: Int {
        switch self {
        case .object(let fields): return 1 + (fields.values.map(\.depth).max() ?? 0)
        case .array(let values): return 1 + (values.map(\.depth).max() ?? 0)
        case .null, .bool, .int, .double, .string: return 0
        }
    }

    /// The longest string anywhere inside — object keys included — in UTF-16
    /// code units, as zod measures on the server.
    public var longestString: Int {
        switch self {
        case .string(let s): return s.utf16.count
        case .object(let fields):
            return fields.reduce(0) { max($0, $1.key.utf16.count, $1.value.longestString) }
        case .array(let values): return values.map(\.longestString).max() ?? 0
        case .null, .bool, .int, .double: return 0
        }
    }
}
