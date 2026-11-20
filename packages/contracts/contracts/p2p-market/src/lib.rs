//! # P2PMarket
//!
//! Peer-to-peer trades of a Stellar asset against a local-money transfer (a
//! bank transfer, PIX, a CVU alias...) that happens off-chain. A port of the
//! EVM `P2PMarket.sol` with the same rules.
//!
//! Every trade is one order between a SELLER, whose tokens the order locks and
//! who receives the local money, and a BUYER, who sends the local money and
//! receives the tokens. The contract never learns whether the local money
//! arrived: the party that receives it says so. So:
//!
//! - only the seller (or a bot it delegated) RELEASES the tokens to the buyer;
//! - the buyer MARKS the order paid once it sent the money, and from then on
//!   the seller can no longer take the tokens back on its own;
//! - a disagreement is DISPUTED and the ARBITER splits the order, paying only
//!   the order's own buyer and seller;
//! - an order nobody acted on in time can be CANCELLED by anyone, which always
//!   returns the tokens to the seller.
//!
//! An order may also carry a SETTLE window, which turns silence into consent:
//! once the buyer marked it paid and the window passed with no dispute, anyone
//! may release it. Only the seller can agree to that (it opens the order
//! itself, or authorised the matcher for it), because it is the seller's money.
//!
//! An order may require a BOND from the buyer, locked from the buyer's balance
//! when it accepts the order. The bond goes back to the buyer when the order
//! ends, except the part an arbiter's resolution gives the seller.
//!
//! Balances. Anyone may deposit an allowed token and hold it here as a free
//! balance. Only the owner of a balance, or an operator it gave the WITHDRAW
//! permission, moves it out, and always to the owner's own address.
//!
//! Who may open an order on a seller's balance:
//! - the seller;
//! - an operator the seller gave the OPEN permission;
//! - a MATCHER the seller authorised, up to a per-order maximum and with no
//!   settle window unless the seller allowed one. A matcher-opened order lets
//!   the matcher act for the buyer (mark paid, cancel before it is paid,
//!   dispute), so a buyer without fees can trade through the matching service.
//!
//! Anyone may instead open an order that locks tokens it sends in the same call
//! (`open_with_deposit`), as its own seller.
//!
//! Fees. On every payment to a buyer the contract takes the protocol fee and
//! the integrator fee recorded on the order when it was opened, both out of the
//! tokens the buyer receives. Nothing is taken from refunds to the seller.
//!
//! The owner sets the protocol fee (capped), the treasury, the arbiter and the
//! allowed tokens, and may pause new deposits, orders and acceptances. It can
//! never move a balance or an order's tokens, a pause never blocks money from
//! leaving, and the contract is not upgradeable.
//!
//! A payment that cannot be pushed to its recipient (no trustline, a frozen or
//! deauthorized holder) is credited to the recipient's balance instead, so one
//! recipient can never freeze an order.
//!
//! Soroban specifics: the acting address is an explicit argument that must
//! authorize the call; tokens are Stellar Asset Contracts pulled with
//! `transfer` under the payer's authorization (no allowance), with a
//! balance-difference check; re-entry is forbidden by the host. Storage and
//! TTL policy: see [`storage`].
#![no_std]

mod errors;
mod events;
pub mod storage;
mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, panic_with_error, token, Address, BytesN, Env};

pub use crate::errors::Error;
pub use crate::events::*;
pub use crate::types::{Config, DataKey, MatcherTerms, OpenParams, Order, Status};

// --- constants (the EVM contract's values) --------------------------------------

pub const MAX_PROTOCOL_FEE_BPS: u32 = 300;
pub const MAX_INTEGRATOR_FEE_BPS: u32 = 500;
pub const MIN_PAYMENT_WINDOW: u32 = 5 * 60;
pub const MAX_PAYMENT_WINDOW: u32 = 2 * 24 * 60 * 60;
pub const MIN_ACCEPT_WINDOW: u32 = 60;
pub const MAX_ACCEPT_WINDOW: u32 = 24 * 60 * 60;
pub const MIN_SETTLE_WINDOW: u32 = 60 * 60;
pub const MAX_SETTLE_WINDOW: u32 = 14 * 24 * 60 * 60;

