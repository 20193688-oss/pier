/* Pollar (https://docs.pollar.xyz): the wallet provider behind the app's own sign-in screens.
   Loaded as its own chunk, and only when VITE_POLLAR_PUBLISHABLE_KEY is set (src/app/App.tsx).

   - The provider sits beside the app, not around it: nothing waits for it, and its own modals
     (signature confirmations, co-signer approvals, recovery) render as overlays.
   - Its network follows the market tier: testnet for test, mainnet for live.
   - Login: email code or Google (Pollar's hosted flow); external wallets (Freighter, Albedo)
     through the adapters @pollar/core registers by itself.
   - Transactions: `signTx(xdr, { skipSponsorship: true })`: our API pays fees and reserves, not
     Pollar. Sign-in challenges: `stellar.sep10.sign`.
   - A passkey smart wallet (a C address) cannot sign SEP-10 or classic transactions: it is
     reported as unsupported, never used. */
import '@pollar/react/styles.css';
import { useEffect, useMemo } from 'react';
import { PollarProvider, usePollar } from '@pollar/react';
import type { AuthState, PollarClient } from '@pollar/core';
import { PASSPHRASES } from '@/lib/stellar/network';
import { publishPollar, type ExternalWalletId } from '@/lib/wallet/pollar-store';
import { WalletError, type StellarWallet } from '@/lib/wallet/types';

type Network = 'testnet' | 'mainnet';

/** Resolves once Pollar's login reaches a state `done` accepts; an error state rejects. */
function waitFor(
  client: PollarClient,
  done: (s: AuthState) => boolean,
  timeoutMs = 180_000,
): Promise<AuthState> {
  return new Promise((resolve, reject) => {
    let off: () => void = () => {};
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      off();
      reject(new WalletError('failed', 'timeout'));
    }, timeoutMs);
    const check = (s: AuthState) => {
      if (settled) return;
      if (s.step === 'error') {
        settled = true;
        clearTimeout(timer);
        off();
        reject(
          new WalletError(
            /CODE_(INVALID|EXPIRED)/.test(s.errorCode) ? 'rejected' : 'failed',
            s.errorCode,
          ),
        );
      } else if (done(s)) {
        settled = true;
        clearTimeout(timer);
        off();
        resolve(s);
      }
    };
    off = client.onAuthStateChange(check);
  });
}

function pollarWallet(
  client: PollarClient,
  address: string,
  label: string,
  network: Network,
  logout: () => void,
  openRecovery: (() => void) | undefined,
): StellarWallet {
  const passphrase = PASSPHRASES[network];
  const sameNetwork = (p: string) => {
    if (p !== passphrase) throw new WalletError('unsupported', 'network');
  };
  return {
    kind: 'pollar',
    address,
    label,
    async signTransaction(xdr, networkPassphrase) {
      sameNetwork(networkPassphrase);
      const r = await client.signTx(xdr, { skipSponsorship: true });
      if (r.status === 'signed') return r.signedXdr;
      if (r.status === 'cosign_pending') throw new WalletError('pending');
      throw new WalletError(
        /reject|denied|cancel/i.test(`${r.code ?? ''} ${r.details ?? ''}`) ? 'rejected' : 'failed',
        r.code,
      );
    },
    async signAuthChallenge(xdr, networkPassphrase, domains) {
      sameNetwork(networkPassphrase);
      const r = await client.stellar.sep10.sign({
        challengeXdr: xdr,
        ...(domains ? { homeDomains: domains.homeDomain } : {}),
        ...(domains?.webAuthDomain ? { webAuthDomain: domains.webAuthDomain } : {}),
      });
      if (r.status === 'signed') return r.signedXdr;
      throw new WalletError('failed', r.code);
    },
    logout: async () => logout(),
    openRecovery,
  };
}

function Controller({ network }: { network: Network }) {
  const p = usePollar();
  const client = p.getClient();
  const info = p.isAuthenticated && p.verified ? p.wallet : null;
  const unsupported = !!info && info.custody === 'smart';
  const { logout, openRecoveryModal, recovery, configStatus } = p;
  const address = info?.address ?? null;
  const label = info
    ? info.custody === 'external'
      ? String(info.provider ?? 'wallet')
      : 'Pollar'
    : '';
  const wallet = useMemo(
    () =>
      address && !unsupported
        ? pollarWallet(
            client,
            address,
            label,
            network,
            logout,
            recovery ? openRecoveryModal : undefined,
          )
        : null,
    [client, address, label, unsupported, network, logout, recovery, openRecoveryModal],
  );

  useEffect(() => {
    publishPollar({
      ready: configStatus === 'ready',
      wallet,
      unsupported,
      async sendEmailCode(email) {
        const started = waitFor(client, (s) => s.step === 'entering_email');
        client.beginEmailLogin();
        await started;
        const sent = waitFor(client, (s) => s.step === 'entering_code');
        client.sendEmailCode(email);
        await sent;
      },
      async verifyEmailCode(code) {
        const done = waitFor(client, (s) => s.step === 'authenticated');
        client.verifyEmailCode(code);
        await done;
      },
      async google() {
        const done = waitFor(client, (s) => s.step === 'authenticated');
        client.login({ provider: 'google' });
        await done;
      },
      async external(id: ExternalWalletId) {
        const done = waitFor(client, (s) => s.step === 'authenticated');
        client.login({ provider: id });
        await done;
      },
      cancel: () => client.cancelLogin(),
      logout: async () => logout(),
    });
  }, [client, wallet, unsupported, configStatus, logout]);
  useEffect(() => () => publishPollar(null), []);
  return null;
}

export default function PollarRoot({ apiKey, network }: { apiKey: string; network: Network }) {
  return (
    <PollarProvider client={{ apiKey, stellarNetwork: network }}>
      <Controller network={network} />
    </PollarProvider>
  );
}
