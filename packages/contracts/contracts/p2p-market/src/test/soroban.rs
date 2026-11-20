//! The rules that are Soroban's own: the acting address authorizes, a push
//! to an account without a trustline is credited, the TTL policy, the
//! construction events, and views.

use soroban_sdk::testutils::{
    storage::{Instance as _, Persistent as _},
    Events as _, Ledger as _,
};

use super::*;
use crate::{
    storage::{
        INSTANCE_TTL_EXTEND_TO, INSTANCE_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND_TO,
        PERSISTENT_TTL_THRESHOLD,
    },
    ArbiterSet, Credited, DataKey, OwnershipTransferred, ProtocolFeeSet, Status, TreasurySet,
    PERM_TRADE,
};

#[test]
fn credits_an_account_without_a_trustline_and_lets_it_withdraw_once_it_has_one() {
    let t = T::new();
    // the buyer and the integrator are classic accounts with no trustline
    let buyer = t.account(1, false);
    let integrator = t.account(2, false);
    let id = t.matched_buy(OpenParams {
        buyer: buyer.clone(),
        integrator: Some(integrator.clone()),
        integrator_fee_bps: 100,
        ..t.params()
    });
    t.market.release(&t.merchant, &id);
    assert!(t.emitted(&Credited {
        account: buyer.clone(),
        token: t.token.clone(),
        amount: 98 * U,
    }));
    assert!(t.emitted(&Credited {
        account: integrator.clone(),
        token: t.token.clone(),
        amount: U,
    }));
    assert_eq!(t.balance(&buyer), 98 * U);
    assert_eq!(t.balance(&integrator), U);
    assert_eq!(t.wallet(&t.treasury), U);
    assert_eq!(t.wallet(&t.id), 900 * U + 99 * U);

    // a withdrawal it cannot receive fails and keeps the balance
    assert!(t.market.try_withdraw(&buyer, &t.token, &(98 * U)).is_err());
    assert_eq!(t.balance(&buyer), 98 * U);
    t.add_trustline(&buyer);
    t.market.withdraw(&buyer, &t.token, &(98 * U));
    assert_eq!(t.wallet(&buyer), 98 * U);
}

#[test]
fn credits_a_refund_to_a_seller_the_token_refuses() {
    let t = T::new();
    let id = t.bonded_sell(t.sell_params());
    t.sac.set_authorized(&t.user, &false);
    t.market.cancel(&t.user, &id);
    assert_eq!(t.balance(&t.user), 200 * U);
    assert_eq!(t.wallet(&t.user), 0);
}

#[test]
fn takes_each_role_from_the_acting_address_authorization() {
    let t = T::new();
    t.fund(&t.merchant, 100 * U);
    // a deposit is authorized by the account, the pull as part of it
    t.market.deposit(&t.merchant, &t.token, &(100 * U));
    let auths = t.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, t.merchant);
    assert_eq!(auths[0].1.sub_invocations.len(), 1);
    auth_fails(t.only(
        &t.stranger,
        "deposit",
        (&t.merchant, &t.token, 1i128),
        || t.market.try_deposit(&t.merchant, &t.token, &1),
    ));

    t.market
        .set_matcher(&t.merchant, &t.matcher, &(100 * U), &false);
    let id = t.market.open(&t.matcher, &t.params());
    // naming the matcher is not enough: the matcher must authorize
    auth_fails(t.only(&t.buyer, "mark_paid", (&t.matcher, id), || {
        t.market.try_mark_paid(&t.matcher, &id)
    }));
    t.market.mark_paid(&t.matcher, &id);
    assert_eq!(t.authorizers(), [(t.matcher.clone(), "mark_paid".into())]);
    auth_fails(t.only(&t.buyer, "release", (&t.merchant, id), || {
        t.market.try_release(&t.merchant, &id)
    }));
    t.market.release(&t.merchant, &id);
    assert_eq!(t.authorizers(), [(t.merchant.clone(), "release".into())]);
}

#[test]
fn lets_the_matcher_act_for_the_buyer_only_on_orders_it_opened() {
    let t = T::new();
    t.merchant_with_matcher(1_000 * U, 500 * U);
    let own = t.market.open(&t.merchant, &t.params());
    fails(
        t.market.try_mark_paid(&t.matcher, &own),
        Error::NotAuthorized,
    );
    fails(t.market.try_cancel(&t.matcher, &own), Error::NotAuthorized);
    // a TRADE operator of the buyer may act for it on any order
    t.market.set_operator(&t.buyer, &t.bot, &PERM_TRADE);
    t.market.mark_paid(&t.bot, &own);
    t.market.dispute(&t.bot, &own);
    assert_eq!(t.order(own).status, Status::Disputed);
}

