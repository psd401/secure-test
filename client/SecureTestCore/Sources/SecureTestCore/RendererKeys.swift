import Foundation

// Server-delivered renderer slice 4a (docs/server-delivered-renderer-design.md
// 2.a, D-4, D-13): what this shell trusts and what it can answer for. The
// app (slice 4c) chooses which of these it passes to RendererVerifier.

/// The renderer manifest's trusted PUBLIC keys, compiled in. Public halves
/// only — a private key never enters this repository.
public enum RendererKeys {
    /// The working key (the maintainer's Secure Enclave). Byte-for-byte
    /// packages/renderer/keys/working.pub.pem; RendererVerifierTests fails if
    /// the two drift.
    public static let working = """
    -----BEGIN PUBLIC KEY-----
    MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWw0Zqv0pxXtFFIss2RMfOisDekKG
    Idc6LUJyUtbcvwwNHmB6/0jgwtyMgvCZ9b2u5oq3KxsZytvNrfNpOUdHAQ==
    -----END PUBLIC KEY-----

    """

    /// The backup key (the hardware token IT holds, slice 3b). Used only when
    /// the working key is unavailable; any use starts a key rotation.
    /// Byte-for-byte packages/renderer/keys/backup.pub.pem;
    /// RendererVerifierTests fails if the two drift.
    public static let backup = """
    -----BEGIN PUBLIC KEY-----
    MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEicV/w0mEUKmBkbT4xxrOMP73EoeW
    n747FnR5+IhI0GNP1Bwj0yxG9NtDQ5SYGFr9mlNOgroLqES03x59ugSQbQ==
    -----END PUBLIC KEY-----

    """

    /// The persistent DEV key for local and Debug use — its private half lives
    /// outside the repository on the maintainer's Mac. Byte-for-byte
    /// packages/renderer/dev-keys/dev.pub.pem, deliberately outside
    /// packages/renderer/keys/ so the server never trusts it. Never in
    /// `releaseKeys`: only a Debug build may add it (slice 4c's decision).
    public static let dev = """
    -----BEGIN PUBLIC KEY-----
    MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqofxOcTfwNELEP25SJX1Yg2Ds0V9
    c7uSgcF4XlxTxSgFFkCPFLDPVCBj+UnIHPekJy4n805/Tloj42AE0UuqRA==
    -----END PUBLIC KEY-----

    """

    /// What a Release build trusts: the working key and the backup.
    public static var releaseKeys: [String] { [working, backup] }

    public static var devKey: String { dev }
}

/// The `requires` terms (packages/renderer/src/requires.ts) this shell can
/// answer for: the eight bridge handlers, word-range callbacks from
/// read-aloud, and (slice 4d) the generic answer channel (D-5) — the full
/// REQUIREMENTS list. RendererVerifierTests pins this against requires.ts.
public enum RendererCapabilities {
    public static let supported: Set<String> = [
        "response", "withdraw", "upload", "submit", "timer", "home", "tts", "stt",
        "tts.word_ranges", "response.generic",
    ]
}

public enum RendererPolicy {
    /// The lowest renderer `version` this shell runs. 0 = any, for now: D-13
    /// sets it to the first production-signed renderer's version before
    /// v2.0 ships.
    public static let minimumVersion = 0
}
