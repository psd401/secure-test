# Backup-key rehearsal

One signing of `packages/renderer/test/fixtures/backup-rehearsal/manifest.json`
on the backup YubiKey, to prove the backup path end to end. Standard 11
rule 5 (psd-dev-standards#96) counts it as a recorded test, not a backup use,
only when all three hold: clients reject the manifest by construction, two
people sign, and it is logged in the custody record. Otherwise it is a use and
starts a rotation.

Who holds what, the token's serial and the custody-record entry are in the
ops repository, never here. The real backup signing is
`docs/server-delivered-renderer-design.md` "Signing with the backup key".

**Sign only this manifest:** 391 bytes, SHA-256
`34ea9a768cedb0ea81173298a138ed3f4c0cdb57c21ea9b8b91fba1dd9663af7`
(committed at `b40600b`; window 2026-10-01 → 2026-10-02). Never the first
rehearsal manifest (`d1dd661d…`, `4548fd6`) — its window was still live when
it was sent.

## 1. Before the rehearsal (maintainer's Mac)

Rule 5 condition 1: show, at the verifier commit clients currently ship, that
an expired manifest is rejected. Until v2.0 releases that commit is `e542005`
(tag `rehearsal-verifier-2026-10-15`); after the release it is the released
build, and these tests have to be re-run there.

```sh
W=$TMPDIR/st-rehearsal; mkdir -p $W/sign
git worktree add --detach $W/verifier rehearsal-verifier-2026-10-15
git worktree add --detach $W/server b40600b

(cd $W/verifier/client/SecureTestCore && swift test --filter \
  'RendererVerifierTests.testValidityWindowEdgesAreInclusive|RendererLoaderTests.testExpiredIsRefusedAndACachedCopyIsNotRefetched')
(cd $W/server && bun install --frozen-lockfile && cd packages/renderer && bun test test/verify.test.ts)
```

Note the date, both commits and the pass counts for the custody record.

Then:

- `ykman --version` works on the Mac the token will plug into (`brew install
  ykman`).
- The manifest is byte for byte the one above:
  `shasum -a 256 packages/renderer/test/fixtures/backup-rehearsal/manifest.json`.
  Copy it outside the repository and sign that copy:
  `cp packages/renderer/test/fixtures/backup-rehearsal/manifest.json $W/sign/`.
- `renderer-sign` is built for the "After" check:
  `(cd tools/renderer-sign && swift build -c release)`.
- The token's serial, from the ops repository's custody record.

## 2. At the token (two people)

1. Check the PIN/PUK sheet's seal together before opening it.
2. The token holder plugs the token in. The PIN holder runs, enters the PIN
   at the hidden prompt and touches the key:

   ```sh
   ykman script tools/renderer-sign/backup/sign_backup.py \
     $W/sign/manifest.json $W/sign/manifest.sig <serial>
   ```

   It prints `signed manifest.json with slot 9c on <serial>: N byte DER
   signature` (about 70–72 bytes).
3. Check it before anyone leaves:

   ```sh
   openssl dgst -sha256 -verify packages/renderer/keys/backup.pub.pem \
     -signature $W/sign/manifest.sig $W/sign/manifest.json
   ```

   Expect `Verified OK`.
4. The token goes back on the lanyard; the sheet is resealed. Nobody leaves
   with both.

## 3. After (maintainer's Mac)

1. Verify with both tools:

   ```sh
   shasum -a 256 $W/sign/manifest.json      # still 34ea9a76…63af7
   tools/renderer-sign/.build/release/renderer-sign verify \
     $W/sign/manifest.json $W/sign/manifest.sig \
     --public-key packages/renderer/keys/backup.pub.pem   # exit 0
   ```

2. Commit `manifest.sig` beside the manifest in
   `packages/renderer/test/fixtures/backup-rehearsal/`, with a TS test (the
   "backup-key rehearsal manifest" block in `packages/renderer/test/verify.test.ts`)
   and a Swift test that it verifies against the backup key only.
3. Add the rehearsal entry to the ops repository's custody record (rule 6):
   the date, both people, who holds the token and who holds the sheet, the
   signed manifest's SHA-256, `e542005` with the two Swift tests and
   `b40600b` with `verify.test.ts`, and "recorded test, not a use".
4. `git worktree remove $W/verifier && git worktree remove $W/server`.
