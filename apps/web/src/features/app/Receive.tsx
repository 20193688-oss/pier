/* Receive: my QR, on a wallet card. By default a payment link (this app's /app/send?to=@handle...), which any phone
   camera opens; with the SEP-7 switch, a standard `web+stellar:pay` request for other Stellar
   wallets. An optional amount and note go in both. Copy and share (Web Share API). */
import { useMemo, useState } from 'react';
import { buildPaymentLink, buildSep7Pay } from '@midpoint/payment-qr';
import { fmt, useI18n } from '@/i18n';
import { Field, Notice, Switch } from '@/components/ui/controls';
import { CopyButton, CopyRow, Qr } from '@/components/ui/misc';
import { Icon } from '@/components/ui/Icon';
import { LogoGlyph } from '@/components/ui/Logo';
import { shortAddress } from '@/lib/format';
import { useSession } from '@/lib/session';
import { parseDecimal } from '@/lib/p2p/amounts';
import { useAppData } from '@/features/app/data';
import { Screen } from '@/features/app/shell';
import { ActivationCard } from '@/features/app/parts';

export default function Receive() {
  const { t } = useI18n();
  const r = t.app.receive;
  const { session } = useSession();
  const { profile, network, token, needsActivation } = useAppData();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [sep7, setSep7] = useState(false);
  const address = session?.address ?? '';
  const amountOk = !amount || parseDecimal(amount, 2) !== null;
  const noteOk = new TextEncoder().encode(note).length <= 28;

  const value = useMemo(() => {
    if (!address || !token || !network || !amountOk || !noteOk) return null;
    const a = amount && Number(amount) > 0 ? parseDecimal(amount, 2) : null;
    const n = note.trim() || null;
    try {
      return sep7
        ? buildSep7Pay({
            destination: address,
            amount: a,
            assetCode: token.code,
            assetIssuer: token.issuer,
            memo: n,
            networkPassphrase: network.networkPassphrase,
          })
        : buildPaymentLink(location.origin, {
            to: profile?.handle ? `@${profile.handle}` : address,
            amount: a,
            asset: token.symbol,
            note: n,
          });
    } catch {
      return null;
    }
  }, [address, token, network, amount, note, sep7, profile, amountOk, noteOk]);

  return (
    <Screen title={r.title}>
      <div className="flex flex-col gap-4 pb-4">
        <p className="text-ink-2">{fmt(r.body, { brand: t.common.brand })}</p>
        {needsActivation && (
          <>
            <Notice tone="warn">{r.inactive}</Notice>
            <ActivationCard />
          </>
        )}
        {/* The QR on a wallet card: the aura from ice to night, the handle at its foot. */}
        <div className="tone-dark aura-card grain flex flex-col items-center gap-4 overflow-hidden rounded-[24px] px-5 pt-4 pb-5 text-ink shadow-[var(--shadow-float)]">
          <div className="flex w-full items-center justify-between text-[#0a0b0e]">
            <span className="num text-[0.875rem] font-medium">{shortAddress(address)}</span>
            <LogoGlyph size={22} />
          </div>
          {value ? (
            <Qr value={value} label={r.qrLabel} size={224} />
          ) : (
            <div className="skeleton size-[224px]" />
          )}
          {profile?.handle ? (
            <b className="text-[1.375rem] font-semibold tracking-[-0.02em]">@{profile.handle}</b>
          ) : (
            <span className="text-[0.9375rem] text-ink-2">{network?.name}</span>
          )}
        </div>
        {value && (
          <div className="flex w-full gap-2">
            <CopyButton value={value} label={r.copyLink} className="btn-lg flex-1" />
            {typeof navigator.share === 'function' && (
              <button
                type="button"
                className="btn btn-ink btn-lg flex-1"
                onClick={() =>
                  void navigator
                    .share({ text: fmt(r.shareText, { brand: t.common.brand, link: value }) })
                    .catch(() => {})
                }
              >
                <Icon name="share" size={20} />
                {r.share}
              </button>
            )}
          </div>
        )}
        {!profile?.handle && <p className="text-[0.875rem] text-ink-3">{r.noHandle}</p>}
        <div className="grid grid-cols-2 gap-3">
          <Field
            label={r.amount}
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value.trim().replace(',', '.'))}
            error={amountOk ? null : t.app.send.badAmount}
          />
          <Field
            label={r.note}
            value={note}
            maxLength={28}
            onChange={(e) => setNote(e.target.value)}
            error={noteOk ? null : t.app.send.noteTooLong}
          />
        </div>
        <div className="sheet flex items-center justify-between gap-4 px-4 py-3">
          <span className="flex flex-col">
            <b className="font-semibold">{r.sep7}</b>
            <span className="text-[0.875rem] text-ink-3">{r.sep7Hint}</span>
          </span>
          <Switch label={r.sep7} checked={sep7} onChange={setSep7} />
        </div>
        <div className="sheet divide-y divide-line px-4">
          {value && !sep7 && <CopyRow label={r.link} value={value} />}
          <CopyRow label={r.address} value={address} />
        </div>
      </div>
    </Screen>
  );
}
