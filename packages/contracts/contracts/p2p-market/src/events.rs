//! One event per event of the EVM contract. The first topic is the struct
//! name in snake_case; the fields that were `indexed` are topics; the rest is
//! a data map. Events with an `Option` field publish every field
//! (`sparse = false`), so a `None` reads as void instead of a missing key.

use soroban_sdk::{contractevent, Address, BytesN};

use crate::types::Status;

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    #[topic]
    pub account: Address,
    #[topic]
    pub token: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    #[topic]
    pub account: Address,
    #[topic]
    pub token: Address,
    pub amount: i128,
}

/// A payment the token refused (or a refund, a bond, a resolution share) was
/// added to `account`'s market balance instead.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Credited {
    #[topic]
    pub account: Address,
    #[topic]
    pub token: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperatorSet {
    #[topic]
    pub account: Address,
    #[topic]
    pub operator: Address,
    pub permissions: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatcherSet {
    #[topic]
    pub seller: Address,
    #[topic]
    pub matcher: Address,
    pub max_per_order: i128,
    pub auto_settle: bool,
}

/// Every field of the new order except `paid_at` (always 0 here).
#[contractevent(sparse = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderOpened {
    #[topic]
    pub id: u64,
    pub seller: Address,
    pub buyer: Address,
    pub token: Address,
    pub opener: Address,
    pub integrator: Option<Address>,
    pub amount: i128,
    pub bond: i128,
    pub status: Status,
    pub from_balance: bool,
    pub via_matcher: bool,
    pub fee_bps: u32,
    pub integrator_fee_bps: u32,
    pub accept_deadline: u64,
    pub payment_deadline: u64,
    pub payment_window: u32,
    pub settle_window: u32,
    pub ref_id: BytesN<32>,
}

/// The order became Active (at open when it has no bond, else on `accept`).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderAccepted {
    #[topic]
    pub id: u64,
    pub payment_deadline: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderPaid {
    #[topic]
    pub id: u64,
    pub by: Address,
}

/// `by` is None when the release came from `settle`.
#[contractevent(sparse = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderReleased {
    #[topic]
    pub id: u64,
    pub by: Option<Address>,
    pub to_buyer: i128,
    pub protocol_fee: i128,
    pub integrator_fee: i128,
}

/// `by` is None when a passed deadline alone allowed the cancellation.
#[contractevent(sparse = false)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderCancelled {
    #[topic]
    pub id: u64,
    pub by: Option<Address>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderDisputed {
    #[topic]
    pub id: u64,
    pub by: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderResolved {
    #[topic]
    pub id: u64,
    pub to_buyer: i128,
    pub to_seller: i128,
    pub bond_to_seller: i128,
    pub protocol_fee: i128,
    pub integrator_fee: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolFeeSet {
    pub bps: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TreasurySet {
    pub treasury: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArbiterSet {
    pub arbiter: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenSet {
    #[topic]
    pub token: Address,
    pub allowed: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PausedSet {
    pub paused: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnershipTransferStarted {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
}

/// `from` is None at construction (the EVM contract's zero address).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnershipTransferred {
    #[topic]
    pub from: Option<Address>,
    #[topic]
    pub to: Address,
}
