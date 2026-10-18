import { Component, type ReactNode, type ErrorInfo } from 'react';
import { isChunkError, reloadPage } from '@/lib/chunkReload';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, info.componentStack);
    // A part of the app that could not load offline comes back with the network,
    // but only while this error still shows: never a reload over another screen.
    if (isChunkError(error) && navigator.onLine === false) window.addEventListener('online', this.reload, { once: true });
  }

  componentDidUpdate(_: Props, previous: State) {
    if (previous.hasError && !this.state.hasError) window.removeEventListener('online', this.reload);
  }

  componentWillUnmount() {
    window.removeEventListener('online', this.reload);
  }

  private reload = () => reloadPage();

  /** A missing chunk stays missing until the page loads again; any other error may render this time. */
  private retry = () => {
    if (isChunkError(this.state.error)) this.reload();
    else this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="min-h-[400px] flex flex-col items-center justify-center gap-4 p-8">
          <div className="text-red-500 font-sans text-sm uppercase tracking-wider">
            Erreur d'affichage
          </div>
          <p className="text-text-muted text-sm text-center max-w-md">
            {/* The cause stays in the console: a render error's text is technical. */}
            Cette section n’a pas pu s’afficher.
          </p>
          <button
            type="button"
            onClick={this.retry}
            className="px-4 py-2 text-xs font-sans bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/30 rounded hover:bg-neon-cyan/20 transition-colors"
          >
            Réessayer
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
