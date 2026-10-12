import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const EXIT_MS = 150;

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Extra classes for the panel (width, max height...). */
  className?: string;
  padded?: boolean;
  label?: string;
  /** Bottom sheet on narrow screens; keeps the same focus and dismissal contract. */
  mobileSheet?: boolean;
}

/**
 * Overlay + glass panel with CSS enter/exit transitions.
 * Stays mounted for EXIT_MS after `open` turns false so the exit animation plays.
 */
export function Modal({ open, onClose, children, className, padded = true, label, mobileSheet = false }: ModalProps) {
  // Selecting text inside the panel and releasing outside it used to close the
  // modal: the click lands on the overlay. Only a press that *starts* on the
  // overlay counts.
  const pressedOnOverlay = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || !dialog.current) return;
    const panel = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, iframe, [tabindex="0"]')).filter(node => node.getClientRects().length > 0);
    if (!panel.contains(document.activeElement)) (focusable()[0] ?? panel).focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first) { event.preventDefault(); panel.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    panel.addEventListener('keydown', trap);
    return () => { panel.removeEventListener('keydown', trap); if (previous?.isConnected) previous.focus(); };
  }, [open]);
  // "Adjust state when a prop changes" pattern: detect the open -> closed edge during render.
  const [prevOpen, setPrevOpen] = useState(open);
  const [exiting, setExiting] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) setExiting(true);
  }

  useEffect(() => {
    if (!exiting) return;
    const t = setTimeout(() => setExiting(false), EXIT_MS);
    return () => clearTimeout(t);
  }, [exiting]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const modals = document.querySelectorAll('[role="dialog"]');
      if (e.key === 'Escape' && modals[modals.length - 1] === dialog.current) {
        e.preventDefault();
        e.stopImmediatePropagation(); // Escape closes this preview, not its parent coach.
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open && !exiting) return null;
  const closing = !open;

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 bg-void/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4',
        mobileSheet && 'mobile-sheet',
        closing ? 'animate-fade-out' : 'animate-fade-in'
      )}
      onMouseDown={(e) => {
        pressedOnOverlay.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (pressedOnOverlay.current && e.target === e.currentTarget) onClose();
        pressedOnOverlay.current = false;
      }}
    >
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={cn(
          'glass-panel w-full',
          padded && 'p-6',
          closing ? 'animate-scale-out' : 'animate-scale-in',
          className
        )}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

interface ModalHeaderProps {
  title: ReactNode;
  icon?: ReactNode;
  /** Tailwind text color class for the title (default text-neon-cyan). */
  tone?: string;
  onClose?: () => void;
  className?: string;
}

export function ModalHeader({ title, icon, tone = 'text-neon-cyan', onClose, className }: ModalHeaderProps) {
  return (
    <div className={cn('flex items-center justify-between mb-6', className)}>
      <div className={cn('flex items-center gap-2', tone)}>
        {icon}
        <h3 className="text-lg font-sans">{title}</h3>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Fermer"
          className="p-1 hover:bg-text-muted/20 rounded transition-colors"
        >
          <X className="w-5 h-5 text-text-muted" />
        </button>
      )}
    </div>
  );
}
