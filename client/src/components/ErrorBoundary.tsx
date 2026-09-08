import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  /** Rendered instead of the children when something below throws. */
  fallback: (error: Error, retry: () => void) => ReactNode;
};

type State = { error: Error | null };

/**
 * Catches render-time failures from a subtree. Used around the lazily loaded
 * whiteboard: a failed chunk fetch (offline, cache miss after a redeploy) would
 * otherwise propagate and blank out the whole meeting.
 *
 * To clear an error from outside, give the boundary a new `key` so React
 * remounts it.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Component subtree failed:", error, info.componentStack);
  }

  retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (error) {
      return this.props.fallback(error, this.retry);
    }
    return this.props.children;
  }
}