/// Open orders on the account's balance.
pub const PERM_OPEN: u32 = 1;
/// Release the account's orders (pays their buyer).
pub const PERM_RELEASE: u32 = 2;
/// Accept, mark paid, cancel and dispute for the account.
pub const PERM_TRADE: u32 = 4;
/// Withdraw the account's balance to the account.
pub const PERM_WITHDRAW: u32 = 8;
pub const PERM_ALL: u32 = 15;

/// Basis points in one whole.
pub const BPS: i128 = 10_000;

#[contract]
pub struct P2PMarket;

#[contractimpl]
impl P2PMarket {
    // --- construction and administration ----------------------------------------

    /// Sets the owner, treasury, arbiter and protocol fee (at most 300 bps).
    pub fn __constructor(
        env: Env,
        owner: Address,
        treasury: Address,
        arbiter: Address,
        protocol_fee_bps: u32,
    ) {
        if protocol_fee_bps > MAX_PROTOCOL_FEE_BPS {
            panic_with_error!(&env, Error::FeeTooHigh);
        }
        storage::set_config(
            &env,
            &Config {
                owner: owner.clone(),
                pending_owner: None,
                treasury: treasury.clone(),
                arbiter: arbiter.clone(),
                protocol_fee_bps,
                paused: false,
            },
        );
        storage::set_next_id(&env, 1);
        storage::extend_instance(&env);
        OwnershipTransferred {
            from: None,
            to: owner,
        }
        .publish(&env);
        TreasurySet { treasury }.publish(&env);
        ArbiterSet { arbiter }.publish(&env);
        ProtocolFeeSet {
            bps: protocol_fee_bps,
        }
        .publish(&env);
    }

    /// Owner. Applies to orders opened from now on; open orders keep theirs.
    pub fn set_protocol_fee(env: Env, bps: u32) {
        let mut config = owner_call(&env);
        if bps > MAX_PROTOCOL_FEE_BPS {
            panic_with_error!(&env, Error::FeeTooHigh);
        }
        config.protocol_fee_bps = bps;
        storage::set_config(&env, &config);
        ProtocolFeeSet { bps }.publish(&env);
    }

    /// Owner.
    pub fn set_treasury(env: Env, treasury: Address) {
        let mut config = owner_call(&env);
        config.treasury = treasury.clone();
        storage::set_config(&env, &config);
        TreasurySet { treasury }.publish(&env);
    }

    /// Owner.
    pub fn set_arbiter(env: Env, arbiter: Address) {
        let mut config = owner_call(&env);
        config.arbiter = arbiter.clone();
        storage::set_config(&env, &config);
        ArbiterSet { arbiter }.publish(&env);
    }

    /// Owner. A disallowed token can still be withdrawn, released, cancelled and resolved.
    pub fn set_token(env: Env, token: Address, allowed: bool) {
        owner_call(&env);
        storage::set_token_allowed(&env, &token, allowed);
        TokenSet { token, allowed }.publish(&env);
    }

    /// Owner. Stops deposits, new orders and acceptances; never stops money from leaving.
    pub fn set_paused(env: Env, paused: bool) {
        let mut config = owner_call(&env);
        config.paused = paused;
        storage::set_config(&env, &config);
        PausedSet { paused }.publish(&env);
    }

    /// Owner. `to` becomes owner once it calls `accept_ownership`.
    pub fn transfer_ownership(env: Env, to: Address) {
        let mut config = owner_call(&env);
        config.pending_owner = Some(to.clone());
        storage::set_config(&env, &config);
        OwnershipTransferStarted {
            from: config.owner,
            to,
        }
        .publish(&env);
    }

    /// The pending owner takes over.
    pub fn accept_ownership(env: Env) {
        storage::extend_instance(&env);
        let mut config = storage::config(&env);
        let Some(pending) = config.pending_owner.clone() else {
            panic_with_error!(&env, Error::NotPendingOwner);
        };
        pending.require_auth();
        let from = config.owner;
        config.owner = pending.clone();
        config.pending_owner = None;
        storage::set_config(&env, &config);
        OwnershipTransferred {
            from: Some(from),
            to: pending,
        }
        .publish(&env);
    }

    // --- balances, operators and matchers ----------------------------------------

