//! P2PMarket: a sell with a bond and a settle window.

use super::*;
use crate::{OrderAccepted, OrderCancelled, OrderReleased, Status};

#[test]
fn needs_the_buyer_to_accept_with_its_bond_then_settles_by_itself_after_the_window() {
    let t = T::new();
    let id = t.bonded_sell(OpenParams {
        integrator: Some(t.integrator.clone()),
        integrator_fee_bps: 100,
        ..t.sell_params()
    });
    let o = t.order(id);
    assert_eq!(o.status, Status::Offered);
    assert_eq!(o.accept_deadline, START + 600);
    assert_eq!(o.payment_deadline, 0);
    fails(t.market.try_mark_paid(&t.merchant, &id), Error::WrongStatus);
    fails(t.market.try_accept(&t.stranger, &id), Error::NotAuthorized);

    t.warp(10);
    t.market.accept(&t.merchant, &id);
    assert!(t.emitted(&OrderAccepted {
        id,
        payment_deadline: START + 10 + 1800,
    }));
    assert_eq!(t.balance(&t.merchant), 30 * U);
    assert_eq!(t.order(id).status, Status::Active);
    fails(t.market.try_accept(&t.merchant, &id), Error::WrongStatus);

    t.market.mark_paid(&t.merchant, &id);
    fails(t.market.try_settle(&id), Error::NotYet);
    t.warp(3599);
    fails(t.market.try_settle(&id), Error::NotYet);
    t.warp(1);
    // anyone: settle takes no authorization at all
    t.env.set_auths(&[]);
    t.market.settle(&id);
    t.env.mock_all_auths();
    assert!(t.emitted(&OrderReleased {
        id,
        by: None,
        to_buyer: 196 * U,
        protocol_fee: 2 * U,
        integrator_fee: 2 * U,
    }));

    // 200 - 1% protocol - 1% integrator to the merchant, its bond back
    assert_eq!(t.wallet(&t.merchant), 196 * U);
    assert_eq!(t.balance(&t.merchant), 50 * U);
    assert_eq!(t.wallet(&t.treasury), 2 * U);
    assert_eq!(t.wallet(&t.integrator), 2 * U);
}

#[test]
fn lets_the_seller_dispute_only_inside_the_window() {
    let t = T::new();
    let id = t.bonded_sell(t.sell_params());
    t.market.accept(&t.merchant, &id);
    t.market.mark_paid(&t.merchant, &id);
    t.warp(3600);
    fails(t.market.try_dispute(&t.user, &id), Error::Expired);

    let second = t.bonded_sell(OpenParams {
        ref_id: r(&t.env, "sell-2"),
        ..t.sell_params()
    });
    t.market.accept(&t.merchant, &second);
    t.market.mark_paid(&t.merchant, &second);
    t.warp(3599);
    t.market.dispute(&t.user, &second);
    fails(t.market.try_settle(&second), Error::WrongStatus);
}

#[test]
fn lets_the_arbiter_give_the_seller_the_bond_of_a_buyer_that_lied() {
    let t = T::new();
    let id = t.bonded_sell(t.sell_params());
    t.market.accept(&t.merchant, &id);
    t.market.mark_paid(&t.merchant, &id);
    t.market.dispute(&t.user, &id);
    t.market.resolve(&id, &0, &(20 * U));
    // the seller locked from its wallet, so its refund goes to its wallet
    assert_eq!(t.wallet(&t.user), 220 * U);
    assert_eq!(t.balance(&t.merchant), 30 * U);
    assert_eq!(t.wallet(&t.treasury), 0);
    assert_eq!(t.wallet(&t.id), 30 * U);
}

#[test]
fn returns_part_of_the_bond_when_the_arbiter_takes_only_part() {
    let t = T::new();
    let id = t.bonded_sell(t.sell_params());
    t.market.accept(&t.merchant, &id);
    t.market.mark_paid(&t.merchant, &id);
    t.market.dispute(&t.merchant, &id);
    t.market.resolve(&id, &(100 * U), &(5 * U));
    assert_eq!(t.wallet(&t.merchant), 99 * U);
    assert_eq!(t.wallet(&t.user), 105 * U);
    assert_eq!(t.balance(&t.merchant), 45 * U);
}

#[test]
fn expires_an_offer_nobody_accepted_and_refuses_a_late_acceptance() {
    let t = T::new();
    let id = t.bonded_sell(t.sell_params());
    fails(t.market.try_cancel(&t.stranger, &id), Error::NotAuthorized);
    t.warp(601);
    fails(t.market.try_accept(&t.merchant, &id), Error::Expired);
    t.market.cancel(&t.stranger, &id);
    assert!(t.emitted(&OrderCancelled { id, by: None }));
    assert_eq!(t.wallet(&t.user), 200 * U);
    assert_eq!(t.balance(&t.merchant), 50 * U);
}

#[test]
fn lets_the_seller_withdraw_an_offer_before_it_is_accepted() {
    let t = T::new();
    let id = t.bonded_sell(t.sell_params());
    t.market.cancel(&t.user, &id);
    assert!(t.emitted(&OrderCancelled {
        id,
        by: Some(t.user.clone()),
    }));
    assert_eq!(t.wallet(&t.user), 200 * U);
}

#[test]
fn refuses_an_acceptance_the_buyer_cannot_bond() {
    let t = T::new();
    t.fund(&t.user, 10 * U);
    let id = t.market.open_with_deposit(&OpenParams {
        seller: t.user.clone(),
        buyer: t.buyer.clone(),
        amount: 10 * U,
        bond: 5 * U,
        accept_window: 600,
        ..t.params()
    });
    fails(
        t.market.try_accept(&t.buyer, &id),
        Error::InsufficientBalance,
    );
}

#[test]
fn returns_the_bond_to_a_buyer_that_accepted_and_let_the_payment_window_pass() {
    let t = T::new();
    let id = t.bonded_sell(t.sell_params());
    t.market.accept(&t.merchant, &id);
    t.warp(1801);
    t.market.cancel(&t.stranger, &id);
    assert_eq!(t.wallet(&t.user), 200 * U);
    assert_eq!(t.balance(&t.merchant), 50 * U);
}
