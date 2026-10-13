# renderer-sign

Signs and verifies the served renderer's manifest
(`docs/server-delivered-renderer-design.md` 2.a, renderer slice 3).

The signature is **ECDSA P-256 / SHA-256, DER-encoded**, over the exact
bytes of `packages/renderer/dist/manifest.json` (the canonical form —
nothing is re-encoded before signing). The client shell (slice 4) and
`packages/renderer/src/verify.ts` make the same check.

## Build

```sh
cd tools/renderer-sign
swift build -c release      # → .build/release/renderer-sign
swift test                  # software keys only; no Touch ID
```

macOS 14+, CryptoKit + LocalAuthentication, no third-party dependencies.

## Commands

| Command | What it does |
|---|---|
| `create-key [--key-file PATH]` | Creates the WORKING key inside this Mac's Secure Enclave (Touch ID for every signature) and prints its public key (PEM). Refuses to overwrite an existing key file. |
| `public-key [--key-file PATH \| --dev-key PEM]` | Prints the public key as PEM (no Touch ID needed). |
| `sign MANIFEST --out SIG [--key-file PATH \| --dev-key PEM]` | Signs the manifest bytes. With the Secure Enclave key, Touch ID asks to "sign SecureTest renderer <version> @ <commit, 10 chars>". Prints the SHA-256 of the manifest and of the signature. |
| `create-dev-key --out PEM` | A software P-256 key for local and Debug use only (mode 0600, refuses overwrite). Prints its public PEM. |
| `verify MANIFEST SIG --public-key PEM` | Exit 0 when the signature verifies, 1 when it does not. |

Every `--dev-key` use prints `DEV KEY — not for production` on stderr. The
key commands print only PEM on stdout, so `> public.pem` works.

## The working key

- Default key file: `~/.secure-test/renderer-signing.se-key` (directory
  0700, file 0600).
- The file is **not the private key**. It is an opaque handle that only
  this Mac's Secure Enclave can use; the private key never leaves the
  Enclave. On any other Mac — or after this Mac's Enclave is erased — the
  file is useless.
- Access control: usable only while the Mac is unlocked, never migrated to
  another device, and every signature needs a Touch ID match with any
  enrolled finger (`.biometryAny`, so adding or removing a fingerprint
  does not destroy the key).
- A lost or replaced Mac loses the working key for good. The BACKUP key
  (on a hardware token, two-person control — not this tool) then signs a
  release that rotates to a new working key (2.a).
- **The maintainer creates the real key once, by hand, after review**
  (`create-key`), and sends the printed public key to be compiled into
  the shell. Do not run `create-key` in automation.

Never put a private key (a dev PEM included) inside the repository; keep
dev keys under `$TMPDIR` or `~/.secure-test/`. The pre-commit gitleaks hook
refuses a private key in a commit.