    /// Pulls `amount` of an allowed token from `account` into its market balance.
    pub fn deposit(env: Env, account: Address, token: Address, amount: i128) {
        account.require_auth();
        storage::extend_instance(&env);
        when_not_paused(&env);
        if !storage::token_allowed(&env, &token) {
            panic_with_error!(&env, Error::TokenNotAllowed);
        }
        positive(&env, amount);
        pull(&env, &token, &account, amount);
        let total = storage::balance(&env, &account, &token) + amount;
        storage::set_balance(&env, &account, &token, total);
        Deposited {
            account,
            token,
            amount,
        }
        .publish(&env);
    }

    /// Withdraws `account`'s balance to `account`.
    pub fn withdraw(env: Env, account: Address, token: Address, amount: i128) {
        account.require_auth();
        storage::extend_instance(&env);
        withdraw_to_owner(&env, &account, &token, amount);
    }

    /// An operator with PERM_WITHDRAW withdraws `account`'s balance to `account`.
    pub fn withdraw_for(
        env: Env,
        operator: Address,
        account: Address,
        token: Address,
        amount: i128,
    ) {
        operator.require_auth();
        storage::extend_instance(&env);
        if !can(&env, &account, &operator, PERM_WITHDRAW) {
            panic_with_error!(&env, Error::NotAuthorized);
        }
        withdraw_to_owner(&env, &account, &token, amount);
    }

    /// Grants `operator` the permission bits in `perms` over `account`; 0 revokes.
    pub fn set_operator(env: Env, account: Address, operator: Address, perms: u32) {
        account.require_auth();
        storage::extend_instance(&env);
        if operator == account {
            panic_with_error!(&env, Error::SameParty);
        }
        if perms & !PERM_ALL != 0 {
            panic_with_error!(&env, Error::InvalidPermissions);
        }
        storage::set_permissions(&env, &account, &operator, perms);
        OperatorSet {
            account,
            operator,
            permissions: perms,
        }
        .publish(&env);
    }

    /// Lets `matcher` open orders on `seller`'s balance, each at most
    /// `max_per_order`; 0 revokes. `auto_settle` also lets it give those orders
    /// a settle window. Revoking never touches open orders.
    pub fn set_matcher(
        env: Env,
        seller: Address,
        matcher: Address,
        max_per_order: i128,
        auto_settle: bool,
    ) {
        seller.require_auth();
        storage::extend_instance(&env);
        if matcher == seller {
            panic_with_error!(&env, Error::SameParty);
        }
        if max_per_order < 0 {
            panic_with_error!(&env, Error::NegativeAmount);
        }
        let terms = MatcherTerms {
            max_per_order,
            auto_settle: max_per_order != 0 && auto_settle,
        };
        storage::set_matcher(&env, &seller, &matcher, &terms);
        MatcherSet {
            seller,
            matcher,
            max_per_order,
            auto_settle: terms.auto_settle,
        }
        .publish(&env);
    }

    // --- opening orders ------------------------------------------------------------

    /// Opens an order that locks `p.amount` of the seller's balance. `caller`
    /// is the seller, an operator with PERM_OPEN, or a matcher within its cap.
    pub fn open(env: Env, caller: Address, p: OpenParams) -> u64 {
        caller.require_auth();
        storage::extend_instance(&env);
        let config = storage::config(&env);
        if config.paused {
            panic_with_error!(&env, Error::IsPaused);
        }
        validate(&env, &p, &caller);
        let via_matcher = if caller == p.seller
            || storage::permissions(&env, &p.seller, &caller) & PERM_OPEN != 0
        {
            false
        } else {
            let terms = storage::matcher(&env, &p.seller, &caller);
            if terms.max_per_order == 0 || p.amount > terms.max_per_order {
                panic_with_error!(&env, Error::NotAuthorized);
            }
            if p.settle_window != 0 && !terms.auto_settle {
                panic_with_error!(&env, Error::NotAuthorized);
            }
            true
        };
        let available = storage::balance(&env, &p.seller, &p.token);
        if available < p.amount {
            panic_with_error!(&env, Error::InsufficientBalance);
        }
        storage::set_balance(&env, &p.seller, &p.token, available - p.amount);
        create(&env, &config, &p, &caller, true, via_matcher)
    }

    /// Opens an order that locks tokens the seller sends now (pulled from
    /// `p.seller`, which authorizes the call).
    pub fn open_with_deposit(env: Env, p: OpenParams) -> u64 {
        p.seller.require_auth();
        storage::extend_instance(&env);
        let config = storage::config(&env);
        if config.paused {
            panic_with_error!(&env, Error::IsPaused);
        }
        validate(&env, &p, &p.seller);
        pull(&env, &p.token, &p.seller, p.amount);
        create(&env, &config, &p, &p.seller, false, false)
    }

