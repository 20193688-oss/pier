/* What a wallet hands back is checked too: the same transaction the page checked (its hash under
   the network's passphrase) with at least one signature more. A wallet (or a compromised
   provider) that returns another transaction is refused before anything is submitted. Pure;
   tests/unit/wallet.test.ts. */
import { FeeBumpTransaction, TransactionBuilder } from '@stellar/stellar-sdk/base';
import { toHex } from '@/lib/p2p/order-ref';
import { WalletError } from '@/lib/wallet/types';

export function assertSameTransaction(unsigned: string, signed: string, passphrase: string): void {
  let a, b;
  try {
    a = TransactionBuilder.fromXDR(unsigned, passphrase);
    b = TransactionBuilder.fromXDR(signed, passphrase);
  } catch {
    throw new WalletError('mismatch');
  }
  if (b instanceof FeeBumpTransaction || a instanceof FeeBumpTransaction)
    throw new WalletError('mismatch');
  if (toHex(a.hash()) !== toHex(b.hash()) || b.signatures.length <= a.signatures.length)
    throw new WalletError('mismatch');
}
