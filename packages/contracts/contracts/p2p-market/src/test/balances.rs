//! P2PMarket: balances.

use soroban_sdk::{testutils::Address as _, Address};

use super::token::{TestToken, TestTokenClient};
use super::*;
use crate::{Deposited, Withdrawn, PERM_TRADE, PERM_WITHDRAW};

#[test]
fn deposits_and_withdraws_only_to_the_owner_of_the_balance() {
    let t = T::new();
    t.deposit_as(&t.merchant, 100 * U);
    assert!(t.emitted(&Deposited {
        account: t.merchant.clone(),
        token: t.token.clone(),
        amount: 100 * U,
    }));
    assert_eq!(t.balance(&t.merchant), 100 * U);
    assert_eq!(t.wallet(&t.id), 100 * U);

    fails(
        t.market.try_withdraw(&t.merchant, &t.token, &(101 * U)),
        Error::InsufficientBalance,
    );
    // only the account itself authorizes its withdrawal
    auth_fails(t.only(
        &t.stranger,
        "withdraw",
        (&t.merchant, &t.token, 40 * U),
        || t.market.try_withdraw(&t.merchant, &t.token, &(40 * U)),
    ));
    t.market.withdraw(&t.merchant, &t.token, &(40 * U));
    assert_eq!(t.authorizers(), [(t.merchant.clone(), "withdraw".into())]);
    assert!(t.emitted(&Withdrawn {
        account: t.merchant.clone(),
        token: t.token.clone(),
        amount: 40 * U,
    }));
    assert_eq!(t.wallet(&t.merchant), 40 * U);
    assert_eq!(t.balance(&t.merchant), 60 * U);
}

#[test]
fn refuses_a_token_the_owner_did_not_allow_and_a_zero_amount() {
    let t = T::new();
    let other = t
        .env
        .register_stellar_asset_contract_v2(t.owner.clone())
        .address();
    fails(
        t.market.try_deposit(&t.merchant, &other, &1),
        Error::TokenNotAllowed,
    );
    fails(
        t.market.try_deposit(&t.merchant, &t.token, &0),
        Error::ZeroAmount,
    );
    fails(
        t.market.try_deposit(&t.merchant, &t.token, &-1),
        Error::NegativeAmount,
    );
}

#[test]
fn refuses_a_deposit_that_arrives_short() {
    let t = T::new();
    let fee_token = t.env.register(TestToken, ());
    let fee_client = TestTokenClient::new(&t.env, &fee_token);
    fee_client.set_fee_bps(&100);
    fee_client.mint(&t.merchant, &(100 * U));
    t.market.set_token(&fee_token, &true);
    fails(
        t.market.try_deposit(&t.merchant, &fee_token, &(100 * U)),
        Error::ShortDeposit,
    );
}

// EVM: "works with a token whose transfers return nothing" (a non-standard
// ERC-20). The Stellar counterpart: a classic account holds the asset in a
// trustline, not in contract storage, and the market works the same.
#[test]
fn works_with_a_classic_account_holding_the_asset_in_a_trustline() {
    let t = T::new();
    let account = t.account(7, true);
    t.deposit_as(&account, 10 * U);
    assert_eq!(t.wallet(&account), 0);
    t.market.withdraw(&account, &t.token, &(10 * U));
    assert_eq!(t.wallet(&account), 10 * U);
    assert_eq!(t.balance(&account), 0);
}

#[test]
fn lets_a_withdraw_operator_withdraw_always_to_the_account() {
    let t = T::new();
    t.deposit_as(&t.merchant, 10 * U);
    fails(
        t.market.try_withdraw_for(&t.bot, &t.merchant, &t.token, &1),
        Error::NotAuthorized,
    );
    t.market.set_operator(&t.merchant, &t.bot, &PERM_TRADE);
    fails(
        t.market.try_withdraw_for(&t.bot, &t.merchant, &t.token, &1),
        Error::NotAuthorized,
    );
    t.market.set_operator(&t.merchant, &t.bot, &PERM_WITHDRAW);
    t.market
        .withdraw_for(&t.bot, &t.merchant, &t.token, &(10 * U));
    assert_eq!(t.authorizers(), [(t.bot.clone(), "withdraw_for".into())]);
    assert_eq!(t.wallet(&t.merchant), 10 * U);
    assert_eq!(t.wallet(&t.bot), 0);
}

#[test]
fn refuses_unknown_permission_bits_and_self_delegation() {
    let t = T::new();
    fails(
        t.market.try_set_operator(&t.merchant, &t.bot, &16),
        Error::InvalidPermissions,
    );
    fails(
        t.market.try_set_operator(&t.merchant, &t.merchant, &1),
        Error::SameParty,
    );
    fails(
        t.market
            .try_set_matcher(&t.merchant, &t.merchant, &1, &false),
        Error::SameParty,
    );
    fails(
        t.market
            .try_set_matcher(&t.merchant, &t.matcher, &-1, &false),
        Error::NegativeAmount,
    );
    // only the account grants over itself
    let other = Address::generate(&t.env);
    auth_fails(
        t.only(&t.bot, "set_operator", (&t.merchant, &other, 15u32), || {
            t.market.try_set_operator(&t.merchant, &other, &15)
        }),
    );
    t.market.set_operator(&t.merchant, &other, &15);
    assert_eq!(t.market.permissions_of(&t.merchant, &other), 15);
    t.market.set_operator(&t.merchant, &other, &0);
    assert_eq!(t.market.permissions_of(&t.merchant, &other), 0);
}
