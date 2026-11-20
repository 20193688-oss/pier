/* A wallet backed by a Stellar key in this tab: the dev-key wallet (development builds) and the
   demo wallet (mock mode). Signs only what the page passes after its checks. */
import { Keypair, TransactionBuilder, FeeBumpTransaction } from '@stellar/stellar-sdk/base';
import { WalletError, type StellarWallet, type WalletKind } from '@/lib/wallet/types';

export function keypairWallet(
  keypair: Keypair,
  kind: Exclude<WalletKind, 'pollar'>,
  label: string,
  onLogout: () => void = () => {},
): StellarWallet {
  const sign = async (xdr: string, passphrase: string) => {
    const tx = TransactionBuilder.fromXDR(xdr, passphrase);
    if (tx instanceof FeeBumpTransaction) throw new WalletError('unsupported');
    tx.sign(keypair);
    return tx.toXDR();
  };
  return {
    kind,
    address: keypair.publicKey(),
    label,
    signTransaction: sign,
    signAuthChallenge: (xdr, passphrase) => sign(xdr, passphrase),
    logout: async () => onLogout(),
  };
}
