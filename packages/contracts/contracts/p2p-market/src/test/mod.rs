//! The P2PMarket tests: a port of every test of the EVM contract (one module
//! per `describe`), the randomized conservation property, and the
//! Soroban-specific rules (auth, the credit path, events, TTL).
//!
//! Tokens are a real Stellar Asset Contract (`register_stellar_asset_contract_v2`)
//! except where a test needs a token the SAC cannot be (one that takes a fee,
//! one that calls back): those use `token::TestToken`.

extern crate std;

mod admin;
mod balances;
mod buy;
mod opening;
mod pause;
mod property;
mod sell;
mod soroban;
mod token;

use core::fmt::Debug;
use std::{rc::Rc, string::ToString};

use soroban_sdk::{
    testutils::{
        Address as _, AuthorizedFunction, EnvTestConfig, Events as _, IssuerFlags, Ledger as _,
        MockAuth, MockAuthInvoke,
    },
    token::{StellarAssetClient, TokenClient},
    xdr::{self, ScErrorCode, ScErrorType},
    Address, Bytes, BytesN, Env, Error as HostError, Event, IntoVal, InvokeError, TryFromVal, Val,
    Vec,
};

use crate::{Error, OpenParams, Order, P2PMarket, P2PMarketClient};

/// One token: 7 decimals, like every classic asset.
pub const U: i128 = 10_000_000;

/// The ledger time every test starts at.
pub const START: u64 = 1_800_000_000;

pub struct T {
    pub env: Env,
    pub market: P2PMarketClient<'static>,
    /// The market's address.
    pub id: Address,
    pub token: Address,
    pub tok: TokenClient<'static>,
    pub sac: StellarAssetClient<'static>,
    pub asset: xdr::Asset,
    pub owner: Address,
    pub treasury: Address,
    pub arbiter: Address,
    pub matcher: Address,
    pub merchant: Address,
    pub buyer: Address,
    pub user: Address,
    pub integrator: Address,
    pub stranger: Address,
    pub bot: Address,
}

impl T {
    /// A market with a 1% protocol fee and one allowed SAC.
    pub fn new() -> T {
        let env = Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.mock_all_auths();
        env.ledger().set_timestamp(START);
        env.cost_estimate().budget().reset_unlimited();

        let a = || Address::generate(&env);
        let (owner, treasury, arbiter, matcher) = (a(), a(), a(), a());
        let (merchant, buyer, user, integrator, stranger, bot) = (a(), a(), a(), a(), a(), a());

        let asset_contract = env.register_stellar_asset_contract_v2(owner.clone());
        // so the token can deauthorize (freeze) a holder
        asset_contract.issuer().set_flag(IssuerFlags::RevocableFlag);
        let token = asset_contract.address();

        let id = env.register(P2PMarket, (&owner, &treasury, &arbiter, 100u32));
        let market = P2PMarketClient::new(&env, &id);
        market.set_token(&token, &true);

        T {
            tok: TokenClient::new(&env, &token),
            sac: StellarAssetClient::new(&env, &token),
            asset: asset_contract.asset(),
            market,
            id,
            token,
            owner,
            treasury,
            arbiter,
            matcher,
            merchant,
            buyer,
            user,
            integrator,
            stranger,
            bot,
            env,
        }
    }

    /// Mints `amount` into `who`'s wallet.
    pub fn fund(&self, who: &Address, amount: i128) {
        self.sac.mint(who, &amount);
    }

    pub fn deposit_as(&self, who: &Address, amount: i128) {
        self.fund(who, amount);
        self.market.deposit(who, &self.token, &amount);
    }

    /// `who`'s free balance in the market.
    pub fn balance(&self, who: &Address) -> i128 {
        self.market.balance_of(who, &self.token)
    }

    /// `who`'s token balance outside the market.
    pub fn wallet(&self, who: &Address) -> i128 {
        self.tok.balance(who)
    }

