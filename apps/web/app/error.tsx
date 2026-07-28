"use client";

/**
 * Route-level error boundary. Without it, a Delivery API outage (or any thrown
 * error in the content route) fell through to Next's default error page — which
 * in production is an unstyled "Application error" with no way back.
 *
 * Deliberately does NOT print the error message: this is a public frontend, and a
 * delivery error can carry internal detail. `reset()` re-runs the failed render,
 * which is the right affordance for a transient upstream failure.
 */
export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="notfound">
      <h1>Something went wrong</h1>
      <p>This page couldn&rsquo;t be loaded. It is usually temporary.</p>
      <p>
        <button type="button" onClick={() => reset()}>
          Try again
        </button>
      </p>
    </div>
  );
}
