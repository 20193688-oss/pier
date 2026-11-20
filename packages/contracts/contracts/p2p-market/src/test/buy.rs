//! P2PMarket: a buy on a merchant's liquidity (no bond, seller releases).

use super::*;
use crate::{
    Credited, OrderCancelled, OrderDisputed, OrderPaid, OrderReleased, OrderResolved, Status,
    PERM_OPEN, PERM_RELEASE, PERM_TRADE, PERM_WITHDRAW,
};

#[test]
fn pays_the_buyer_net_of_the_protocol_and_integrator_fees() {
    let t = T::new();
    let id = t.matched_buy(OpenParams {
        integrator: Some(t.integrator.clone()),
        integrator_fee_bps: 50,
        ..t.params()
    });
    fails(
        t.market.try_mark_paid(&t.stranger, &id),
        Error::NotAuthorized,
    );
    fails(
        t.market.try_mark_paid(&t.merchant, &id),
        Error::NotAuthorized,
    );
    // the matcher reports the payment for a buyer without fees
    t.market.mark_paid(&t.matcher, &id);
    assert!(t.emitted(&OrderPaid {
        id,
        by: t.matcher.clone(),
    }));
    assert_eq!(t.order(id).status, Status::Paid);
    assert_eq!(t.order(id).paid_at, START);

    fails(t.market.try_release(&t.buyer, &id), Error::NotAuthorized);
    fails(t.market.try_release(&t.matcher, &id), Error::NotAuthorized);
    t.market.release(&t.merchant, &id);
    assert!(t.emitted(&OrderReleased {
        id,
        by: Some(t.merchant.clone()),
        to_buyer: 985 * (U / 10),
        protocol_fee: U,
        integrator_fee: U / 2,
    }));
    assert_eq!(t.wallet(&t.buyer), 985 * (U / 10));
    assert_eq!(t.wallet(&t.treasury), U);
    assert_eq!(t.wallet(&t.integrator), U / 2);
    assert_eq!(t.balance(&t.merchant), 900 * U);
    assert_eq!(t.wallet(&t.id), 900 * U);
    assert_eq!(t.order(id).status, Status::Released);
    fails(t.market.try_release(&t.merchant, &id), Error::WrongStatus);
}

#[test]
fn keeps_the_fee_an_order_was_opened_with() {
    let t = T::new();
    let id = t.matched_buy(t.params());
    t.market.set_protocol_fee(&300);
    t.market.release(&t.merchant, &id);
    assert_eq!(t.wallet(&t.treasury), U);
}

#[test]
fn lets_a_release_operator_release_and_no_other_permission() {
    let t = T::new();
    let id = t.matched_buy(t.params());
    t.market.set_operator(
        &t.merchant,
        &t.bot,
        &(PERM_TRADE | PERM_OPEN | PERM_WITHDRAW),
    );
    fails(t.market.try_release(&t.bot, &id), Error::NotAuthorized);
    t.market.set_operator(&t.merchant, &t.bot, &PERM_RELEASE);
    t.market.release(&t.bot, &id);
    assert_eq!(t.wallet(&t.buyer), 99 * U);
}

#[test]
fn expires_an_unpaid_order_back_to_the_merchant_and_only_then_lets_anyone_cancel_it() {
    let t = T::new();
    let id = t.matched_buy(t.params());
    fails(t.market.try_cancel(&t.stranger, &id), Error::NotAuthorized);
    fails(t.market.try_cancel(&t.merchant, &id), Error::NotAuthorized);
    t.warp(1800);
    // the deadline's own second still counts
    t.market.mark_paid(&t.matcher, &id);
    assert_eq!(t.order(id).status, Status::Paid);

    let second = t.market.open(
        &t.matcher,
        &OpenParams {
            ref_id: r(&t.env, "second"),
            ..t.params()
        },
    );
    t.warp(1801);
    fails(t.market.try_mark_paid(&t.matcher, &second), Error::Expired);
    t.market.cancel(&t.stranger, &second);
    // a passed deadline needed no actor
    assert!(t.emitted(&OrderCancelled {
        id: second,
        by: None
    }));
    assert_eq!(t.order(second).status, Status::Cancelled);
    assert_eq!(t.balance(&t.merchant), 900 * U);
}