    pub fn order(&self, id: u64) -> Order {
        self.market.get_order(&id)
    }

    pub fn now(&self) -> u64 {
        self.env.ledger().timestamp()
    }

    pub fn warp(&self, seconds: u64) {
        self.env.ledger().set_timestamp(self.now() + seconds);
    }

    /// A buy: 100 tokens from the merchant to the buyer, 30 minutes to pay.
    pub fn params(&self) -> OpenParams {
        OpenParams {
            ref_id: r(&self.env, "order-1"),
            seller: self.merchant.clone(),
            buyer: self.buyer.clone(),
            token: self.token.clone(),
            amount: 100 * U,
            bond: 0,
            accept_window: 0,
            payment_window: 1800,
            settle_window: 0,
            integrator: None,
            integrator_fee_bps: 0,
        }
    }

    /// A merchant with liquidity, a matcher allowed up to `cap` per order.
    pub fn merchant_with_matcher(&self, liquidity: i128, cap: i128) {
        self.deposit_as(&self.merchant, liquidity);
        self.market
            .set_matcher(&self.merchant, &self.matcher, &cap, &false);
    }

    /// A buy order the matcher opened on the merchant's liquidity (1000, cap 500).
    pub fn matched_buy(&self, p: OpenParams) -> u64 {
        self.merchant_with_matcher(1_000 * U, 500 * U);
        self.market.open(&self.matcher, &p)
    }

    /// The sell `bonded_sell` opens: USER sells 200 to MERCHANT, 20 of bond.
    pub fn sell_params(&self) -> OpenParams {
        OpenParams {
            ref_id: r(&self.env, "sell-1"),
            seller: self.user.clone(),
            buyer: self.merchant.clone(),
            amount: 200 * U,
            bond: 20 * U,
            accept_window: 600,
            settle_window: 3600,
            ..self.params()
        }
    }

    /// A sell order: USER locks tokens it sends now, MERCHANT (with 50 deposited)
    /// must accept with a bond.
    pub fn bonded_sell(&self, p: OpenParams) -> u64 {
        self.fund(&self.user, p.amount);
        let id = self.market.open_with_deposit(&p);
        self.deposit_as(&self.merchant, 50 * U);
        id
    }

    /// Runs `f` with only `who`'s authorization of `fn_name(args)` on the market.
    pub fn only<R>(
        &self,
        who: &Address,
        fn_name: &str,
        args: impl IntoVal<Env, Vec<Val>>,
        f: impl FnOnce() -> R,
    ) -> R {
        let invoke = MockAuthInvoke {
            contract: &self.id,
            fn_name,
            args: args.into_val(&self.env),
            sub_invokes: &[],
        };
        self.env.mock_auths(&[MockAuth {
            address: who,
            invoke: &invoke,
        }]);
        let result = f();
        self.env.mock_all_auths();
        result
    }

    /// The addresses whose authorization the last call required, and for what.
    pub fn authorizers(&self) -> std::vec::Vec<(Address, std::string::String)> {
        self.env
            .auths()
            .into_iter()
            .map(|(address, invocation)| {
                let name = match invocation.function {
                    AuthorizedFunction::Contract((_, name, _)) => name.to_string(),
                    _ => std::string::String::from("?"),
                };
                (address, name)
            })
            .collect()
    }

    /// Whether the last call published `event` from the market.
    pub fn emitted(&self, event: &impl Event) -> bool {
        let expected = event.to_xdr(&self.env, &self.id);
        self.env
            .events()
            .all()
            .filter_by_contract(&self.id)
            .events()
            .contains(&expected)
    }

