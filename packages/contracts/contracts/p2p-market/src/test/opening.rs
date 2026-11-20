//! P2PMarket: opening orders.

use soroban_sdk::BytesN;

use super::*;
use crate::{MatcherTerms, OrderAccepted, OrderOpened, Status, PERM_OPEN};

#[test]
fn validates_every_parameter() {
    let t = T::new();
    t.merchant_with_matcher(1_000 * U, 500 * U);
    let p = || t.params();
    let cases: std::vec::Vec<(OpenParams, Error)> = std::vec![
        (
            OpenParams {
                ref_id: BytesN::from_array(&t.env, &[0; 32]),
                ..p()
            },
            Error::EmptyRef
        ),
        (
            OpenParams {
                buyer: t.merchant.clone(),
                ..p()
            },
            Error::SameParty
        ),
        (
            OpenParams {
                token: t.stranger.clone(),
                ..p()
            },
            Error::TokenNotAllowed
        ),
        (OpenParams { amount: 0, ..p() }, Error::ZeroAmount),
        (OpenParams { amount: -1, ..p() }, Error::NegativeAmount),
        (OpenParams { bond: -1, ..p() }, Error::NegativeAmount),
        (
            OpenParams {
                payment_window: 299,
                ..p()
            },
            Error::BadWindow
        ),
        (
            OpenParams {
                payment_window: 2 * 86400 + 1,
                ..p()
            },
            Error::BadWindow
        ),
        // no bond, no acceptance step
        (
            OpenParams {
                accept_window: 60,
                ..p()
            },
            Error::BadWindow
        ),
        (
            OpenParams {
                bond: 1,
                accept_window: 59,
                ..p()
            },
            Error::BadWindow
        ),
        (
            OpenParams {
                bond: 1,
                accept_window: 86401,
                ..p()
            },
            Error::BadWindow
        ),
        (
            OpenParams {
                settle_window: 3599,
                ..p()
            },
            Error::BadWindow
        ),
        (
            OpenParams {
                settle_window: 14 * 86400 + 1,
                ..p()
            },
            Error::BadWindow
        ),
        (
            OpenParams {
                integrator: Some(t.integrator.clone()),
                ..p()
            },
            Error::BadIntegrator
        ),
        (
            OpenParams {
                integrator_fee_bps: 10,
                ..p()
            },
            Error::BadIntegrator
        ),
        (
            OpenParams {
                integrator: Some(t.integrator.clone()),
                integrator_fee_bps: 501,
                ..p()
            },
            Error::FeeTooHigh
        ),
    ];
    for (params, error) in cases {
        fails(t.market.try_open(&t.merchant, &params), error);
    }
    // the bounds themselves are fine
    for (i, params) in [
        OpenParams {
            payment_window: 300,
            ..p()
        },
        OpenParams {
            payment_window: 2 * 86400,
            bond: 1,
            accept_window: 60,
            ..p()
        },
        OpenParams {
            bond: 1,
            accept_window: 86400,
            settle_window: 3600,
            ..p()
        },
        OpenParams {
            settle_window: 14 * 86400,
            integrator: Some(t.integrator.clone()),
            integrator_fee_bps: 500,
            ..p()
        },
    ]
    .into_iter()
    .enumerate()
    {
        let params = OpenParams {
            ref_id: r(&t.env, &std::format!("bound-{i}")),
            amount: U,
            ..params
        };
        t.market.open(&t.merchant, &params);
    }
}