#[test]
fn lets_the_buyer_side_cancel_before_paying() {
    let t = T::new();
    let id = t.matched_buy(t.params());
    t.market.cancel(&t.matcher, &id);
    assert!(t.emitted(&OrderCancelled {
        id,
        by: Some(t.matcher.clone()),
    }));
    assert_eq!(t.balance(&t.merchant), 1_000 * U);
    fails(t.market.try_cancel(&t.matcher, &id), Error::WrongStatus);
}

#[test]
fn never_lets_the_seller_or_the_matcher_take_back_a_paid_order() {
    let t = T::new();
    let id = t.matched_buy(t.params());
    t.market.mark_paid(&t.matcher, &id);
    t.warp(7 * 86400);
    fails(t.market.try_cancel(&t.merchant, &id), Error::NotAuthorized);
    fails(t.market.try_cancel(&t.matcher, &id), Error::NotAuthorized);
    fails(t.market.try_cancel(&t.stranger, &id), Error::NotAuthorized);
    fails(t.market.try_settle(&id), Error::NotYet);
    // the buyer itself may give up a payment it reported
    t.market.cancel(&t.buyer, &id);
    assert!(t.emitted(&OrderCancelled {
        id,
        by: Some(t.buyer.clone()),
    }));
    assert_eq!(t.balance(&t.merchant), 1_000 * U);
}

#[test]
fn sends_a_dispute_to_the_arbiter_who_pays_only_this_orders_parties() {
    let t = T::new();
    let id = t.matched_buy(t.params());
    fails(t.market.try_dispute(&t.buyer, &id), Error::WrongStatus);
    t.market.mark_paid(&t.matcher, &id);
    fails(t.market.try_dispute(&t.stranger, &id), Error::NotAuthorized);
    t.market.dispute(&t.matcher, &id);
    assert!(t.emitted(&OrderDisputed {
        id,
        by: t.matcher.clone(),
    }));
    assert_eq!(t.order(id).status, Status::Disputed);
    fails(t.market.try_release(&t.merchant, &id), Error::WrongStatus);

    // only the arbiter's authorization resolves
    auth_fails(t.only(&t.owner, "resolve", (id, 60 * U, 0i128), || {
        t.market.try_resolve(&id, &(60 * U), &0)
    }));
    fails(t.market.try_resolve(&id, &(101 * U), &0), Error::BadSplit);
    fails(t.market.try_resolve(&id, &0, &1), Error::BadSplit);
    fails(t.market.try_resolve(&id, &-1, &0), Error::NegativeAmount);
    fails(t.market.try_resolve(&id, &0, &-1), Error::NegativeAmount);
    t.market.resolve(&id, &(60 * U), &0);
    assert_eq!(t.authorizers(), [(t.arbiter.clone(), "resolve".into())]);
    assert!(t.emitted(&OrderResolved {
        id,
        to_buyer: 60 * U,
        to_seller: 40 * U,
        bond_to_seller: 0,
        protocol_fee: 6 * (U / 10),
        integrator_fee: 0,
    }));
    assert_eq!(t.wallet(&t.buyer), 594 * (U / 10)); // 60 - 1%
    assert_eq!(t.wallet(&t.treasury), 6 * (U / 10));
    assert_eq!(t.balance(&t.merchant), 940 * U);
    assert_eq!(t.order(id).status, Status::Resolved);
    fails(t.market.try_resolve(&id, &0, &0), Error::WrongStatus);
}

#[test]
fn credits_a_buyer_the_token_refuses_to_pay_instead_of_freezing_the_order() {
    let t = T::new();
    let id = t.matched_buy(t.params());
    // the issuer freezes the buyer
    t.sac.set_authorized(&t.buyer, &false);
    t.market.release(&t.merchant, &id);
    assert!(t.emitted(&Credited {
        account: t.buyer.clone(),
        token: t.token.clone(),
        amount: 99 * U,
    }));
    assert_eq!(t.balance(&t.buyer), 99 * U);
    assert_eq!(t.wallet(&t.buyer), 0);
    assert_eq!(t.wallet(&t.treasury), U);
    assert_eq!(t.order(id).status, Status::Released);
    // the buyer withdraws once the issuer lets it hold the token again
    t.sac.set_authorized(&t.buyer, &true);
    t.market.withdraw(&t.buyer, &t.token, &(99 * U));
    assert_eq!(t.wallet(&t.buyer), 99 * U);
}
