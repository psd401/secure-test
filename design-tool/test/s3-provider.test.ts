// S3 storage provider (ADR 0008, slice 30). The `@aws-sdk/client-s3` module is
// mocked at module level so no AWS credentials / network access are required:
// fake commands capture their input and a fake S3Client.send returns a staged
// response or throws a staged error, keyed by command kind. Tests focus on the
// S3-specific seams — bucket/key/body wiring, optional SSE-KMS, byte readback,
// the missing-bucket guard, and AWS error wrapping.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

interface SendLog {
  kind: string;
  input: Record<string, unknown>;
}
const sendLog: SendLog[] = [];
let getResolver: { body: Uint8Array } | { error: Error } | null = null;
let putError: Error | null = null;
let deleteError: Error | null = null;
let headResolver: { size: number } | { error: Error } | null = null;

class FakeAwsError extends Error {
  $metadata: { httpStatusCode: number };
  constructor(name: string, httpStatusCode: number, message: string) {
    super(message);
    this.name = name;
    this.$metadata = { httpStatusCode };
  }
}

class FakePutObjectCommand {
  kind = "put";
  constructor(public input: Record<string, unknown>) {}
}
class FakeGetObjectCommand {
  kind = "get";
  constructor(public input: Record<string, unknown>) {}
}
class FakeDeleteObjectCommand {
  kind = "delete";
  constructor(public input: Record<string, unknown>) {}
}
class FakeHeadObjectCommand {
  kind = "head";
  constructor(public input: Record<string, unknown>) {}
}

class FakeS3Client {
  constructor(public config?: unknown) {}
  async send(command: { kind: string; input: Record<string, unknown> }) {
    sendLog.push({ kind: command.kind, input: command.input });
    if (command.kind === "put") {
      if (putError) throw putError;
      return {};
    }
    if (command.kind === "delete") {
      if (deleteError) throw deleteError;
      return {};
    }
    if (command.kind === "head") {
      if (!headResolver) throw new Error("test forgot to stage a head response");
      if ("error" in headResolver) throw headResolver.error;
      return { ContentLength: headResolver.size };
    }
    // get
    if (!getResolver) throw new Error("test forgot to stage a get response");
    if ("error" in getResolver) throw getResolver.error;
    const body = getResolver.body;
    return { Body: { transformToByteArray: async () => body } };
  }
}

mock.module("@aws-sdk/client-s3", () => ({
  S3Client: FakeS3Client,
  PutObjectCommand: FakePutObjectCommand,
  GetObjectCommand: FakeGetObjectCommand,
  DeleteObjectCommand: FakeDeleteObjectCommand,
  HeadObjectCommand: FakeHeadObjectCommand,
}));

// Import after the mock so the provider binds to the fakes.
const { s3Provider } = await import("../lib/storage/s3Provider");

const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

beforeEach(() => {
  sendLog.length = 0;
  getResolver = null;
  putError = null;
  deleteError = null;
  headResolver = null;
  setEnv("S3_BUCKET", "test-bucket");
  setEnv("S3_REGION", "us-west-2");
  setEnv("S3_KMS_KEY_ID", undefined);
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

describe("s3Provider", () => {
  test("id is s3", () => {
    expect(s3Provider.id).toBe("s3");
  });

  test("put sends bucket + key + body + content-type and returns the key", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { storage_key } = await s3Provider.put({
      id: "uuid-1",
      bytes,
      content_type: "image/png",
    });
    expect(storage_key).toBe("uuid-1");
    expect(sendLog).toHaveLength(1);
    expect(sendLog[0]!.kind).toBe("put");
    expect(sendLog[0]!.input.Bucket).toBe("test-bucket");
    expect(sendLog[0]!.input.Key).toBe("uuid-1");
    expect(sendLog[0]!.input.ContentType).toBe("image/png");
    // No KMS env → no SSE fields.
    expect(sendLog[0]!.input.ServerSideEncryption).toBeUndefined();
  });

  test("put adds SSE-KMS fields when S3_KMS_KEY_ID is set", async () => {
    setEnv("S3_KMS_KEY_ID", "arn:aws:kms:us-west-2:1:key/abc");
    await s3Provider.put({
      id: "uuid-2",
      bytes: new Uint8Array([9]),
      content_type: "image/png",
    });
    expect(sendLog[0]!.input.ServerSideEncryption).toBe("aws:kms");
    expect(sendLog[0]!.input.SSEKMSKeyId).toBe("arn:aws:kms:us-west-2:1:key/abc");
  });

  test("get returns the object bytes", async () => {
    getResolver = { body: new Uint8Array([4, 5, 6]) };
    const got = await s3Provider.get("uuid-1");
    expect(Array.from(got)).toEqual([4, 5, 6]);
    expect(sendLog[0]!.kind).toBe("get");
    expect(sendLog[0]!.input.Key).toBe("uuid-1");
  });

  // Finding 10.10: the presigned path never passes through the app, so the
  // provider has to be able to answer "did it land?".
  test("head returns the stored size for a key that exists", async () => {
    headResolver = { size: 12845 };
    expect(await s3Provider.head!("responses/a/b/c")).toEqual({ size: 12845 });
    expect(sendLog[0]!.kind).toBe("head");
    expect(sendLog[0]!.input.Bucket).toBe("test-bucket");
    expect(sendLog[0]!.input.Key).toBe("responses/a/b/c");
  });

  test("head answers null for a missing key and wraps any other failure", async () => {
    headResolver = { error: new FakeAwsError("NotFound", 404, "Not Found") };
    expect(await s3Provider.head!("nope")).toBeNull();
    headResolver = { error: new FakeAwsError("AccessDenied", 403, "denied") };
    await expect(s3Provider.head!("nope")).rejects.toThrow("storage_s3_error_403");
  });

  test("delete sends a delete for the key", async () => {
    await s3Provider.delete("uuid-1");
    expect(sendLog[0]!.kind).toBe("delete");
    expect(sendLog[0]!.input.Key).toBe("uuid-1");
  });

  test("missing S3_BUCKET throws a clear error before any send", async () => {
    setEnv("S3_BUCKET", undefined);
    await expect(
      s3Provider.put({
        id: "x",
        bytes: new Uint8Array([1]),
        content_type: "image/png",
      }),
    ).rejects.toThrow(/S3_BUCKET/);
    expect(sendLog).toHaveLength(0);
  });

  test("wraps AWS errors into storage_s3_error_<status>", async () => {
    getResolver = {
      error: new FakeAwsError("AccessDeniedException", 403, "nope"),
    };
    await expect(s3Provider.get("uuid-1")).rejects.toThrow(
      /storage_s3_error_403/,
    );
  });
});
