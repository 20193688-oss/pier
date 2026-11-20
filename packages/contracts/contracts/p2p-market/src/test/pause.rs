//! P2PMarket: pause and re-entry.

use super::token::{TestToken, TestTokenClient};
use super::*;
use crate::{PausedSet, Status};

#[test]
fn pauses_new_money_in_never_money_out() {
    let t = T::new();
    let id = t.matched_buy(t.params());
    let second = t.market.open(
        &t.matcher,
        &OpenParams {
            ref_id: r(&t.env, "second"),
            ..t.params()
        },
    );
    t.market.mark_paid(&t.matcher, &second);
    let offered = t.bonded_sell(t.sell_params());
    t.market.set_paused(&true);
    assert!(t.emitted(&PausedSet { paused: true }));
    assert!(t.market.config().paused);

    fails(
        t.market.try_deposit(&t.merchant, &t.token, &1),
        Error::IsPaused,
    );
    fails(
        t.market.try_open(
            &t.matcher,
            &OpenParams {
                ref_id: r(&t.env, "third"),
                ..t.params()
            },
        ),
        Error::IsPaused,
    );
    t.fund(&t.user, 10 * U);
    fails(
        t.market.try_open_with_deposit(&OpenParams {
            ref_id: r(&t.env, "sell-3"),
            amount: 10 * U,
            ..t.sell_params()
        }),
        Error::IsPaused,
    );
    fails(t.market.try_accept(&t.merchant, &offered), Error::IsPaused);

    t.market.release(&t.merchant, &id);
    t.market.dispute(&t.matcher, &second);
    t.market.resolve(&second, &0, &0);
    t.market.cancel(&t.user, &offered);
    t.market.withdraw(&t.merchant, &t.token, &(850 * U));
    assert_eq!(t.wallet(&t.merchant), 850 * U);
    assert_eq!(t.order(offered).status, Status::Cancelled);

    t.market.set_paused(&false);
    t.market.deposit(&t.merchant, &t.token, &(50 * U));
}

// EVM: "refuses a token that calls back into the market mid-transfer" (its
// reentrancy guard). On Soroban the host itself refuses to re-enter a
// contract that is already on the call stack.
#[test]
fn refuses_a_token_that_calls_back_into_the_market_mid_transfer() {
    let t = T::new();
    let hook = t.env.register(TestToken, ());
    let hook_token = TestTokenClient::new(&t.env, &hook);
    t.market.set_token(&hook, &true);
    hook_token.mint(&t.merchant, &(1_000 * U));
    t.market.deposit(&t.merchant, &hook, &(1_000 * U));
    t.market
        .set_matcher(&t.merchant, &t.matcher, &(500 * U), &false);
    let id = t.market.open(
        &t.matcher,
        &OpenParams {
            token: hook.clone(),
            ..t.params()
        },
    );

    hook_token.set_hook(&t.id, &id);
    t.market.release(&t.merchant, &id);
    assert!(hook_token.hook_ran());
    assert!(!hook_token.hook_ok());
    assert_eq!(t.order(id).status, Status::Released);
    assert_eq!(hook_token.balance(&t.buyer), 99 * U);
}
