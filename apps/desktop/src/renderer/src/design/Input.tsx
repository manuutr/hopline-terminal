import { Eye, EyeOff } from 'lucide-react'
import { forwardRef, useState, type InputHTMLAttributes } from 'react'
import { cn } from './cn'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref
) {
  return (
    <input
      ref={ref}
      spellCheck={false}
      className={cn(
        'h-7 w-full rounded-md border border-line-input bg-surface px-2.5 text-sm text-fg placeholder:text-fg-subtle',
        'transition-colors duration-[var(--dur-fast)] focus:border-accent/60 focus:outline-none focus-visible:outline-none aria-[invalid=true]:border-danger/70',
        className
      )}
      {...props}
    />
  )
})

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>): React.JSX.Element {
  return <label className={cn('text-xs font-medium text-fg-muted', className)} {...props} />
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <select
      className={cn(
        'hop-select h-7 w-full appearance-none rounded-md border border-line-input bg-surface pl-2.5 pr-7 text-sm text-fg focus:border-accent/60 focus:outline-none',
        className
      )}
      {...props}
    />
  )
}

/** A password field with a show/hide toggle (P2-7). Hidden by default; the toggle follows the field in tab order. */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(function PasswordInput(
  { className, ...props },
  ref
) {
  const [shown, setShown] = useState(false)
  return (
    <div className="relative">
      <Input ref={ref} type={shown ? 'text' : 'password'} autoComplete="off" className={cn('pr-8', className)} {...props} />
      <button
        type="button"
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        onClick={() => setShown(!shown)}
        className="absolute right-0.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-fg-subtle hover:bg-hover hover:text-fg [&_svg]:size-3.5"
      >
        {shown ? <EyeOff /> : <Eye />}
      </button>
    </div>
  )
})
