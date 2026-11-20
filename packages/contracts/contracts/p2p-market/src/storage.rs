//! Storage access and the TTL policy.
//!
//! - **Instance** (config, next order id, allowed tokens): every call extends
//!   it (and the contract code) to [`INSTANCE_TTL_EXTEND_TO`] once fewer than
//!   [`INSTANCE_TTL_THRESHOLD`] ledgers are left.
//! - **Persistent** (orders, balances, refs, permissions, matcher terms): an
//!   entry is extended to [`PERSISTENT_TTL_EXTEND_TO`] once fewer than
//!   [`PERSISTENT_TTL_THRESHOLD`] ledgers are left, whenever a state-changing
//!   call writes it or reads it. Views never extend.
//! - An entry nobody touches for a month is archived, never lost: the client
//!   restores it (the simulation's restore preamble) before using it.
//!
//! Ledger counts assume 5 seconds per ledger.

use soroban_sdk::{panic_with_error, Address, BytesN, Env};

use crate::{
    errors::Error,
    events::Credited,
    types::{Config, DataKey, MatcherTerms, Order},
};

/// Ledgers in a day at 5 seconds per ledger.
pub const DAY_IN_LEDGERS: u32 = 17_280;
pub const INSTANCE_TTL_THRESHOLD: u32 = 15 * DAY_IN_LEDGERS;
pub const INSTANCE_TTL_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;
pub const PERSISTENT_TTL_THRESHOLD: u32 = 15 * DAY_IN_LEDGERS;
pub const PERSISTENT_TTL_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;

pub fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
}

fn extend(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND_TO);
}

// --- instance -----------------------------------------------------------------

pub fn config(env: &Env) -> Config {
    env.storage().instance().get(&DataKey::Config).unwrap()
}

pub fn set_config(env: &Env, config: &Config) {
    env.storage().instance().set(&DataKey::Config, config);
}

/// The id the next order gets.
pub fn next_id(env: &Env) -> u64 {
    env.storage().instance().get(&DataKey::NextId).unwrap_or(1)
}

pub fn set_next_id(env: &Env, id: u64) {
    env.storage().instance().set(&DataKey::NextId, &id);
}

pub fn token_allowed(env: &Env, token: &Address) -> bool {
    env.storage().instance().has(&DataKey::Token(token.clone()))
}

pub fn set_token_allowed(env: &Env, token: &Address, allowed: bool) {
    let key = DataKey::Token(token.clone());
    if allowed {
        env.storage().instance().set(&key, &true);
    } else {
        env.storage().instance().remove(&key);
    }
}

// --- persistent: reads for views (never extend) ---------------------------------

pub fn view_order(env: &Env, id: u64) -> Option<Order> {
    env.storage().persistent().get(&DataKey::Order(id))
}

pub fn view_ref(env: &Env, opener: &Address, ref_id: &BytesN<32>) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::Ref(opener.clone(), ref_id.clone()))
        .unwrap_or(0)
}

pub fn view_balance(env: &Env, account: &Address, token: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Balance(account.clone(), token.clone()))
        .unwrap_or(0)
}

pub fn view_permissions(env: &Env, account: &Address, operator: &Address) -> u32 {
    env.storage()
        .persistent()
        .get(&DataKey::Permissions(account.clone(), operator.clone()))
        .unwrap_or(0)
}

pub fn view_matcher(env: &Env, seller: &Address, matcher: &Address) -> MatcherTerms {
    env.storage()
        .persistent()
        .get(&DataKey::Matcher(seller.clone(), matcher.clone()))
        .unwrap_or(MatcherTerms {
            max_per_order: 0,
            auto_settle: false,
        })
}

// --- persistent: reads and writes for state-changing calls (extend) -------------

/// The order, or `UnknownOrder`.
pub fn order(env: &Env, id: u64) -> Order {
    let key = DataKey::Order(id);
    match env.storage().persistent().get(&key) {
        Some(order) => {
            extend(env, &key);
            order
        }
        None => panic_with_error!(env, Error::UnknownOrder),
    }
}

pub fn set_order(env: &Env, id: u64, order: &Order) {
    let key = DataKey::Order(id);
    env.storage().persistent().set(&key, order);
    extend(env, &key);
}

pub fn ref_taken(env: &Env, opener: &Address, ref_id: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::Ref(opener.clone(), ref_id.clone()))
}

pub fn set_ref(env: &Env, opener: &Address, ref_id: &BytesN<32>, id: u64) {
    let key = DataKey::Ref(opener.clone(), ref_id.clone());
    env.storage().persistent().set(&key, &id);
    extend(env, &key);
}

pub fn balance(env: &Env, account: &Address, token: &Address) -> i128 {
    let key = DataKey::Balance(account.clone(), token.clone());
    match env.storage().persistent().get(&key) {
        Some(amount) => {
            extend(env, &key);
            amount
        }
        None => 0,
    }
}

/// Writes a balance; a zero balance is removed instead of stored.
pub fn set_balance(env: &Env, account: &Address, token: &Address, amount: i128) {
    let key = DataKey::Balance(account.clone(), token.clone());
    if amount == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &amount);
        extend(env, &key);
    }
}

/// Adds `amount` to `account`'s free balance and says so.
pub fn credit(env: &Env, account: &Address, token: &Address, amount: i128) {
    let total = balance(env, account, token) + amount;
    set_balance(env, account, token, total);
    Credited {
        account: account.clone(),
        token: token.clone(),
        amount,
    }
    .publish(env);
}

pub fn permissions(env: &Env, account: &Address, operator: &Address) -> u32 {
    let key = DataKey::Permissions(account.clone(), operator.clone());
    match env.storage().persistent().get(&key) {
        Some(perms) => {
            extend(env, &key);
            perms
        }
        None => 0,
    }
}

/// Writes the bits; 0 removes the grant.
pub fn set_permissions(env: &Env, account: &Address, operator: &Address, perms: u32) {
    let key = DataKey::Permissions(account.clone(), operator.clone());
    if perms == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &perms);
        extend(env, &key);
    }
}

pub fn matcher(env: &Env, seller: &Address, matcher: &Address) -> MatcherTerms {
    let key = DataKey::Matcher(seller.clone(), matcher.clone());
    match env.storage().persistent().get(&key) {
        Some(terms) => {
            extend(env, &key);
            terms
        }
        None => MatcherTerms {
            max_per_order: 0,
            auto_settle: false,
        },
    }
}

/// Writes the terms; a zero cap removes them.
pub fn set_matcher(env: &Env, seller: &Address, matcher: &Address, terms: &MatcherTerms) {
    let key = DataKey::Matcher(seller.clone(), matcher.clone());
    if terms.max_per_order == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, terms);
        extend(env, &key);
    }
}