    // --- order lifecycle -------------------------------------------------------------

    /// The buyer (or its PERM_TRADE operator) accepts an order that needs a
    /// bond, locking the bond from the buyer's balance.
    pub fn accept(env: Env, caller: Address, id: u64) {
        caller.require_auth();
        storage::extend_instance(&env);
        when_not_paused(&env);
        let mut o = storage::order(&env, id);
        if o.status != Status::Offered {
            panic_with_error!(&env, Error::WrongStatus);
        }
        let now = env.ledger().timestamp();
        if now > o.accept_deadline {
            panic_with_error!(&env, Error::Expired);
        }
        if !can(&env, &o.buyer, &caller, PERM_TRADE) {
            panic_with_error!(&env, Error::NotAuthorized);
        }
        let available = storage::balance(&env, &o.buyer, &o.token);
        if available < o.bond {
            panic_with_error!(&env, Error::InsufficientBalance);
        }
        storage::set_balance(&env, &o.buyer, &o.token, available - o.bond);
        o.status = Status::Active;
        o.payment_deadline = now + u64::from(o.payment_window);
        storage::set_order(&env, id, &o);
        OrderAccepted {
            id,
            payment_deadline: o.payment_deadline,
        }
        .publish(&env);
    }

    /// The buyer's side says it sent the local money.
    pub fn mark_paid(env: Env, caller: Address, id: u64) {
        caller.require_auth();
        storage::extend_instance(&env);
        let mut o = storage::order(&env, id);
        if o.status != Status::Active {
            panic_with_error!(&env, Error::WrongStatus);
        }
        let now = env.ledger().timestamp();
        if now > o.payment_deadline {
            panic_with_error!(&env, Error::Expired);
        }
        if !acts_for_buyer(&env, &o, &caller) {
            panic_with_error!(&env, Error::NotAuthorized);
        }
        o.status = Status::Paid;
        o.paid_at = now;
        storage::set_order(&env, id, &o);
        OrderPaid { id, by: caller }.publish(&env);
    }

    /// The seller (or its PERM_RELEASE operator) confirms it received the
    /// money: the buyer is paid, net of fees.
    pub fn release(env: Env, caller: Address, id: u64) {
        caller.require_auth();
        storage::extend_instance(&env);
        let mut o = storage::order(&env, id);
        if o.status != Status::Active && o.status != Status::Paid {
            panic_with_error!(&env, Error::WrongStatus);
        }
        if !can(&env, &o.seller, &caller, PERM_RELEASE) {
            panic_with_error!(&env, Error::NotAuthorized);
        }
        release_order(&env, id, &mut o, Some(caller));
    }

    /// Anyone releases a paid order whose settle window passed with no dispute.
    pub fn settle(env: Env, id: u64) {
        storage::extend_instance(&env);
        let mut o = storage::order(&env, id);
        if o.status != Status::Paid {
            panic_with_error!(&env, Error::WrongStatus);
        }
        if o.settle_window == 0 || env.ledger().timestamp() < o.paid_at + u64::from(o.settle_window)
        {
            panic_with_error!(&env, Error::NotYet);
        }
        release_order(&env, id, &mut o, None);
    }

    /// Returns the tokens to the seller. Offered: the seller's or the buyer's
    /// side at any time, anyone after the accept deadline. Active: the buyer's
    /// side at any time, anyone after the payment deadline. Paid: only the
    /// buyer or its PERM_TRADE operator (it gives up a payment it reported).
    pub fn cancel(env: Env, caller: Address, id: u64) {
        caller.require_auth();
        storage::extend_instance(&env);
        let mut o = storage::order(&env, id);
        let status = o.status;
        let now = env.ledger().timestamp();
        let expired = match status {
            Status::Offered => now > o.accept_deadline,
            Status::Active => now > o.payment_deadline,
            Status::Paid => false,
            _ => panic_with_error!(&env, Error::WrongStatus),
        };
        if !expired {
            let allowed = match status {
                Status::Offered => {
                    acts_for_buyer(&env, &o, &caller) || acts_for_seller(&env, &o, &caller)
                }
                Status::Active => acts_for_buyer(&env, &o, &caller),
                _ => can(&env, &o.buyer, &caller, PERM_TRADE),
            };
            if !allowed {
                panic_with_error!(&env, Error::NotAuthorized);
            }
        }
        o.status = Status::Cancelled;
        storage::set_order(&env, id, &o);
        refund_seller(&env, &o, o.amount);
        if status != Status::Offered && o.bond != 0 {
            storage::credit(&env, &o.buyer, &o.token, o.bond);
        }
        OrderCancelled {
            id,
            by: if expired { None } else { Some(caller) },
        }
        .publish(&env);
    }