#[test]
fn still_moves_a_token_the_owner_disallowed() {
    let t = T::new();
    let id = t.matched_buy(t.params());
    let second = t.market.open(
        &t.matcher,
        &OpenParams {
            ref_id: r(&t.env, "second"),
            ..t.params()
        },
    );
    t.market.set_token(&t.token, &false);
    assert!(!t.market.token_allowed(&t.token));
    fails(
        t.market.try_deposit(&t.merchant, &t.token, &1),
        Error::TokenNotAllowed,
    );
    t.market.release(&t.merchant, &id);
    t.market.cancel(&t.matcher, &second);
    t.market.withdraw(&t.merchant, &t.token, &(900 * U));
    assert_eq!(t.wallet(&t.merchant), 900 * U);
}

#[test]
fn refuses_zero_and_negative_withdrawals_and_unknown_orders() {
    let t = T::new();
    t.deposit_as(&t.merchant, 10 * U);
    fails(
        t.market.try_withdraw(&t.merchant, &t.token, &0),
        Error::ZeroAmount,
    );
    fails(
        t.market.try_withdraw(&t.merchant, &t.token, &-1),
        Error::NegativeAmount,
    );
    fails(
        t.market
            .try_withdraw_for(&t.merchant, &t.merchant, &t.token, &-1),
        Error::NegativeAmount,
    );
    for id in [0u64, 1, 99] {
        fails(t.market.try_get_order(&id), Error::UnknownOrder);
        fails(t.market.try_release(&t.merchant, &id), Error::UnknownOrder);
        fails(t.market.try_settle(&id), Error::UnknownOrder);
    }
    assert_eq!(t.market.order_count(), 0);
}

#[test]
fn publishes_its_configuration_at_construction() {
    let t = T::new();
    let id = t
        .env
        .register(P2PMarket, (&t.owner, &t.treasury, &t.arbiter, 25u32));
    let expected = [
        OwnershipTransferred {
            from: None,
            to: t.owner.clone(),
        }
        .to_xdr(&t.env, &id),
        TreasurySet {
            treasury: t.treasury.clone(),
        }
        .to_xdr(&t.env, &id),
        ArbiterSet {
            arbiter: t.arbiter.clone(),
        }
        .to_xdr(&t.env, &id),
        ProtocolFeeSet { bps: 25 }.to_xdr(&t.env, &id),
    ];
    assert_eq!(
        t.env.events().all().filter_by_contract(&id).events(),
        expected.as_slice()
    );
}

#[test]
fn extends_what_it_writes_and_reads_and_never_from_a_view() {
    let t = T::new();
    let id = t.matched_buy(t.params());
    let ttl = |key: &DataKey| {
        t.env
            .as_contract(&t.id, || t.env.storage().persistent().get_ttl(key))
    };
    let instance_ttl = || {
        t.env
            .as_contract(&t.id, || t.env.storage().instance().get_ttl())
    };
    let balance_key = DataKey::Balance(t.merchant.clone(), t.token.clone());
    let order_key = DataKey::Order(id);
    let ref_key = DataKey::Ref(t.matcher.clone(), r(&t.env, "order-1"));
    let matcher_key = DataKey::Matcher(t.merchant.clone(), t.matcher.clone());
    for key in [&balance_key, &order_key, &ref_key, &matcher_key] {
        assert_eq!(ttl(key), PERSISTENT_TTL_EXTEND_TO, "{key:?}");
    }
    assert_eq!(instance_ttl(), INSTANCE_TTL_EXTEND_TO);

    // well past the thresholds
    let skip = PERSISTENT_TTL_EXTEND_TO - PERSISTENT_TTL_THRESHOLD + 10;
    assert!(INSTANCE_TTL_EXTEND_TO - INSTANCE_TTL_THRESHOLD < skip);
    t.env
        .ledger()
        .set_sequence_number(t.env.ledger().sequence() + skip);
    let left = PERSISTENT_TTL_EXTEND_TO - skip;

    // views extend the instance only
    t.market.balance_of(&t.merchant, &t.token);
    t.market.get_order(&id);
    assert_eq!(ttl(&balance_key), left);
    assert_eq!(ttl(&order_key), left);
    assert_eq!(instance_ttl(), INSTANCE_TTL_EXTEND_TO);

    // a state-changing call extends what it touched, and only that
    t.market.mark_paid(&t.matcher, &id);
    assert_eq!(ttl(&order_key), PERSISTENT_TTL_EXTEND_TO);
    assert_eq!(ttl(&balance_key), left);
    t.market.open(
        &t.matcher,
        &OpenParams {
            ref_id: r(&t.env, "second"),
            ..t.params()
        },
    );
    assert_eq!(ttl(&balance_key), PERSISTENT_TTL_EXTEND_TO);
    assert_eq!(ttl(&matcher_key), PERSISTENT_TTL_EXTEND_TO);
    assert_eq!(ttl(&ref_key), left);
}

#[test]
fn removes_a_balance_that_reaches_zero() {
    let t = T::new();
    t.deposit_as(&t.merchant, 10 * U);
    t.market.withdraw(&t.merchant, &t.token, &(10 * U));
    let key = DataKey::Balance(t.merchant.clone(), t.token.clone());
    assert!(!t
        .env
        .as_contract(&t.id, || t.env.storage().persistent().has(&key)));
    assert_eq!(t.balance(&t.merchant), 0);
}
