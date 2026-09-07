"use client";

/**
 * Batch 3 slice 2: the last resort. `global-error.tsx` catches an error thrown
 * by the root layout itself, which is the one case `app/error.tsx` cannot see —
 * and because it REPLACES the root layout it must render its own <html> and
 * <body>, and cannot count on globals.css or the fonts having loaded. Hence
 * inline styles rather than the Tailwind tokens the rest of the app uses; the
 * wording and the "ref" are the same as every other error surface.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#f4f6f7", color: "#1c2b33", font: "16px/1.5 system-ui, sans-serif" }}>
        <main style={{ maxWidth: "34rem", margin: "4rem auto", padding: "0 1.5rem" }}>
          <div
            style={{
              border: "1px solid #c0392b",
              borderLeftWidth: 4,
              borderRadius: 6,
              background: "#fff",
              padding: "1rem 1.25rem",
            }}
          >
            <h1 style={{ fontSize: "1.15rem", margin: "0 0 .5rem" }}>Something went wrong.</h1>
            <p>Try again in a moment. If it keeps happening, tell IT and give them the ref below.</p>
            {error.digest ? (
              <p>
                <code style={{ fontSize: ".8rem", color: "#5a6b75" }}>ref {error.digest}</code>
              </p>
            ) : null}
          </div>
          <p style={{ marginTop: "1.5rem" }}>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                font: "inherit",
                padding: ".5rem 1rem",
                borderRadius: 6,
                border: "1px solid #1c2b33",
                background: "#1c2b33",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
          </p>
        </main>
      </body>
    </html>
  );
}
