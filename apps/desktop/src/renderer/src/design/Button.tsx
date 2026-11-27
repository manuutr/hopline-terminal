import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from './cn'

const button = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[background-color,color,border-color,opacity,filter,transform] duration-[var(--dur-fast)] ease-[var(--ease-std)] disabled:pointer-events-none disabled:border-transparent disabled:bg-hover disabled:text-fg-subtle! disabled:filter-none disabled:[&_kbd]:text-fg-subtle [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // Pressed: a darker fill and a 1 px settle, so a click is felt (P2-19).
        primary: 'bg-accent text-accent-fg hover:brightness-110 active:brightness-95 active:translate-y-px [&_kbd]:bg-black/15 [&_kbd]:text-current',
        secondary: 'bg-raised text-fg border border-line-strong hover:bg-active active:bg-active/80 active:translate-y-px',
        ghost: 'text-fg-muted hover:text-fg hover:bg-hover active:bg-active active:translate-y-px',
        danger: 'bg-danger-soft text-danger border border-danger/25 hover:bg-danger/12 active:bg-danger/14 active:translate-y-px focus-visible:outline-danger/50',
        // The one solid red: confirming a disruptive change, after the typed hostname matched.
        'danger-solid': 'bg-danger text-white hover:brightness-110 active:brightness-95 active:translate-y-px focus-visible:outline-danger/60 dark:text-[#1a0606] [&_kbd]:bg-black/15 [&_kbd]:text-current',
        ok: 'bg-ok-soft text-ok border border-ok/25 hover:bg-ok/11 active:bg-ok/12 active:translate-y-px'
      },
      size: {
        sm: 'h-6 px-2 text-xs',
        md: 'h-7 px-2.5 text-sm',
        lg: 'h-8 px-3 text-sm',
        icon: 'size-7',
        'icon-sm': 'size-6'
      }
    },
    defaultVariants: { variant: 'secondary', size: 'md' }
  }
)

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type = 'button', ...props },
  ref
) {
  return <button ref={ref} type={type} className={cn(button({ variant, size }), className)} {...props} />
})
