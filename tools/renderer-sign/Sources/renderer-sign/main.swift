// renderer-sign — the served renderer's signer and verifier
// (docs/server-delivered-renderer-design.md 2.a). See ../../README.md.
//
//   renderer-sign create-key     [--key-file PATH]
//   renderer-sign public-key     [--key-file PATH | --dev-key PEM_PATH]
//   renderer-sign sign MANIFEST  --out SIG_PATH [--key-file PATH | --dev-key PEM_PATH]
//   renderer-sign create-dev-key --out PEM_PATH
//   renderer-sign verify MANIFEST SIG_PATH --public-key PEM_PATH
//
// Exit codes: 0 ok (verify: the signature is good), 1 verify failed,
// 2 usage or any other error.

import CryptoKit
import Foundation
import LocalAuthentication
import RendererSignCore
import Security

let defaultKeyFile = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".secure-test/renderer-signing.se-key").path

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("renderer-sign: \(message)\n".utf8))
    exit(2)
}

func usage() -> Never {
    fail("""
    usage:
      renderer-sign create-key     [--key-file PATH]
      renderer-sign public-key     [--key-file PATH | --dev-key PEM_PATH]
      renderer-sign sign MANIFEST  --out SIG_PATH [--key-file PATH | --dev-key PEM_PATH]
      renderer-sign create-dev-key --out PEM_PATH
      renderer-sign verify MANIFEST SIG_PATH --public-key PEM_PATH
    """)
}

/// Positional arguments plus `--name value` options; anything not listed
/// in `allowed` is a usage error.
func parse(_ args: ArraySlice<String>, allowed: Set<String>) -> (positional: [String], options: [String: String]) {
    var positional: [String] = []
    var options: [String: String] = [:]
    var i = args.startIndex
    while i < args.endIndex {
        let a = args[i]
        if a.hasPrefix("--") {
            guard allowed.contains(a), i + 1 < args.endIndex, options[a] == nil else { usage() }
            options[a] = args[i + 1]
            i += 2
        } else {
            positional.append(a)
            i += 1
        }
    }
    return (positional, options)
}

func readFile(_ path: String) -> Data {
    guard let data = FileManager.default.contents(atPath: path) else {
        fail("cannot read \(path)")
    }
    return data
}

func readText(_ path: String) -> String {
    guard let text = String(data: readFile(path), encoding: .utf8) else {
        fail("\(path) is not UTF-8 text")
    }
    return text
}

/// Writes a secret-bearing file: mode 0600, and never over an existing file
/// (O_EXCL) — losing a key by overwriting it is the one mistake this tool
/// must not make.
func writeNewPrivateFile(_ path: String, _ data: Data) {
    let fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
    if fd < 0 {
        if errno == EEXIST { fail("\(path) already exists; refusing to overwrite it") }
        fail("cannot create \(path): \(String(cString: strerror(errno)))")
    }
    defer { close(fd) }
    let written = data.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
    if written != data.count { fail("short write to \(path)") }
}

func ensurePrivateDirectory(for path: String) {
    let dir = (path as NSString).deletingLastPathComponent
    if dir.isEmpty || FileManager.default.fileExists(atPath: dir) { return }
    do {
        try FileManager.default.createDirectory(
            atPath: dir, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
    } catch {
        fail("cannot create \(dir): \(error)")
    }
}

/// Either the Secure Enclave key file or a software dev key, never both.
enum KeySource {
    case enclave(path: String)
    case dev(pemPath: String)

    init(_ options: [String: String]) {
        switch (options["--key-file"], options["--dev-key"]) {
        case (.some, .some): fail("pass --key-file or --dev-key, not both")
        case (_, .some(let pem)): self = .dev(pemPath: pem)
        case (let file, nil): self = .enclave(path: file ?? defaultKeyFile)
        }
    }
}

func requireEnclave() {
    if !SecureEnclave.isAvailable { fail("this Mac has no Secure Enclave") }
}

/// Loads the opaque Secure Enclave key blob. The blob is useless anywhere
/// but this Mac's Secure Enclave; reading its public half needs no Touch ID,
/// every signature does (the access control set at create-key).
func loadEnclaveKey(_ path: String, context: LAContext? = nil) -> SecureEnclave.P256.Signing.PrivateKey {
    requireEnclave()
    let blob = readFile(path)
    do {
        return try SecureEnclave.P256.Signing.PrivateKey(
            dataRepresentation: blob, authenticationContext: context)
    } catch {
        fail("cannot load the Secure Enclave key from \(path) (made on another Mac?): \(error)")
    }
}

/// On stderr, so `public-key` / `create-dev-key` stdout stays pure PEM.
func printDevWarning() {
    FileHandle.standardError.write(Data("DEV KEY — not for production\n".utf8))
}

// MARK: - Commands

func createKey(_ args: ArraySlice<String>) {
    let (pos, opts) = parse(args, allowed: ["--key-file"])
    guard pos.isEmpty else { usage() }
    let path = opts["--key-file"] ?? defaultKeyFile
    requireEnclave()
    if FileManager.default.fileExists(atPath: path) {
        fail("\(path) already exists; refusing to overwrite it")
    }

    // Access control on the key:
    // - WhenUnlockedThisDeviceOnly: usable only while this Mac is unlocked,
    //   never migrated or restored to another device.
    // - .privateKeyUsage: required for a Secure Enclave key.
    // - .biometryAny: every signature needs a Touch ID match with ANY
    //   enrolled finger. `.biometryCurrentSet` would invalidate the key the
    //   moment a fingerprint is added or removed — a routine change that
    //   would silently destroy the working key and force a rotation.
    //   `.biometryAny` survives re-enrollment; the protection that matters
    //   (a person present at this Mac for each signature) is unchanged.
    // A lost or replaced Mac loses this key for good: the backup key on the
    // hardware token signs the next release, which rotates to a new working
    // key (2.a).
    var cfError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.privateKeyUsage, .biometryAny],
        &cfError
    ) else {
        let err = cfError?.takeRetainedValue()
        fail("cannot create the access control: \(err.map { "\($0)" } ?? "unknown error")")
    }

    let key: SecureEnclave.P256.Signing.PrivateKey
    do {
        key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
    } catch {
        fail("the Secure Enclave refused to create the key: \(error)")
    }

    ensurePrivateDirectory(for: path)
    writeNewPrivateFile(path, key.dataRepresentation)
    FileHandle.standardError.write(Data("""
    wrote \(path) (0600) — an opaque Secure Enclave handle, usable only on this Mac.
    public key (compile into the shell):

    """.utf8))
    print(key.publicKey.pemRepresentation)
}

