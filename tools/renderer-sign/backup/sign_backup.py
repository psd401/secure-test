# Signs one file with the SecureTest backup signing key (YubiKey PIV slot 9c,
# ECDSA P-256 / SHA-256) and writes the raw DER signature — the format
# `renderer-sign verify` and the shell accept. Written by the district's IT
# (2026-10-14) on Yubico's own library; the runbook is
# docs/server-delivered-renderer-design.md "Signing with the backup key".
#
# Run with ykman's bundled Python, so a ykman upgrade does not break it:
#   ykman script tools/renderer-sign/backup/sign_backup.py MANIFEST SIGNATURE_OUT SERIAL
# The token's serial is in the ops repository, never here.
#
# Selects the token by serial, checks slot 9c really holds an ECCP256 key,
# reads the PIN with a hidden prompt (it never touches argv), then asks for
# a touch.
import getpass
import sys
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from ykman.device import list_all_devices
from yubikit.core.smartcard import SmartCardConnection
from yubikit.piv import KEY_TYPE, SLOT, PivSession


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: sign_backup.py MANIFEST SIGNATURE_OUT SERIAL", file=sys.stderr)
        return 2
    manifest, sig_out, serial = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
    matches = [(dev, info) for dev, info in list_all_devices() if info.serial == serial]
    if not matches:
        print(f"STOP: no YubiKey with serial {serial} is connected", file=sys.stderr)
        return 1
    dev, info = matches[0]
    with dev.open_connection(SmartCardConnection) as conn:
        piv = PivSession(conn)
        meta = piv.get_slot_metadata(SLOT.SIGNATURE)
        if meta.key_type != KEY_TYPE.ECCP256:
            print(f"STOP: slot 9c on {serial} holds {meta.key_type}, not ECCP256", file=sys.stderr)
            return 1
        pin = getpass.getpass(f"PIN for YubiKey {serial} (hidden): ")
        piv.verify_pin(pin)
        del pin
        print("Touch the YubiKey now...")
        signature = piv.sign(SLOT.SIGNATURE, KEY_TYPE.ECCP256, manifest.read_bytes(), hashes.SHA256())
    sig_out.write_bytes(signature)
    print(f"signed {manifest.name} with slot 9c on {serial}: {len(signature)} byte DER signature")
    return 0


if __name__ == "__main__":
    sys.exit(main())
