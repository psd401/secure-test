import type { NotifyPublisher } from "./types";

/**
 * Test/dev default (NOTIFY_PROVIDER unset or "mock"). Records every call so a
 * test can assert on subject/body without a real SNS topic or network call.
 */
export interface RecordedNotification {
  subject: string;
  body: string;
}

export const notifications: RecordedNotification[] = [];

export const mockNotifyProvider: NotifyPublisher = {
  id: "mock",
  async publish(subject, body) {
    notifications.push({ subject, body });
  },
};

/** Test seam: clears recorded calls between tests. */
export function resetMockNotifications(): void {
  notifications.length = 0;
}
