import { memo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';
import clsx from 'clsx';

interface ConfirmModalProps {
  isOpen: boolean;
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'default';
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Reusable confirmation modal with dark glass styling
 * Mobile: Bottom sheet / Desktop: Centered modal
 */
function ConfirmModalComponent({
  isOpen,
  title = 'Confirm',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  // ESC key to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const variantStyles = {
    danger: {
      icon: 'text-accent-danger',
      button: 'bg-accent-danger hover:bg-red-600',
    },
    warning: {
      icon: 'text-accent-secondary',
      button: 'bg-accent-secondary hover:bg-yellow-600 text-bg-body',
    },
    default: {
      icon: 'text-accent-primary',
      button: 'bg-accent-primary hover:bg-violet-500 text-bg-body',
    },
  };

  const styles = variantStyles[variant];

  return createPortal(
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-md z-50 flex items-end sm:items-center justify-center"
      onClick={onCancel}
    >
      {/* Mobile: Bottom sheet / Desktop: Centered modal */}
      <div
        className={clsx(
          'glass-card w-full max-w-sm overflow-hidden',
          'sm:mx-4 sm:rounded-xl',
          'rounded-t-2xl rounded-b-none sm:rounded-b-xl'
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border-subtle">
          <div className="flex items-center gap-3">
            <div className={clsx('p-2 rounded-lg bg-bg-subtle', styles.icon)}>
              <AlertTriangle className="w-5 h-5" />
            </div>
            <h3 className="text-base font-semibold text-text-primary">{title}</h3>
          </div>
          <button
            onClick={onCancel}
            className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-subtle transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4">
          <p className="text-sm text-text-secondary">{message}</p>
        </div>

        {/* Actions */}
        <div className="flex gap-3 p-4 pt-0">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium text-text-secondary bg-bg-subtle hover:bg-bg-elevated border border-border-subtle transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={clsx(
              'flex-1 px-4 py-2.5 rounded-lg text-sm font-medium text-text-primary transition-colors',
              styles.button
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export const ConfirmModal = memo(ConfirmModalComponent);
