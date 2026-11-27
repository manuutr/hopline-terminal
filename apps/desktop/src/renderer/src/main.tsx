import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { TooltipProvider } from './design'
import { App } from './App'
import { ErrorBoundary } from './ErrorBoundary'
import { applyMotion, applyTheme, getThemePref } from './design/theme'
import { MAX_VISIBLE } from './lib/notify'
import { installFlushHandler } from './lib/save-queue'
import './styles.css'

applyMotion(localStorage.getItem('hopline.reduceMotion') === 'true')
applyTheme(getThemePref(), false)
// Answer main's "save scrollback now" at once, even with no terminal open (window close, quit).
installFlushHandler()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
      {/* Themed in one place: sonner's own description and icon colours ignore the app theme. The offset clears the status bar and the AI composer. */}
      <Toaster
        position="bottom-right"
        swipeDirections={['right', 'left', 'bottom']}
        // Toast discipline (lib/notify.ts): three at most; older ones wait their turn.
        visibleToasts={MAX_VISIBLE}
        offset={{ bottom: 84, right: 16 }}
        toastOptions={{
          classNames: {
            toast: '!bg-overlay !text-fg !border-line-strong !shadow-overlay !rounded-lg !font-sans !text-sm',
            title: '!font-medium',
            description: '!text-fg-muted !text-xs',
            actionButton: '!bg-accent !text-accent-fg',
            cancelButton: '!bg-active !text-fg',
            success: '[&_[data-icon]]:!text-ok',
            error: '[&_[data-icon]]:!text-danger',
            warning: '[&_[data-icon]]:!text-warn',
            info: '[&_[data-icon]]:!text-accent'
          }
        }}
      />
    </TooltipProvider>
  </StrictMode>
)
