import { Component, type ReactNode } from "react";

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error("Admin crashed:", error);
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="grid h-full place-items-center bg-canvas p-10 text-center">
          <div className="max-w-md">
            <h1 className="masthead text-2xl">Something went wrong</h1>
            <p className="mt-2 text-sm text-muted">{this.state.error.message}</p>
            <button className="btn-primary mt-5" onClick={() => window.location.reload()}>
              Reload Paperboy
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
