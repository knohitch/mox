import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

/**
 * Dev/Studio-only render boundary. Production auth is not involved.
 * The diagnostic never includes cookies, tokens, or fixture secrets.
 */
export class StudioErrorBoundary extends Component<
  { surface: string; page: string; children: ReactNode },
  { message: string | null }
> {
  state: { message: string | null } = { message: null };

  static getDerivedStateFromError(error: Error): { message: string } {
    return { message: safeErrorMessage(error) };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    // Keep the visible diagnostic; do not log secrets.
    void error;
  }

  render(): ReactNode {
    if (this.state.message) {
      return (
        <div className="state state-error" style={{ margin: 32 }} role="alert">
          <h1>Studio render error</h1>
          <p className="muted">
            surface=<code>{this.props.surface}</code> page=<code>{this.props.page}</code>
          </p>
          <p>{this.state.message}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const text = error.message || error.name || "Render failed";
    return text.replace(/(api[_-]?key|secret|token|password|cookie|authorization)=?[^\s,;]*/gi, "[redacted]");
  }
  return "Render failed";
}
