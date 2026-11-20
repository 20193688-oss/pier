/* A Stellar wallet as the app uses it (docs/STELLAR.md 7.1): an address, a label, and two kinds of
   signature, each on an envelope the page has already checked. Three kinds:

   - `pollar`: the person's wallet from Pollar (email or Google login; external wallets such as
     Freighter through Pollar's adapters). Pollar's own service or Turnkey holds the key.
   - `demo`: mock mode only; a key derived from a fixed seed, for the in-browser mock API.
   - `dev-key`: development builds only; one of the local dev stack's printed secret keys,
     signing in this tab.

   The page never asks a wallet to sign anything but a transaction the API built and
   src/lib/p2p/tx-verify.ts accepted, or a sign-in challenge src/lib/stellar/challenge.ts
   accepted. */
export type WalletKind = 'pollar' | 'demo' | 'dev-key';

export interface StellarWallet {
  kind: WalletKind;
  /* G... */
  address: string;
  label: string;
  /** The signed envelope (base64 XDR) of `xdr`, for `networkPassphrase`. */
  signTransaction(xdr: string, networkPassphrase: string): Promise<string>;
  /** The SEP-10 challenge `xdr`, signed. `domains` are this app's configured ones (never values
      read from the challenge). */
  signAuthChallenge(
    xdr: string,
    networkPassphrase: string,
    domains: { homeDomain: string; webAuthDomain: string },
  ): Promise<string>;
  logout(): Promise<void>;
  /* Opens the wallet provider's own recovery and export screen, when it has one. */
  openRecovery?: () => void;
}

/** A wallet's failure, by kind: the person said no, a co-signer must approve elsewhere, the
    wallet cannot do this, or something else went wrong. */
export class WalletError extends Error {
  readonly kind: 'rejected' | 'pending' | 'unsupported' | 'mismatch' | 'failed';
  constructor(kind: WalletError['kind'], message: string = kind) {
    super(message);
    this.name = 'WalletError';
    this.kind = kind;
  }
}