func publicKeyCommand(_ args: ArraySlice<String>) {
    let (pos, opts) = parse(args, allowed: ["--key-file", "--dev-key"])
    guard pos.isEmpty else { usage() }
    switch KeySource(opts) {
    case .enclave(let path):
        print(loadEnclaveKey(path).publicKey.pemRepresentation)
    case .dev(let pemPath):
        do {
            let key = try devPrivateKey(fromPEM: readText(pemPath))
            printDevWarning()
            print(key.publicKey.pemRepresentation)
        } catch {
            fail("\(error)")
        }
    }
}

func signCommand(_ args: ArraySlice<String>) {
    let (pos, opts) = parse(args, allowed: ["--out", "--key-file", "--dev-key"])
    guard pos.count == 1, let out = opts["--out"] else { usage() }
    let manifestBytes = readFile(pos[0])
    let summary: ManifestSummary
    do {
        summary = try ManifestSummary(manifestBytes: manifestBytes)
    } catch {
        fail("\(pos[0]): \(error)")
    }

    let signature: Data
    switch KeySource(opts) {
    case .enclave(let path):
        // The reason shows in the Touch ID prompt, so the person at the Mac
        // sees which version and commit they approve.
        let context = LAContext()
        context.localizedReason = summary.touchIDReason
        let key = loadEnclaveKey(path, context: context)
        do {
            signature = try key.signature(for: manifestBytes).derRepresentation
        } catch {
            fail("signing failed (Touch ID cancelled or not matched?): \(error)")
        }
    case .dev(let pemPath):
        printDevWarning()
        do {
            let key = try devPrivateKey(fromPEM: readText(pemPath))
            signature = try signWithSoftwareKey(manifestBytes: manifestBytes, privateKey: key)
        } catch {
            fail("\(error)")
        }
    }

    do {
        try signature.write(to: URL(fileURLWithPath: out), options: .atomic)
    } catch {
        fail("cannot write \(out): \(error)")
    }
    print("signed renderer \(summary.version) @ \(summary.commit.prefix(10))")
    print("manifest sha256  \(sha256Hex(manifestBytes))")
    print("signature sha256 \(sha256Hex(signature)) (\(signature.count) bytes, DER) → \(out)")
}

func createDevKey(_ args: ArraySlice<String>) {
    let (pos, opts) = parse(args, allowed: ["--out"])
    guard pos.isEmpty, let out = opts["--out"] else { usage() }
    let key = P256.Signing.PrivateKey()
    writeNewPrivateFile(out, Data(key.pemRepresentation.utf8))
    printDevWarning()
    FileHandle.standardError.write(Data("wrote \(out) (0600). public key:\n".utf8))
    print(key.publicKey.pemRepresentation)
}

func verifyCommand(_ args: ArraySlice<String>) {
    let (pos, opts) = parse(args, allowed: ["--public-key"])
    guard pos.count == 2, let pemPath = opts["--public-key"] else { usage() }
    let manifestBytes = readFile(pos[0])
    let signature = readFile(pos[1])
    let key: P256.Signing.PublicKey
    do {
        key = try publicKey(fromPEM: readText(pemPath))
    } catch {
        fail("\(error)")
    }
    if verifyManifestSignature(manifestBytes: manifestBytes, derSignature: signature, publicKey: key) {
        print("OK: signature verifies (manifest sha256 \(sha256Hex(manifestBytes)))")
        exit(0)
    } else {
        print("FAILED: signature does not verify")
        exit(1)
    }
}

// MARK: - Entry

let argv = CommandLine.arguments
guard argv.count >= 2 else { usage() }
let rest = argv[2...]
switch argv[1] {
case "create-key": createKey(rest)
case "public-key": publicKeyCommand(rest)
case "sign": signCommand(rest)
case "create-dev-key": createDevKey(rest)
case "verify": verifyCommand(rest)
default: usage()
}
