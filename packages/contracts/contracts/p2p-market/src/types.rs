use soroban_sdk::{contracttype, Address, BytesN};

/// Where an order stands. Stored and emitted as its `u32` value.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Status {
    /// No such order.
    None = 0,
    /// Waiting for the buyer to accept and lock its bond.
    Offered = 1,
    /// The buyer may send the local money.
    Active = 2,
    /// The buyer said it sent the money.
    Paid = 3,
    /// Waiting for the arbiter.
    Disputed = 4,
    /// The buyer was paid.
    Released = 5,
    /// The seller got its tokens back.
    Cancelled = 6,
    /// The arbiter split it.
    Resolved = 7,
}

/// What `open` and `open_with_deposit` take.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenParams {
    /// The opener's own reference, unique per opener (the API's order ref). Never all zeros.
    pub ref_id: BytesN<32>,
    /// Whose tokens the order locks; receives the local money.
    pub seller: Address,
    /// Sends the local money; receives the tokens.
    pub buyer: Address,
    /// An allowed Stellar Asset Contract.
    pub token: Address,
    /// Base units locked from the seller.
    pub amount: i128,
    /// Locked from the buyer's balance when it accepts; 0 = no acceptance step.
    pub bond: i128,
    /// Seconds the buyer has to accept. Must be 0 when there is no bond.
    pub accept_window: u32,
    /// Seconds the buyer has to send the money and mark the order paid.
    pub payment_window: u32,
    /// 0, or seconds after "paid" with no dispute after which anyone may settle.
    pub settle_window: u32,
    /// Receives `integrator_fee_bps` of every payment to the buyer; None = no integrator fee.
    pub integrator: Option<Address>,
    /// 0 exactly when `integrator` is None; at most 500.
    pub integrator_fee_bps: u32,
}

/// An order. Times are ledger timestamps in seconds.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Order {
    pub seller: Address,
    pub buyer: Address,
    pub token: Address,
    /// Who opened it: the seller, an operator, or a matcher.
    pub opener: Address,
    pub integrator: Option<Address>,
    pub amount: i128,
    pub bond: i128,
    pub status: Status,
    /// The amount came from the seller's market balance (`open`), not its wallet.
    pub from_balance: bool,
    /// Opened by a matcher, which may then act for the buyer.
    pub via_matcher: bool,
    /// The protocol fee when it was opened.
    pub fee_bps: u32,
    pub integrator_fee_bps: u32,
    /// 0 when there is no bond.
    pub accept_deadline: u64,
    /// 0 until the order is Active.
    pub payment_deadline: u64,
    /// 0 until the order is Paid.
    pub paid_at: u64,
    pub payment_window: u32,
    pub settle_window: u32,
    pub ref_id: BytesN<32>,
}

/// What a seller lets a matcher do. `max_per_order` 0 = no matcher.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatcherTerms {
    pub max_per_order: i128,
    /// The matcher may give the orders it opens a settle window.
    pub auto_settle: bool,
}

/// The market's configuration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub owner: Address,
    /// Set by `transfer_ownership` until `accept_ownership`.
    pub pending_owner: Option<Address>,
    pub treasury: Address,
    pub arbiter: Address,
    /// Applies to orders opened from now on.
    pub protocol_fee_bps: u32,
    /// Stops deposits, new orders and acceptances; never money out.
    pub paused: bool,
}

/// Storage keys. Instance storage: `Config`, `NextId`, `Token`. Persistent
/// storage: everything else.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// Config.
    Config,
    /// u64, the id the next order gets (ids start at 1).
    NextId,
    /// bool, present (true) when the token is allowed.
    Token(Address),
    /// Order, by id.
    Order(u64),
    /// u64, the order id an (opener, ref_id) opened.
    Ref(Address, BytesN<32>),
    /// i128, an (account, token) free balance; absent = 0.
    Balance(Address, Address),
    /// u32, the permission bits an (account, operator) holds; absent = 0.
    Permissions(Address, Address),
    /// MatcherTerms, by (seller, matcher); absent = none.
    Matcher(Address, Address),
}
