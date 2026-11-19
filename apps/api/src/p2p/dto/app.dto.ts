import { ApiProperty, ApiSchema, OmitType } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { CreateOrderDto, CreateQuoteDto } from '@/p2p/dto/order.dto';

/** The public app's quote: the trade, with no integrator fields (the app sets its own). */
@ApiSchema({ name: 'AppQuote', description: 'A trade the signed-in wallet wants to make.' })
export class AppQuoteDto extends OmitType(CreateQuoteDto, [
  'integratorFeeBps',
  'integratorAccountId',
] as const) {}

/**
 * The public app's order from its quote. The wallet is always the signed-in
 * one: a purchase delivers to it, a sale is signed by it.
 */
@ApiSchema({
  name: 'AppOrder',
  description:
    'An order from your quote. A purchase (BUY) needs `payer`; a sale (SELL) needs `beneficiary`.',
})
export class AppOrderDto extends OmitType(CreateOrderDto, [
  'recipient',
  'seller',
  'kind',
] as const) {}

export const APP_TRANSACTION_ACTIONS = [
  'accept',
  'markPaid',
  'release',
  'cancel',
  'dispute',
] as const;

@ApiSchema({
  name: 'AppTransaction',
  description: 'An action your own wallet signs on your order.',
})
export class AppTransactionDto {
  @ApiProperty({
    enum: APP_TRANSACTION_ACTIONS,
    example: 'release',
    description:
      'Usually `release` (a sale you were paid for), `dispute` or `cancel`; refused when your wallet may not do it now.',
  })
  @IsIn(APP_TRANSACTION_ACTIONS)
  action!: (typeof APP_TRANSACTION_ACTIONS)[number];
}