    /// Either side contests a paid order. With a settle window, the seller's
    /// side must do it before the window ends.
    pub fn dispute(env: Env, caller: Address, id: u64) {
        caller.require_auth();
        storage::extend_instance(&env);
        let mut o = storage::order(&env, id);
        if o.status != Status::Paid {
            panic_with_error!(&env, Error::WrongStatus);
        }
        if acts_for_buyer(&env, &o, &caller) {
            // the buyer's side may always escalate a payment the seller ignores
        } else if acts_for_seller(&env, &o, &caller) {
            if o.settle_window != 0
                && env.ledger().timestamp() >= o.paid_at + u64::from(o.settle_window)
            {
                panic_with_error!(&env, Error::Expired);
            }
        } else {
            panic_with_error!(&env, Error::NotAuthorized);
        }
        o.status = Status::Disputed;
        storage::set_order(&env, id, &o);
        OrderDisputed { id, by: caller }.publish(&env);
    }

    /// The arbiter ends a disputed order: `to_buyer` of the amount goes to the
    /// buyer (fees taken from it), the rest back to the seller, and
    /// `bond_to_seller` of the buyer's bond goes to the seller.
    pub fn resolve(env: Env, id: u64, to_buyer: i128, bond_to_seller: i128) {
        storage::extend_instance(&env);
        let config = storage::config(&env);
        config.arbiter.require_auth();
        let mut o = storage::order(&env, id);
        if o.status != Status::Disputed {
            panic_with_error!(&env, Error::WrongStatus);
        }
        if to_buyer < 0 || bond_to_seller < 0 {
            panic_with_error!(&env, Error::NegativeAmount);
        }
        if to_buyer > o.amount || bond_to_seller > o.bond {
            panic_with_error!(&env, Error::BadSplit);
        }
        o.status = Status::Resolved;
        storage::set_order(&env, id, &o);
        let (protocol_fee, integrator_fee) = if to_buyer == 0 {
            (0, 0)
        } else {
            pay_buyer(&env, &config, &o, to_buyer)
        };
        let to_seller = o.amount - to_buyer;
        if to_seller != 0 {
            refund_seller(&env, &o, to_seller);
        }
        if bond_to_seller != 0 {
            push(&env, &o.token, &o.seller, bond_to_seller);
        }
        if o.bond != bond_to_seller {
            storage::credit(&env, &o.buyer, &o.token, o.bond - bond_to_seller);
        }
        OrderResolved {
            id,
            to_buyer,
            to_seller,
            bond_to_seller,
            protocol_fee,
            integrator_fee,
        }
        .publish(&env);
    }

    // --- views ---------------------------------------------------------------------

    pub fn config(env: Env) -> Config {
        storage::extend_instance(&env);
        storage::config(&env)
    }

    /// Fails with UnknownOrder when there is no such order.
    pub fn get_order(env: Env, id: u64) -> Order {
        storage::extend_instance(&env);
        match storage::view_order(&env, id) {
            Some(o) => o,
            None => panic_with_error!(&env, Error::UnknownOrder),
        }
    }

    /// The order `opener` opened with `ref_id`, or 0.
    pub fn order_id_of(env: Env, opener: Address, ref_id: BytesN<32>) -> u64 {
        storage::extend_instance(&env);
        storage::view_ref(&env, &opener, &ref_id)
    }

    pub fn balance_of(env: Env, account: Address, token: Address) -> i128 {
        storage::extend_instance(&env);
        storage::view_balance(&env, &account, &token)
    }

    pub fn permissions_of(env: Env, account: Address, operator: Address) -> u32 {
        storage::extend_instance(&env);
        storage::view_permissions(&env, &account, &operator)
    }

