import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { NETWORK_IDS } from '@/chain/networks';

/** An unsigned, prepared Stellar transaction this service built for a wallet to sign. */
@ApiSchema({
  name: 'P2pTransaction',
  description:
    'An unsigned Stellar transaction for a wallet (or a bot holding its own key) to sign: one operation, the wallet as source, time bounds at most 5 minutes ahead, already prepared (simulation, resource fee, footprint). Sign the envelope as it is and submit it with `POST /v1/app/submit` or `POST /v1/p2p/submit` (the sponsor pays the fee), or submit it yourself. This service never signs it.',
})
export class TransactionView {
  @ApiProperty({ enum: NETWORK_IDS, example: 'testnet', description: 'The network it is for.' })
  network!: string;

  @ApiProperty({
    example: 'release',
    description:
      'What it does: a market function (`deposit`, `open_with_deposit`, `release`...), `transfer` (a token payment) or `activate`.',
  })
  action!: string;

  @ApiProperty({
    example: 'Release order 7: pays its buyer 98.5 USDC',
    description: 'What signing it does, in one line, for a confirmation screen.',
  })
  description!: string;

  @ApiProperty({
    example: 'AAAAAgAAAAA...',
    description: 'The unsigned, prepared `TransactionEnvelope`, base64 XDR.',
  })
  xdr!: string;

  @ApiProperty({
    example: '6b1f8c3e2d7a4b5c9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f',
    description: 'The hex hash of the transaction (the inner one when it is fee-bumped).',
  })
  hash!: string;

  @ApiProperty({
    example: '2026-11-19T12:05:00.000Z',
    description: 'Its upper time bound: sign and submit it before then.',
  })
  expiresAt!: Date;
}