    /// A classic account (G...) that exists, with or without a trustline for the token.
    pub fn account(&self, seed: u8, trustline: bool) -> Address {
        let account_id = xdr::AccountId(xdr::PublicKey::PublicKeyTypeEd25519(xdr::Uint256(
            [seed; 32],
        )));
        add_ledger_entry(
            &self.env,
            xdr::LedgerKey::Account(xdr::LedgerKeyAccount {
                account_id: account_id.clone(),
            }),
            xdr::LedgerEntryData::Account(xdr::AccountEntry {
                account_id: account_id.clone(),
                balance: 0,
                flags: 0,
                home_domain: Default::default(),
                inflation_dest: None,
                num_sub_entries: 0,
                seq_num: xdr::SequenceNumber(0),
                thresholds: xdr::Thresholds([1; 4]),
                signers: xdr::VecM::default(),
                ext: xdr::AccountEntryExt::V0,
            }),
        );
        let address = Address::try_from_val(&self.env, &xdr::ScAddress::Account(account_id))
            .expect("an account address");
        if trustline {
            self.add_trustline(&address);
        }
        address
    }

    /// Gives an existing classic account an (authorized) trustline for the token.
    pub fn add_trustline(&self, account: &Address) {
        let account_id = match xdr::ScAddress::from(account) {
            xdr::ScAddress::Account(id) => id,
            other => panic!("not an account: {other:?}"),
        };
        let asset = match self.asset.clone() {
            xdr::Asset::Native => xdr::TrustLineAsset::Native,
            xdr::Asset::CreditAlphanum4(a) => xdr::TrustLineAsset::CreditAlphanum4(a),
            xdr::Asset::CreditAlphanum12(a) => xdr::TrustLineAsset::CreditAlphanum12(a),
        };
        add_ledger_entry(
            &self.env,
            xdr::LedgerKey::Trustline(xdr::LedgerKeyTrustLine {
                account_id: account_id.clone(),
                asset: asset.clone(),
            }),
            xdr::LedgerEntryData::Trustline(xdr::TrustLineEntry {
                account_id,
                asset,
                balance: 0,
                limit: i64::MAX,
                flags: xdr::TrustLineFlags::AuthorizedFlag as u32,
                ext: xdr::TrustLineEntryExt::V0,
            }),
        );
    }
}

fn add_ledger_entry(env: &Env, key: xdr::LedgerKey, data: xdr::LedgerEntryData) {
    let entry = xdr::LedgerEntry {
        data,
        last_modified_ledger_seq: 0,
        ext: xdr::LedgerEntryExt::V0,
    };
    env.host()
        .add_ledger_entry(&Rc::new(key), &Rc::new(entry), None)
        .unwrap();
}

/// A ref: sha256 of a label.
pub fn r(env: &Env, label: &str) -> BytesN<32> {
    env.crypto()
        .sha256(&Bytes::from_slice(env, label.as_bytes()))
        .into()
}

/// The call failed with the contract error `error`.
#[track_caller]
pub fn fails<V: Debug, C: Debug>(
    result: Result<Result<V, C>, Result<HostError, InvokeError>>,
    error: Error,
) {
    match result {
        Err(Ok(got)) => assert_eq!(got, HostError::from(error), "expected {error:?}"),
        other => panic!("expected {error:?}, got {other:?}"),
    }
}

/// The call failed in the host's auth check (a missing authorization). The
/// host reports a failed `require_auth` to a test's `try_` call as
/// `Error(Context, InvalidAction)` (on-chain simulation shows the inner
/// `Error(Auth, InvalidAction)`); which address had to authorize is pinned by
/// [`T::authorizers`] after the same call succeeds.
#[track_caller]
pub fn auth_fails<V: Debug, C: Debug>(
    result: Result<Result<V, C>, Result<HostError, InvokeError>>,
) {
    let failed_auth = [
        HostError::from_type_and_code(ScErrorType::Auth, ScErrorCode::InvalidAction),
        HostError::from_type_and_code(ScErrorType::Context, ScErrorCode::InvalidAction),
    ];
    match result {
        Err(Ok(got)) if failed_auth.contains(&got) => {}
        other => panic!("expected an auth failure, got {other:?}"),
    }
}