    pub fn matcher_terms_of(env: Env, seller: Address, matcher: Address) -> MatcherTerms {
        storage::extend_instance(&env);
        storage::view_matcher(&env, &seller, &matcher)
    }

    pub fn token_allowed(env: Env, token: Address) -> bool {
        storage::extend_instance(&env);
        storage::token_allowed(&env, &token)
    }

    /// Orders opened so far; ids run from 1 to this.
    pub fn order_count(env: Env) -> u64 {
        storage::extend_instance(&env);
        storage::next_id(&env) - 1
    }
}

// --- internals ---------------------------------------------------------------------

/// Extends the instance, requires the owner's auth and returns the config.
fn owner_call(env: &Env) -> Config {
    storage::extend_instance(env);
    let config = storage::config(env);
    config.owner.require_auth();
    config
}

fn when_not_paused(env: &Env) {
    if storage::config(env).paused {
        panic_with_error!(env, Error::IsPaused);
    }
}

/// Refuses a negative or zero amount.
fn positive(env: &Env, amount: i128) {
    if amount < 0 {
        panic_with_error!(env, Error::NegativeAmount);
    }
    if amount == 0 {
        panic_with_error!(env, Error::ZeroAmount);
    }
}

fn validate(env: &Env, p: &OpenParams, opener: &Address) {
    if p.ref_id.to_array() == [0u8; 32] {
        panic_with_error!(env, Error::EmptyRef);
    }
    if p.seller == p.buyer {
        panic_with_error!(env, Error::SameParty);
    }
    if !storage::token_allowed(env, &p.token) {
        panic_with_error!(env, Error::TokenNotAllowed);
    }
    positive(env, p.amount);
    if p.bond < 0 {
        panic_with_error!(env, Error::NegativeAmount);
    }
    if p.payment_window < MIN_PAYMENT_WINDOW || p.payment_window > MAX_PAYMENT_WINDOW {
        panic_with_error!(env, Error::BadWindow);
    }
    if p.bond == 0 {
        if p.accept_window != 0 {
            panic_with_error!(env, Error::BadWindow);
        }
    } else if p.accept_window < MIN_ACCEPT_WINDOW || p.accept_window > MAX_ACCEPT_WINDOW {
        panic_with_error!(env, Error::BadWindow);
    }
    if p.settle_window != 0
        && (p.settle_window < MIN_SETTLE_WINDOW || p.settle_window > MAX_SETTLE_WINDOW)
    {
        panic_with_error!(env, Error::BadWindow);
    }
    if p.integrator.is_none() != (p.integrator_fee_bps == 0) {
        panic_with_error!(env, Error::BadIntegrator);
    }
    if p.integrator_fee_bps > MAX_INTEGRATOR_FEE_BPS {
        panic_with_error!(env, Error::FeeTooHigh);
    }
    if storage::ref_taken(env, opener, &p.ref_id) {
        panic_with_error!(env, Error::RefTaken);
    }
}

fn create(
    env: &Env,
    config: &Config,
    p: &OpenParams,
    opener: &Address,
    from_balance: bool,
    via_matcher: bool,
) -> u64 {
    let id = storage::next_id(env);
    storage::set_next_id(env, id + 1);
    storage::set_ref(env, opener, &p.ref_id, id);
    let now = env.ledger().timestamp();
    let bonded = p.bond != 0;
    let o = Order {
        seller: p.seller.clone(),
        buyer: p.buyer.clone(),
        token: p.token.clone(),
        opener: opener.clone(),
        integrator: p.integrator.clone(),
        amount: p.amount,
        bond: p.bond,
        status: if bonded {
            Status::Offered
        } else {
            Status::Active
        },
        from_balance,
        via_matcher,
        fee_bps: config.protocol_fee_bps,
        integrator_fee_bps: p.integrator_fee_bps,
        accept_deadline: if bonded {
            now + u64::from(p.accept_window)
        } else {
            0
        },
        payment_deadline: if bonded {
            0
        } else {
            now + u64::from(p.payment_window)
        },
        paid_at: 0,
        payment_window: p.payment_window,
        settle_window: p.settle_window,
        ref_id: p.ref_id.clone(),
    };
    storage::set_order(env, id, &o);
    OrderOpened {
        id,
        seller: o.seller.clone(),
        buyer: o.buyer.clone(),
        token: o.token.clone(),
        opener: o.opener.clone(),
        integrator: o.integrator.clone(),
        amount: o.amount,
        bond: o.bond,
        status: o.status,
        from_balance,
        via_matcher,
        fee_bps: o.fee_bps,
        integrator_fee_bps: o.integrator_fee_bps,
        accept_deadline: o.accept_deadline,
        payment_deadline: o.payment_deadline,
        payment_window: o.payment_window,
        settle_window: o.settle_window,
        ref_id: o.ref_id.clone(),
    }
    .publish(env);
    if !bonded {
        OrderAccepted {
            id,
            payment_deadline: o.payment_deadline,
        }
        .publish(env);
    }
    id
}

