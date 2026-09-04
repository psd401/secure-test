import { localFsProvider } from "./localFsProvider";
import { s3Provider } from "./s3Provider";
import type { StorageProvider } from "./types";

// getStorageProvider() returns the *active* provider new uploads are written
// to, selected by STORAGE_PROVIDER (default "local-fs"). Reads and deletes must
// instead route by each asset row's persisted storage_provider via
// getStorageProviderById(), so a mixed-provider migration window (legacy
// local-fs rows still readable after an S3 rollout) stays correct without a
// backfill. New cloud-backed implementations drop in as one-file additions
// (ADR 0008).
export function getStorageProvider(): StorageProvider {
  return getStorageProviderById(process.env.STORAGE_PROVIDER ?? "local-fs");
}

// Resolve a provider by the id persisted in assets.storage_provider (i.e. a
// provider's own `id` field). Unknown ids throw an error pointing at ADR 0008.
export function getStorageProviderById(id: string): StorageProvider {
  if (id === "local-fs") return localFsProvider;
  if (id === "s3") return s3Provider;
  throw new Error(
    `storage provider "${id}" is not implemented. Supported: "local-fs", ` +
      `"s3". See docs/adr/0008-storage-abstraction-local-fs-first.md for the ` +
      `swap path.`,
  );
}

export { localFsProvider, s3Provider };
export type { StorageProvider, PutAssetInput } from "./types";
