'use client'

import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

/**
 * Form controls.
 *
 * The look lives in globals.css: the base layer styles the bare elements
 * (input, select, textarea, file, checkbox, radio) and `.btn` / `.chip` style
 * the rest. So a plain <select> someone forgot to wrap already matches, and
 * these components only add what CSS cannot know: which size, which variant,
 * a label around a checkbox.
 *
 * There are two sizes and no others. `md` is the standard 42px, for forms.
 * `sm` is the compact 36px, for toolbars and popovers. A height written as an
 * h-* class on a control is the bug this exists to stop.
 */

export type ControlSize = 'sm' | 'md'

// `size` is a native numeric attribute on input and select, so it has to be
// omitted before being redefined as a variant name.
type WithSize<T> = Omit<T, 'size'> & { size?: ControlSize }

const sizeAttr = (size: ControlSize) => (size === 'sm' ? 'sm' : undefined)

export const Input = forwardRef<HTMLInputElement, WithSize<React.ComponentProps<'input'>>>(
  ({ size = 'md', ...props }, ref) => <input ref={ref} data-size={sizeAttr(size)} {...props} />,
)
Input.displayName = 'Input'

export const Textarea = forwardRef<HTMLTextAreaElement, WithSize<React.ComponentProps<'textarea'>>>(
  ({ size = 'md', ...props }, ref) => <textarea ref={ref} data-size={sizeAttr(size)} {...props} />,
)
Textarea.displayName = 'Textarea'

/**
 * A native select. The chevron, right padding, ellipsis and option colours
 * are the base layer's, so there is no wrapper to size or to misplace a
 * chevron against.
 *
 * A select that can have nothing to offer should say so in its one option and
 * be disabled, rather than render as an empty box: see `emptyLabel`.
 */
export const Select = forwardRef<
  HTMLSelectElement,
  WithSize<React.ComponentProps<'select'>> & { emptyLabel?: string }
>(({ size = 'md', emptyLabel, children, disabled, ...props }, ref) => (
  <select ref={ref} data-size={sizeAttr(size)} disabled={disabled || Boolean(emptyLabel)} {...props}>
    {emptyLabel ? <option value="">{emptyLabel}</option> : children}
  </select>
))
Select.displayName = 'Select'

/** A checkbox with its label. The label is what makes the hit area 24px or more. */
export const Checkbox = forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<'input'>, 'type' | 'size'> & { label: React.ReactNode; labelClassName?: string }
>(({ label, labelClassName, ...props }, ref) => (
  <label className={cn('inline-flex min-h-6 items-center gap-2', labelClassName)}>
    <input ref={ref} type="checkbox" {...props} />
    <span className="text-fg-muted text-ui">{label}</span>
  </label>
))
Checkbox.displayName = 'Checkbox'

export const Radio = forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<'input'>, 'type' | 'size'> & { label: React.ReactNode; labelClassName?: string }
>(({ label, labelClassName, ...props }, ref) => (
  <label className={cn('inline-flex min-h-6 items-center gap-2', labelClassName)}>
    <input ref={ref} type="radio" {...props} />
    <span className="text-fg-muted text-ui">{label}</span>
  </label>
))
Radio.displayName = 'Radio'

export const buttonVariants = {
  // Flat fill. Brightening on hover, not fading: on the dark ground a faded
  // accent looks disabled.
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  quiet: 'btn-quiet',
  danger: 'btn-danger',
  dangerSolid: 'btn-danger-solid',
} as const

export type ButtonVariant = keyof typeof buttonVariants

/** The classes of a button, for the anchor or label that has to look like one. */
export const buttonClass = (variant: ButtonVariant = 'secondary', icon = false) =>
  cn('btn', buttonVariants[variant], icon && 'btn-icon')

export const Button = forwardRef<
  HTMLButtonElement,
  WithSize<React.ComponentProps<'button'>> & { variant?: ButtonVariant; icon?: boolean }
>(({ className, variant = 'secondary', size = 'md', icon = false, type = 'button', ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    data-size={sizeAttr(size)}
    className={cn(buttonClass(variant, icon), className)}
    {...props}
  />
))
Button.displayName = 'Button'

/** Label above a control, used down the task-detail sidebar and in forms. */
export const Field = ({
  label,
  hint,
  children,
  className,
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
  className?: string
}) => (
  <label className={cn('flex flex-col gap-1.5', className)}>
    <span className="text-fg-muted text-meta font-medium">{label}</span>
    {children}
    {hint ? <span className="text-fg-subtle text-meta">{hint}</span> : null}
  </label>
)

/**
 * The small input used inside popovers, pickers and rows: the compact size of
 * the same field. Kept as a name because seven places already import it.
 */
export const InlineInput = forwardRef<HTMLInputElement, Omit<React.ComponentProps<'input'>, 'size'>>(
  (props, ref) => <Input ref={ref} size="sm" {...props} />,
)
InlineInput.displayName = 'InlineInput'

/**
 * A picker's face with a native select over it, invisible. The platform opens
 * the list, so keyboard and touch behave as for any select; the face is a
 * compact box that shows the value with its icon. Pass the select as children.
 */
export const Chip = ({
  className,
  children,
  ...props
}: React.ComponentProps<'label'>) => (
  <label className={cn('chip', className)} {...props}>
    {children}
  </label>
)
