// A multipart POST with no Content-Length whose body would run to `mib` MiB,
// counting the chunks a route actually pulls — so a test can show the route
// stopped reading at its cap rather than after the whole body (SEC-08).
export function oversizedMultipart(url: string, mib: number) {
  let sent = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= mib) return c.close();
      sent++;
      c.enqueue(chunk);
    },
  });
  const req = new Request(url, {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=x" },
    body,
    // @ts-expect-error -- `duplex` is required for a stream body; not in lib.dom yet.
    duplex: "half",
  });
  return { req, sent: () => sent };
}
