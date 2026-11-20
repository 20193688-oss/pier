//! P2PMarket: construction and administration.

use soroban_sdk::{testutils::Address as _, Address};

use super::*;
use crate::{Config, OwnershipTransferStarted, OwnershipTransferred, ProtocolFeeSet};

// EVM: "refuses a zero owner, treasury or arbiter and a fee above the cap".
// There is no zero address on Stellar, so only the fee cap is left.
#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn refuses_a_fee_above_the_cap() {
    let t = T::new();
    let a = Address::generate(&t.env);
    t.env.register(P2PMarket, (&a, &a, &a, 301u32));
}

#[test]
fn constructs_with_its_config_and_a_fee_at_the_cap() {
    let t = T::new();
    let a = Address::generate(&t.env);
    let id = t
        .env
        .register(P2PMarket, (&a, &t.treasury, &t.arbiter, 300u32));
    let market = P2PMarketClient::new(&t.env, &id);
    assert_eq!(
        market.config(),
        Config {
            owner: a,
            pending_owner: None,
            treasury: t.treasury.clone(),
            arbiter: t.arbiter.clone(),
            protocol_fee_bps: 300,
            paused: false,
        }
    );
    assert_eq!(market.order_count(), 0);
}

#[test]
fn lets_only_the_owner_configure_it_within_the_fee_cap() {
    let t = T::new();
    let s = &t.stranger;
    // a stranger's own authorization is not the owner's
    auth_fails(t.only(s, "set_protocol_fee", (50u32,), || {
        t.market.try_set_protocol_fee(&50)
    }));
    auth_fails(t.only(s, "set_token", (&t.token, false), || {
        t.market.try_set_token(&t.token, &false)
    }));
    auth_fails(t.only(s, "set_arbiter", (s,), || t.market.try_set_arbiter(s)));
    auth_fails(t.only(s, "set_treasury", (s,), || t.market.try_set_treasury(s)));
    auth_fails(t.only(s, "set_paused", (true,), || t.market.try_set_paused(&true)));
    auth_fails(t.only(s, "transfer_ownership", (s,), || {
        t.market.try_transfer_ownership(s)
    }));

    fails(t.market.try_set_protocol_fee(&301), Error::FeeTooHigh);
    t.market.set_protocol_fee(&300);
    assert_eq!(
        t.authorizers(),
        [(t.owner.clone(), "set_protocol_fee".into())]
    );
    assert!(t.emitted(&ProtocolFeeSet { bps: 300 }));
    assert_eq!(t.market.config().protocol_fee_bps, 300);

    t.market.set_arbiter(s);
    t.market.set_treasury(s);
    assert_eq!(t.market.config().arbiter, *s);
    assert_eq!(t.market.config().treasury, *s);
}

#[test]
fn transfers_ownership_in_two_steps() {
    let t = T::new();
    fails(t.market.try_accept_ownership(), Error::NotPendingOwner);

    t.market.transfer_ownership(&t.stranger);
    assert!(t.emitted(&OwnershipTransferStarted {
        from: t.owner.clone(),
        to: t.stranger.clone(),
    }));
    assert_eq!(t.market.config().owner, t.owner);
    assert_eq!(t.market.config().pending_owner, Some(t.stranger.clone()));

    auth_fails(t.only(&t.buyer, "accept_ownership", (), || {
        t.market.try_accept_ownership()
    }));
    t.only(&t.stranger, "accept_ownership", (), || {
        t.market.accept_ownership()
    });
    assert!(t.emitted(&OwnershipTransferred {
        from: Some(t.owner.clone()),
        to: t.stranger.clone(),
    }));
    assert_eq!(t.market.config().owner, t.stranger);
    assert_eq!(t.market.config().pending_owner, None);

    // the old owner is out
    auth_fails(t.only(&t.owner, "set_paused", (true,), || {
        t.market.try_set_paused(&true)
    }));
    t.market.set_paused(&true);
    assert_eq!(t.authorizers(), [(t.stranger.clone(), "set_paused".into())]);
}