#[test]
fn lets_a_matcher_open_only_within_its_cap_without_a_settle_window_unless_allowed() {
    let t = T::new();
    t.merchant_with_matcher(1_000 * U, 100 * U);
    fails(
        t.market.try_open(
            &t.matcher,
            &OpenParams {
                amount: 101 * U,
                ..t.params()
            },
        ),
        Error::NotAuthorized,
    );
    fails(
        t.market.try_open(
            &t.matcher,
            &OpenParams {
                settle_window: 3600,
                ..t.params()
            },
        ),
        Error::NotAuthorized,
    );
    fails(
        t.market.try_open(&t.stranger, &t.params()),
        Error::NotAuthorized,
    );

    let id = t.market.open(&t.matcher, &t.params());
    assert_eq!(t.authorizers(), [(t.matcher.clone(), "open".into())]);
    assert!(t.emitted(&OrderOpened {
        id,
        seller: t.merchant.clone(),
        buyer: t.buyer.clone(),
        token: t.token.clone(),
        opener: t.matcher.clone(),
        integrator: None,
        amount: 100 * U,
        bond: 0,
        status: Status::Active,
        from_balance: true,
        via_matcher: true,
        fee_bps: 100,
        integrator_fee_bps: 0,
        accept_deadline: 0,
        payment_deadline: START + 1800,
        payment_window: 1800,
        settle_window: 0,
        ref_id: r(&t.env, "order-1"),
    }));
    assert!(t.emitted(&OrderAccepted {
        id,
        payment_deadline: START + 1800,
    }));
    let o = t.order(id);
    assert_eq!(o.status, Status::Active);
    assert!(o.via_matcher);
    assert!(o.from_balance);
    assert_eq!(o.opener, t.matcher);
    assert_eq!(o.fee_bps, 100);
    assert_eq!(o.payment_deadline, t.now() + 1800);
    assert_eq!(t.balance(&t.merchant), 900 * U);

    t.market
        .set_matcher(&t.merchant, &t.matcher, &(100 * U), &true);
    t.market.open(
        &t.matcher,
        &OpenParams {
            ref_id: r(&t.env, "auto"),
            settle_window: 3600,
            ..t.params()
        },
    );

    t.market.set_matcher(&t.merchant, &t.matcher, &0, &true);
    assert_eq!(
        t.market.matcher_terms_of(&t.merchant, &t.matcher),
        MatcherTerms {
            max_per_order: 0,
            auto_settle: false,
        }
    );
    fails(
        t.market.try_open(
            &t.matcher,
            &OpenParams {
                ref_id: r(&t.env, "after"),
                ..t.params()
            },
        ),
        Error::NotAuthorized,
    );
}

#[test]
fn lets_the_seller_and_an_open_operator_open_on_the_balance_never_past_it() {
    let t = T::new();
    t.deposit_as(&t.merchant, 100 * U);
    fails(
        t.market.try_open(
            &t.merchant,
            &OpenParams {
                amount: 101 * U,
                ..t.params()
            },
        ),
        Error::InsufficientBalance,
    );
    let own = t.market.open(
        &t.merchant,
        &OpenParams {
            amount: 50 * U,
            ..t.params()
        },
    );
    assert!(!t.order(own).via_matcher);

    let by_bot = OpenParams {
        ref_id: r(&t.env, "bot"),
        amount: 50 * U,
        settle_window: 3600,
        ..t.params()
    };
    fails(t.market.try_open(&t.bot, &by_bot), Error::NotAuthorized);
    t.market.set_operator(&t.merchant, &t.bot, &PERM_OPEN);
    let id = t.market.open(&t.bot, &by_bot);
    assert_eq!(t.order(id).opener, t.bot);
    assert!(!t.order(id).via_matcher);
    assert_eq!(t.balance(&t.merchant), 0);
}

#[test]
fn keeps_references_unique_per_opener() {
    let t = T::new();
    t.merchant_with_matcher(1_000 * U, 500 * U);
    let id = t.market.open(&t.matcher, &t.params());
    fails(t.market.try_open(&t.matcher, &t.params()), Error::RefTaken);
    assert_eq!(t.market.order_id_of(&t.matcher, &r(&t.env, "order-1")), id);

    // another opener cannot take (or front-run) the matcher's reference
    let other = t.market.open(
        &t.merchant,
        &OpenParams {
            amount: U,
            ..t.params()
        },
    );
    assert_ne!(other, id);
    assert_eq!(t.market.order_id_of(&t.matcher, &r(&t.env, "order-1")), id);
    assert_eq!(
        t.market.order_id_of(&t.merchant, &r(&t.env, "order-1")),
        other
    );
    assert_eq!(t.market.order_id_of(&t.stranger, &r(&t.env, "order-1")), 0);
    assert_eq!(t.market.order_count(), 2);
}

#[test]
fn opens_with_a_deposit_only_for_the_seller() {
    let t = T::new();
    t.fund(&t.user, 10 * U);
    let p = OpenParams {
        seller: t.user.clone(),
        buyer: t.merchant.clone(),
        amount: 10 * U,
        ..t.params()
    };
    // the seller's authorization, nobody else's, opens it
    auth_fails(t.only(&t.stranger, "open_with_deposit", (&p,), || {
        t.market.try_open_with_deposit(&p)
    }));
    let id = t.market.open_with_deposit(&p);
    // the seller authorized the call and, under it, the token pull
    assert_eq!(
        t.authorizers(),
        [(t.user.clone(), "open_with_deposit".into())]
    );
    let auths = t.env.auths();
    assert_eq!(auths[0].1.sub_invocations.len(), 1);
    assert!(!t.order(id).from_balance);
    assert_eq!(t.order(id).opener, t.user);
    assert_eq!(t.wallet(&t.user), 0);
    assert_eq!(t.wallet(&t.id), 10 * U);
}