fn release_order(env: &Env, id: u64, o: &mut Order, by: Option<Address>) {
    o.status = Status::Released;
    storage::set_order(env, id, o);
    let config = storage::config(env);
    let (protocol_fee, integrator_fee) = pay_buyer(env, &config, o, o.amount);
    if o.bond != 0 {
        storage::credit(env, &o.buyer, &o.token, o.bond);
    }
    OrderReleased {
        id,
        by,
        to_buyer: o.amount - protocol_fee - integrator_fee,
        protocol_fee,
        integrator_fee,
    }
    .publish(env);
}

/// Pays the buyer `gross` minus the order's fees, and the fees to the treasury
/// and the integrator. Returns (protocol fee, integrator fee).
fn pay_buyer(env: &Env, config: &Config, o: &Order, gross: i128) -> (i128, i128) {
    let protocol_fee = gross * i128::from(o.fee_bps) / BPS;
    let integrator_fee = gross * i128::from(o.integrator_fee_bps) / BPS;
    if protocol_fee != 0 {
        push(env, &o.token, &config.treasury, protocol_fee);
    }
    if integrator_fee != 0 {
        if let Some(integrator) = &o.integrator {
            push(env, &o.token, integrator, integrator_fee);
        }
    }
    push(
        env,
        &o.token,
        &o.buyer,
        gross - protocol_fee - integrator_fee,
    );
    (protocol_fee, integrator_fee)
}

fn refund_seller(env: &Env, o: &Order, amount: i128) {
    if o.from_balance {
        storage::credit(env, &o.seller, &o.token, amount);
    } else {
        push(env, &o.token, &o.seller, amount);
    }
}

fn withdraw_to_owner(env: &Env, account: &Address, token: &Address, amount: i128) {
    positive(env, amount);
    let available = storage::balance(env, account, token);
    if available < amount {
        panic_with_error!(env, Error::InsufficientBalance);
    }
    storage::set_balance(env, account, token, available - amount);
    token::TokenClient::new(env, token).transfer(&env.current_contract_address(), account, &amount);
    Withdrawn {
        account: account.clone(),
        token: token.clone(),
        amount,
    }
    .publish(env);
}

/// `caller` is `account` or holds `perm` over it.
fn can(env: &Env, account: &Address, caller: &Address, perm: u32) -> bool {
    caller == account || storage::permissions(env, account, caller) & perm != 0
}

fn acts_for_buyer(env: &Env, o: &Order, caller: &Address) -> bool {
    can(env, &o.buyer, caller, PERM_TRADE) || (o.via_matcher && *caller == o.opener)
}

fn acts_for_seller(env: &Env, o: &Order, caller: &Address) -> bool {
    can(env, &o.seller, caller, PERM_TRADE)
}

/// Pays `to` directly, or credits its market balance when the token refuses
/// the transfer (no trustline, frozen, deauthorized).
fn push(env: &Env, token: &Address, to: &Address, amount: i128) {
    let client = token::TokenClient::new(env, token);
    let paid = matches!(
        client.try_transfer(&env.current_contract_address(), to, &amount),
        Ok(Ok(()))
    );
    if !paid {
        storage::credit(env, to, token, amount);
    }
}

/// Pulls `amount` from `from` (whose auth covers the transfer) and checks that
/// the market's balance grew by exactly that much.
fn pull(env: &Env, token: &Address, from: &Address, amount: i128) {
    let client = token::TokenClient::new(env, token);
    let here = env.current_contract_address();
    let before = client.balance(&here);
    client.transfer(from, &here, &amount);
    if client.balance(&here) - before != amount {
        panic_with_error!(env, Error::ShortDeposit);
    }
}
