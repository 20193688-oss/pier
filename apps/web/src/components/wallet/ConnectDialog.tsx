/* Sign in, as a dialog: the dashboard's and the hosted pages' way in (the payments app has its own
   welcome screen). */
import { Dialog } from '@/components/ui/Dialog';
import { useT } from '@/i18n';
import { SignIn } from '@/components/wallet/SignIn';
import type { Session } from '@/lib/api/types';

export function ConnectDialog({
  onClose,
  onSignedIn,
  variant = 'dashboard',
}: {
  onClose: () => void;
  onSignedIn?: (s: Session) => void;
  variant?: 'app' | 'dashboard';
}) {
  const t = useT();
  const w = t.common.wallet;
  return (
    <Dialog title={w.title} onClose={onClose}>
      <p className="mb-4 text-ink-2">{w.body}</p>
      <SignIn
        variant={variant}
        onSignedIn={(s) => {
          onSignedIn?.(s);
          onClose();
        }}
      />
    </Dialog>
  );
}
