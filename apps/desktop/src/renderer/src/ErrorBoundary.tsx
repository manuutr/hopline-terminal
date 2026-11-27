import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportRenderError } from './features/privacy/store'

/**
 * Last line of defence for a render error anywhere in the app: a "Something went wrong" panel
 * instead of a blank window. "Try again" remounts the app in place (the store survives; whether a
 * tab's terminal reattaches is not tested). "Reload" starts the window over and closes open sessions.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; attempt: number }> {
  state = { error: null as Error | null, attempt: 0 }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[hopline] render error:', error, info.componentStack)
    // Opt-in only; main scrubs it (the component stack is not sent).
    reportRenderError(error)
  }

  render(): ReactNode {
    const { error, attempt } = this.state
    if (!error)
      return (
        <div key={attempt} className="contents">
          {this.props.children}
        </div>
      )
    return (
      <div role="alert" className="flex h-screen items-center justify-center bg-surface p-6 text-fg">
        <div className="w-[min(480px,94vw)] space-y-3 rounded-xl border border-line bg-overlay p-5 shadow-overlay">
          <h1 className="text-base font-semibold">Something went wrong</h1>
          <p className="text-sm text-fg-muted">This window hit an error it could not recover from on its own. Try again redraws it; if that fails, reload.</p>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-raised p-2 text-2xs text-fg-subtle">{error.message}</pre>
          <div className="flex justify-end gap-2">
            <button type="button" className="h-7 rounded-md px-2.5 text-sm text-fg-muted hover:bg-hover hover:text-fg" onClick={() => location.reload()}>
              Reload (closes open sessions)
            </button>
            <button
              type="button"
              className="h-7 rounded-md bg-accent px-2.5 text-sm text-accent-fg hover:brightness-110"
              onClick={() => this.setState({ error: null, attempt: attempt + 1 })}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    )
  }
}
