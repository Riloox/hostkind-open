import { Component } from 'react';
import { Button } from '@/components/ui/button';

/*
 * Two-tier error boundary. The view-level instance in App.jsx catches
 * render/lifecycle errors in the view subtree so one broken view can never
 * white-screen the whole shell. Per-panel instances wrap Sidebar, Header and
 * ControlBar individually so a crash in one shell panel degrades to an inline
 * recovery surface instead of taking the app down, and a top-level instance
 * guards the whole AppShell as the last resort.
 *
 * `resetKeys` (compared shallowly) clears a caught error when the app moves
 * on - e.g. resetKeys={[viewNonce]} re-mounts the recovery surface into a
 * fresh attempt after the server comes online.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('view error boundary:', error, info);
  }

  componentDidUpdate(prevProps) {
    if (!this.state.error) return;
    const next = this.props.resetKeys;
    const prev = prevProps.resetKeys;
    if (next === prev) return;
    const changed = Array.isArray(next) && Array.isArray(prev)
      ? next.length !== prev.length || next.some((v, i) => v !== prev[i])
      : true;
    if (changed) this.setState({ error: null });
  }

  render() {
    if (this.state.error) {
      return (
        <div
          data-testid={this.props.testId || 'view-error-boundary'}
          className="flex flex-col items-center justify-center gap-4 py-24 text-center"
        >
          <p className="max-w-md text-sm text-foreground">
            {this.props.fallbackText || 'Something went wrong rendering this view.'}
          </p>
          <Button
            variant="outline"
            onClick={() => window.location.reload()}
          >
            {this.props.reloadText || 'Reload'}
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
