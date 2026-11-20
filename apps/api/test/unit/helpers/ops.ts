import {
  Account,
  Address,
  Keypair,
  Networks,
  TransactionBuilder,
  scValToNative,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk';

/** A transaction carrying `op`, parsed back: what a wallet would decode. */
export function parsed(op: xdr.Operation): Transaction['operations'][number] {
  const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(300)
    .build();
  return TransactionBuilder.fromXDR(tx.toXDR(), Networks.TESTNET)
    .operations[0] as Transaction['operations'][number];
}

/** What an `invokeContract` operation calls, with its arguments as JS values. */
export function call(op: xdr.Operation): { contract: string; fn: string; args: unknown[] } {
  const o = parsed(op);
  if (o.type !== 'invokeHostFunction' || o.func.type !== 'hostFunctionTypeInvokeContract') {
    throw new Error(`not a contract call: ${o.type}`);
  }
  const c = o.func.invokeContract;
  return {
    contract: Address.fromScAddress(c.contractAddress).toString(),
    fn: String(c.functionName),
    args: c.args.map((a) => scValToNative(a) as unknown),
  };
}
