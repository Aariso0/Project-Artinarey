import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { AnimatePresence, motion } from 'motion/react';
import { WarningCircle, X } from '@phosphor-icons/react';
import { useMotionEnabled, useMotionTransition } from './motion.ts';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  children, onClick, variant = 'secondary', disabled = false, busy = false,
  type = 'button', icon, className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  busy?: boolean;
  type?: 'button' | 'submit';
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <button
      type={type}
      className={`btn btn-${variant} ${className}`.trim()}
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <span className="btn-spinner" aria-hidden="true" /> : icon}
      <span>{children}</span>
    </button>
  );
}

export function IconButton({
  label, onClick, children, disabled = false, className = '',
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-btn ${className}`.trim()}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

export function Toggle({
  checked, onChange, label, disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  const transition = useMotionTransition('spring');
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="toggle"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <motion.span
        className="toggle-knob"
        layout
        transition={transition}
      />
    </button>
  );
}

export function TextField({
  id, label, value, onChange, placeholder, error, type = 'text', hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  error?: string | null;
  type?: string;
  hint?: string;
}) {
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <input
        id={id}
        type={type}
        className={`field-input${error ? ' field-input-error' : ''}`}
        value={value}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {error
        ? <span className="field-error" id={`${id}-error`}>{error}</span>
        : hint ? <span className="field-hint" id={`${id}-hint`}>{hint}</span> : null}
    </label>
  );
}

export function Select({
  id, label, value, options, onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <select
        id={id}
        className="field-input field-select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

export function Chip({ tone = 'neutral', children }: {
  tone?: 'neutral' | 'active' | 'offline' | 'warning' | 'success';
  children: ReactNode;
}) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export function ErrorBanner({ code, message, onDismiss }: {
  code: string;
  message: string;
  onDismiss?: () => void;
}) {
  return (
    <div className="banner banner-error" role="alert">
      <WarningCircle size={18} aria-hidden="true" />
      <span className="banner-body">
        <strong>{code}</strong>
        <span>{message}</span>
      </span>
      {onDismiss && <IconButton label="Dismiss error" onClick={onDismiss}><X size={16} /></IconButton>}
    </div>
  );
}

export function EmptyState({ title, message, children }: {
  title: string;
  message: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state" role="status">
      <p className="empty-title">{title}</p>
      <p className="empty-message">{message}</p>
      {children}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <span key={i} className="skeleton-row" />)}
    </div>
  );
}

export type TabItem = { value: string; label: string; content: ReactNode; badge?: number };

export function TabBar({ items, value, onValueChange, label }: {
  items: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  label: string;
}) {
  const transition = useMotionTransition('spring');
  const animated = useMotionEnabled();

  return (
    <Tabs.Root className="tabs" value={value} onValueChange={onValueChange}>
      <Tabs.List className="tabs-list" aria-label={label}>
        {items.map((item) => (
          <Tabs.Trigger key={item.value} value={item.value} className="tab">
            <span>{item.label}</span>
            {item.badge !== undefined && item.badge > 0 && (
              <span className="tab-badge">{item.badge}</span>
            )}
            {item.value === value && (
              animated
                ? <motion.span className="tab-indicator" layoutId="tab-indicator" transition={transition} />
                : <span className="tab-indicator" />
            )}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {items.map((item) => (
        <Tabs.Content key={item.value} value={item.value} className="tab-panel">
          {item.content}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}

export function Modal({
  open, onOpenChange, title, description, children, footer, tone = 'default',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  tone?: 'default' | 'warning';
}) {
  const transition = useMotionTransition('spring');

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="modal-scrim"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.14 }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount>
              <motion.div
                className={`modal modal-${tone}`}
                initial={{ opacity: 0, scale: 0.97, y: 6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98, y: 4 }}
                transition={transition}
                style={{ transformOrigin: 'center top' }}
              >
                <div className="modal-head">
                  <div>
                    <Dialog.Title className="modal-title">{title}</Dialog.Title>
                    {description && <Dialog.Description className="modal-description">{description}</Dialog.Description>}
                  </div>
                  <Dialog.Close asChild>
                    <IconButton label="Close dialog"><X size={18} /></IconButton>
                  </Dialog.Close>
                </div>
                {children && <div className="modal-body">{children}</div>}
                {footer && <div className="modal-footer">{footer}</div>}
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
