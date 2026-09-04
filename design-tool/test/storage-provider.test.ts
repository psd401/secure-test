import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localFsProvider } from "../lib/storage/localFsProvider";
import {
  getStorageProvider,
  getStorageProviderById,
} from "../lib/storage/provider";

let tmpRoot: string;
let originalRoot: string | undefined;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "secure-test-storage-"));
  originalRoot = process.env.STORAGE_LOCAL_ROOT;
  process.env.STORAGE_LOCAL_ROOT = tmpRoot;
});

afterAll(async () => {
  if (originalRoot === undefined) delete process.env.STORAGE_LOCAL_ROOT;
  else process.env.STORAGE_LOCAL_ROOT = originalRoot;
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("localFsProvider", () => {
  test("id is local-fs", () => {
    expect(localFsProvider.id).toBe("local-fs");
  });

  test("put then get returns identical bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const { storage_key } = await localFsProvider.put({
      id: "test-key-1",
      bytes,
      content_type: "application/octet-stream",
    });
    expect(storage_key).toBe("test-key-1");
    const got = await localFsProvider.get(storage_key);
    expect(Array.from(got)).toEqual(Array.from(bytes));
  });

  test("delete removes the key (subsequent get throws)", async () => {
    const bytes = new Uint8Array([9, 9, 9]);
    await localFsProvider.put({
      id: "test-key-del",
      bytes,
      content_type: "application/octet-stream",
    });
    await localFsProvider.delete("test-key-del");
    await expect(localFsProvider.get("test-key-del")).rejects.toThrow();
  });

  test("delete on a missing key does not throw", async () => {
    await localFsProvider.delete("never-existed");
  });
});

describe("provider selector", () => {
  test("default returns local-fs", () => {
    const original = process.env.STORAGE_PROVIDER;
    delete process.env.STORAGE_PROVIDER;
    try {
      expect(getStorageProvider().id).toBe("local-fs");
    } finally {
      if (original !== undefined) process.env.STORAGE_PROVIDER = original;
    }
  });

  test("unknown STORAGE_PROVIDER throws and points at ADR 0008", () => {
    const original = process.env.STORAGE_PROVIDER;
    process.env.STORAGE_PROVIDER = "not-real";
    try {
      expect(() => getStorageProvider()).toThrow(
        /0008-storage-abstraction-local-fs-first/,
      );
    } finally {
      if (original === undefined) delete process.env.STORAGE_PROVIDER;
      else process.env.STORAGE_PROVIDER = original;
    }
  });

  test("STORAGE_PROVIDER=s3 selects the s3 provider", () => {
    const original = process.env.STORAGE_PROVIDER;
    process.env.STORAGE_PROVIDER = "s3";
    try {
      expect(getStorageProvider().id).toBe("s3");
    } finally {
      if (original === undefined) delete process.env.STORAGE_PROVIDER;
      else process.env.STORAGE_PROVIDER = original;
    }
  });
});

describe("provider registry (getStorageProviderById)", () => {
  test("local-fs id routes to localFsProvider", () => {
    expect(getStorageProviderById("local-fs").id).toBe("local-fs");
  });

  test("s3 id routes to the s3 provider", () => {
    expect(getStorageProviderById("s3").id).toBe("s3");
  });

  test("unknown id throws and points at ADR 0008", () => {
    expect(() => getStorageProviderById("nope")).toThrow(
      /0008-storage-abstraction-local-fs-first/,
    );
  });
});
