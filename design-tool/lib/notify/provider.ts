import { mockNotifyProvider } from "./mockProvider";
import { snsProvider } from "./snsProvider";
import type { NotifyPublisher } from "./types";

// getNotifyPublisher() returns the active publisher, selected by
// NOTIFY_PROVIDER (default "mock" — same default-off shape as
// lib/ai/provider.ts and lib/storage/provider.ts). "sns" is the only
// production implementation (D-2: SNS email); a publish failure is the
// caller's problem to log and swallow (docs/observability-design.md — a
// teacher filing feedback never gets a 500 because SNS hiccuped).
export function getNotifyPublisher(): NotifyPublisher {
  return getNotifyPublisherById(process.env.NOTIFY_PROVIDER ?? "mock");
}

export function getNotifyPublisherById(id: string): NotifyPublisher {
  if (id === "mock") return mockNotifyProvider;
  if (id === "sns") return snsProvider;
  throw new Error(
    `notify provider "${id}" is not implemented. Supported: "mock", "sns". ` +
      `See docs/observability-design.md.`,
  );
}

export { mockNotifyProvider, snsProvider };
export type { NotifyPublisher } from "./types";
