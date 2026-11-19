/* A modal on the native <dialog> (focus kept inside, Escape closes, the page behind inert). On a
   phone it rises from the bottom as a sheet; from 640px up it is centred. */
import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { useT } from '@/i18n';

export function Dialog({
  title,
  onClose,
  children,
  wide = false,
  footer,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  footer?: ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    const onCancel = (e: Event) => {
      e.preventDefault();
      close.current();
    };
    d.addEventListener('cancel', onCancel);
    return () => d.removeEventListener('cancel', onCancel);
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      onClick={(e) => {
        if (e.target === ref.current) close.current();
      }}
      className={`fixed m-0 mt-auto w-full max-w-none rounded-t-[22px] border border-line bg-sheet p-0 text-ink backdrop:bg-[rgb(8_18_15/0.55)] sm:m-auto sm:rounded-[22px] ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'}`}
    >
      <div className="flex max-h-[88dvh] flex-col">
        <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
          <h2 id="dialog-title" className="text-[1.25rem]">
            {title}
          </h2>
          <button
            type="button"
            className="btn btn-quiet btn-sm -mr-2 -mt-1 px-2"
            onClick={() => close.current()}
            aria-label={t.common.actions.close}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 pb-5">{children}</div>
        {footer && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-4">
            {footer}
          </div>
        )}
      </div>
    </dialog>
  );
}

/** "Are you sure?" with the action named on its button. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-line" onClick={onClose}>
            {t.common.actions.back}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-bad' : 'btn-ink'}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-ink-2">{body}</div>
    </Dialog>
  );
}
