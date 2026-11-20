//! Property test: random sequences of every action, from every actor. After
//! each step the contract must hold exactly what it owes: every free balance,
//! plus the amount of every live order, plus the bond of every accepted one.

use soroban_sdk::Address;

use super::*;
use crate::{Order, Status};

/// mulberry32, as the EVM test used.
struct Rng(u32);

impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() * n as f64) as usize
    }

    fn pick<'a, X>(&mut self, xs: &'a [X]) -> &'a X {
        &xs[self.below(xs.len())]
    }
}

/// How a walk picks its actors and moves time.
struct Walk {
    steps: u32,
    /// Chance that the actor is one of the picked order's own parties.
    party_bias: f64,
    /// A time step is up to this many seconds.
    max_warp: usize,
}

/// The EVM test's walk: any actor, any time.
const EVM: Walk = Walk {
    steps: 160,
    party_bias: 0.0,
    max_warp: 4000,
};

/// A walk that mostly lets an order's own parties act, so orders get paid,
/// disputed and resolved, not only opened, released and cancelled.
const PARTIES: Walk = Walk {
    steps: 300,
    party_bias: 0.7,
    max_warp: 1200,
};

fn run(seed: u32, walk: Walk) -> std::collections::BTreeSet<u32> {
    let t = T::new();
    let mut rand = Rng(seed);
    let actors = [
        t.merchant.clone(),
        t.buyer.clone(),
        t.user.clone(),
        t.matcher.clone(),
        t.bot.clone(),
        t.stranger.clone(),
        t.arbiter.clone(),
    ];
    let accounts: std::vec::Vec<Address> = actors
        .iter()
        .cloned()
        .chain([t.treasury.clone(), t.integrator.clone()])
        .collect();
    let mut ids: std::vec::Vec<u64> = std::vec::Vec::new();

    for a in [&t.merchant, &t.buyer, &t.user] {
        t.deposit_as(a, 500 * U);
    }
    for a in [&t.merchant, &t.user] {
        t.fund(a, 500 * U);
    }
    t.market
        .set_matcher(&t.merchant, &t.matcher, &(40 * U), &true);
    t.market.set_operator(&t.user, &t.bot, &15);

    // What the market owes: every free balance, plus the amount of every live
    // order and the bond of every accepted one.
    let owed = |orders: &[Order]| -> i128 {
        let balances: i128 = accounts.iter().map(|a| t.balance(a)).sum();
        let locked: i128 = orders
            .iter()
            .map(|o| match o.status {
                Status::Offered => o.amount,
                Status::Active | Status::Paid | Status::Disputed => o.amount + o.bond,
                _ => 0,
            })
            .sum();
        balances + locked
    };

    let mut statuses = std::collections::BTreeSet::new();
    // every order, as of the end of the last step
    let mut orders: std::vec::Vec<Order> = std::vec::Vec::new();
    for step in 0..walk.steps {
        let mut from = rand.pick(&actors).clone();
        let mut id = if ids.is_empty() { 0 } else { *rand.pick(&ids) };
        if id != 0 && rand.next() < walk.party_bias {
            // a live order, acted on by one of its own parties
            let live: std::vec::Vec<usize> = (0..orders.len())
                .filter(|i| (orders[*i].status as u32) < Status::Released as u32)
                .collect();
            let index = if live.is_empty() {
                (id - 1) as usize
            } else {
                *rand.pick(&live)
            };
            id = ids[index];
            let o = &orders[index];
            from = rand
                .pick(&[o.seller.clone(), o.buyer.clone(), o.opener.clone()])
                .clone();
        }
        let amount = |rand: &mut Rng| (1 + rand.below(50) as i128) * U;
        let roll = rand.next();
        if roll < 0.2 {
            let seller = rand.pick(&[t.merchant.clone(), t.user.clone()]).clone();
            let others: std::vec::Vec<Address> =
                actors.iter().filter(|a| **a != seller).cloned().collect();
            let buyer = rand.pick(&others).clone();
            let amount = amount(&mut rand);
            let bond = if rand.next() < 0.5 {
                amount_bond(&mut rand)
            } else {
                0
            };
            let settle_window = if rand.next() < 0.5 { 3600 } else { 0 };
            let integrator = if rand.next() < 0.5 {
                Some(t.integrator.clone())
            } else {
                None
            };
            let p = OpenParams {
                ref_id: r(&t.env, &std::format!("r{step}")),
                seller: seller.clone(),
                buyer,
                token: t.token.clone(),
                amount,
                bond,
                accept_window: if bond > 0 { 300 } else { 0 },
                payment_window: 600,
                settle_window,
                integrator_fee_bps: if integrator.is_some() { 75 } else { 0 },
                integrator,
            };
            let opened = if rand.next() < 0.3 {
                t.market.try_open_with_deposit(&p)
            } else {
                t.market.try_open(&from, &p)
            };
            if let Ok(Ok(new_id)) = opened {
                ids.push(new_id);
            }
        } else if roll < 0.3 {
            let _ = t.market.try_accept(&from, &id);
        } else if roll < 0.42 {
            let _ = t.market.try_mark_paid(&from, &id);
        } else if roll < 0.52 {
            let _ = t.market.try_release(&from, &id);
        } else if roll < 0.58 {
            let _ = t.market.try_settle(&id);
        } else if roll < 0.68 {
            let _ = t.market.try_cancel(&from, &id);
        } else if roll < 0.74 {
            let _ = t.market.try_dispute(&from, &id);
        } else if roll < 0.8 {
            let (amount, bond) = match t.market.try_get_order(&id) {
                Ok(Ok(o)) => (o.amount, o.bond),
                _ => (0, 0),
            };
            let to_buyer = amount * rand.below(101) as i128 / 100;
            let bond_to_seller = bond * rand.below(101) as i128 / 100;
            let _ = t.market.try_resolve(&id, &to_buyer, &bond_to_seller);
        } else if roll < 0.86 {
            let a = amount(&mut rand);
            let _ = t.market.try_withdraw(&from, &t.token, &a);
        } else if roll < 0.9 {
            // the issuer freezes or unfreezes the buyer: pushes to it are credited
            let frozen = rand.next() < 0.5;
            t.sac.set_authorized(&t.buyer, &!frozen);
        } else {
            t.warp(rand.below(walk.max_warp) as u64);
        }

        orders = ids.iter().map(|id| t.order(*id)).collect();
        assert_eq!(t.wallet(&t.id), owed(&orders), "seed {seed}, step {step}");
        statuses.extend(orders.iter().map(|o| o.status as u32));
    }
    assert!(ids.len() > 5, "seed {seed}: only {} orders", ids.len());
    statuses
}

/// A quarter of a random amount, like the EVM test's `amount() / 4n`.
fn amount_bond(rand: &mut Rng) -> i128 {
    (1 + rand.below(50) as i128) * U / 4
}

#[test]
fn random_sequences_never_create_or_lose_money_seed_1() {
    run(1, EVM);
}

#[test]
fn random_sequences_never_create_or_lose_money_seed_2() {
    run(2, EVM);
}

#[test]
fn random_sequences_never_create_or_lose_money_seed_3() {
    run(3, EVM);
}

#[test]
fn random_sequences_never_create_or_lose_money_seed_4() {
    run(4, EVM);
}

#[test]
fn random_sequences_of_the_parties_reach_every_ending_and_never_create_or_lose_money() {
    let mut reached = std::collections::BTreeSet::new();
    for seed in 1..=4 {
        reached.extend(run(seed, PARTIES));
    }
    let every = [
        Status::Offered,
        Status::Active,
        Status::Paid,
        Status::Disputed,
        Status::Released,
        Status::Cancelled,
        Status::Resolved,
    ];
    for status in every {
        assert!(
            reached.contains(&(status as u32)),
            "never {status:?}: {reached:?}"
        );
    }
}
