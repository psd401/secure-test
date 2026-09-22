// Practice-sitting sweep (docs/practice-sitting-design.md, D-7 "known gap"):
// the delete step the nightly roster-sync Lambda uses to remove a swept
// practice attempt's stored upload bytes from the asset bucket. No network,
// no DB — a fake S3 client records what it was asked to delete.
import { describe, expect, test } from "bun:test";
import type { DeleteObjectCommand } from "@aws-sdk/client-s3";
import {
  createS3UploadDeleter,
  type DeleteS3Like,
} from "../infra/lambda/deleteStoredUpload";

function fakeClient(): DeleteS3Like & { calls: DeleteObjectCommand[] } {
  const calls: DeleteObjectCommand[] = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      return {};
    },
  };
}

describe("createS3UploadDeleter", () => {
  test("an s3 upload under responses/ issues one DeleteObject with the right bucket + key", async () => {
    const client = fakeClient();
    const deleteStored = createS3UploadDeleter(client, "secure-test-design-tool-dev");

    await deleteStored({
      storage_provider: "s3",
      storage_key: "responses/attempt-1/item-2/uuid-3",
    });

    expect(client.calls.length).toBe(1);
    const input = client.calls[0]!.input;
    expect(input.Bucket).toBe("secure-test-design-tool-dev");
    expect(input.Key).toBe("responses/attempt-1/item-2/uuid-3");
  });

  test("a non-s3 (local-fs) ref is skipped: no send call, and it rejects so the sweep does not count it as deleted", async () => {
    const client = fakeClient();
    const deleteStored = createS3UploadDeleter(client, "secure-test-design-tool-dev");

    await expect(
      deleteStored({ storage_provider: "local-fs", storage_key: "responses/a/b/c" }),
    ).rejects.toThrow();
    expect(client.calls.length).toBe(0);
  });

  test("an s3 ref whose key is not under responses/ is refused: no send call, and it rejects", async () => {
    const client = fakeClient();
    const deleteStored = createS3UploadDeleter(client, "secure-test-design-tool-dev");

    await expect(
      deleteStored({ storage_provider: "s3", storage_key: "other/attempt-1/item-2/uuid-3" }),
    ).rejects.toThrow();
    expect(client.calls.length).toBe(0);
  });

  test("a throwing delete client is counted (rejects) and does not corrupt a later call", async () => {
    let calls = 0;
    const failingThenOk: DeleteS3Like = {
      async send() {
        calls++;
        if (calls === 1) throw new Error("storage_s3_error_500: transient");
        return {};
      },
    };
    const deleteStored = createS3UploadDeleter(failingThenOk, "bucket");

    await expect(
      deleteStored({ storage_provider: "s3", storage_key: "responses/a/b/c" }),
    ).rejects.toThrow("storage_s3_error_500");
    // A second, independent upload still goes through — one failure does not
    // wedge the deleter, matching the sweep's own best-effort per-upload loop
    // in lib/retention/sweep.ts (each upload gets its own try/catch).
    await expect(
      deleteStored({ storage_provider: "s3", storage_key: "responses/d/e/f" }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});
