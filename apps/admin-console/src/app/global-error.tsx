"use client";

// Minimal global error boundary. Kept dependency-free and without any
// layout-level context: Next.js renders this INSTEAD of the root layout when
// an uncaught error bubbles up, so it must carry its own <html>/<body> and
// must not read any provider context (BUILD_PLAN 1.7 console reliability).
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", background: "#020617", color: "#e2e8f0", margin: 0 }}>
        <main style={{ maxWidth: 640, margin: "0 auto", padding: "3rem 1.5rem" }}>
          <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.5rem" }}>Something went wrong</h1>
          <p style={{ color: "#94a3b8", fontSize: "0.9rem" }}>
            The platform console hit an unexpected error
            {error.digest ? ` (ref ${error.digest})` : ""}. No tenant data was
            touched.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "1rem",
              padding: "0.5rem 1rem",
              borderRadius: 8,
              border: "1px solid #334155",
              background: "#0f172a",
              color: "#e2e8f0",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}