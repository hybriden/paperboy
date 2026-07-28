"use client";

/**
 * Last-resort boundary for errors thrown in the root layout itself, where
 * app/error.tsx cannot render (it lives inside that layout). Must therefore ship
 * its own <html>/<body>.
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <div style={{ textAlign: "center", padding: "80px 24px", fontFamily: "system-ui, sans-serif" }}>
          <h1>Something went wrong</h1>
          <p>This site couldn&rsquo;t be loaded. It is usually temporary.</p>
          <button type="button" onClick={() => reset()}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
