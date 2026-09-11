'use client'

import { ChevronDown } from 'lucide-react'
import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

/**
 * Form controls.
 *
 * Native selects cannot be styled beyond a point — the browser draws the
 * chevron and the control's metrics itself, which is why an unstyled `select`
 * looks foreign next to everything around it. `appearance-none` removes the
 * native chrome so the sizing, border and focus ring match the inputs, and the
 * chevron is drawn as an overlay. The dropdown list itself is still the OS
 * widget; that is the trade for keeping keyboard behaviour and accessibility
 * for free, and it is the right trade here.
 */

const base =
  'w-full rounded-md border border-border bg-surface text-fg transition-[color,background-color,border-color,box-shadow] duration-100 ' +
  'placeholder:text-fg-subtle ' +
  'hover:border-border-strong hover:bg-surface-raised ' +
  'focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-ring/40 ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

const sizes = {
  sm: 'h-7 px-2 text-xs',
  md: 'h-8 px-2.5 text-[13px]',
} as const

type Size = keyof typeof sizes

// `size` is a native numeric attribute on input and select, so it has to be
// omitted before being redefined as a variant name.
type WithSize<T> = Omit<T, 'size'> & { size?: Size }

export const Input = forwardRef<HTMLInputElement, WithSize<React.ComponentProps<'input'>>>(
  ({ className, size = 'md', ...props }, ref) => (
    <input ref={ref} className={cn(base, sizes[size], className)} {...props} />
  ),
)
Input.displayName = 'Input'

export const Textarea = forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(base, 'resize-y px-2.5 py-2 text-[13px] leading-relaxed', className)}
      {...props}
    />
  ),
)
Textarea.displayName = 'Textarea'

export const Select = forwardRef<HTMLSelectElement, WithSize<React.ComponentProps<'select'>>>(({ className, size = 'md', children, ...props }, ref) => (
<div className="relative inline-flex items-center">
    <select
      ref={ref}
      className={cn(
        base,
        sizes[size],
        // The WebKit prefix lives in a base rule in globals.css: written as a
        // class, Tailwind reads the leading dash as a negative utility and
        // emits nothing, so WebKit kept drawing its own arrow beside ours.
        'cursor-pointer appearance-none pr-7',
        className,
      )}
      {...props}
    >
      {children}
    </select>
    <ChevronDown
      size={13}
      aria-hidden
      className="text-fg-subtle pointer-events-none absolute right-2"
    />
  </div>
))
Select.displayName = 'Select'

const buttonVariants = {
  primary: 'bg-accent text-accent-fg hover:opacity-90',
  secondary: 'border border-border bg-surface text-fg hover:bg-surface-raised hover:border-border-strong',
  ghost: 'text-fg-muted hover:bg-surface-raised hover:text-fg',
  quiet:
    'border border-transparent text-fg-muted hover:border-border hover:bg-surface-raised hover:text-fg',
  danger: 'text-danger hover:bg-danger-subtle',
} as const

export const Button = forwardRef<
  HTMLButtonElement,
  WithSize<React.ComponentProps<'button'>> & { variant?: keyof typeof buttonVariants }
>(({ className, variant = 'secondary', size = 'md', ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    className={cn(
      'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium transition-all',
      'focus-visible:ring-ring/40 focus-visible:outline-none focus-visible:ring-2',
      'disabled:pointer-events-none disabled:opacity-50',
      'active:scale-[0.98]',
      sizes[size],
      buttonVariants[variant],
      className,
    )}
    {...props}
  />
))
Button.displayName = 'Button'

/** Label above a control, used down the task-detail sidebar. */
export const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="flex flex-col gap-1">
    <span className="text-fg-subtle text-[11px] font-medium">{label}</span>
    {children}
  </label>
)

/**
 * The small inline input used inside popovers, pickers and rows.
 *
 * The same class string was hand-written in seven places, so they had drifted
 * apart on height, radius and focus treatment. One definition means one look.
 */
export const InlineInput = forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'border-border bg-bg text-fg placeholder:text-fg-subtle h-[28px] w-full rounded-md border px-2 text-[12.5px] outline-none',
        'transition-[border-color,box-shadow] duration-100',
        'hover:border-border-strong focus:border-accent focus:ring-ring/30 focus:ring-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
)
InlineInput.displayName = 'InlineInput'
