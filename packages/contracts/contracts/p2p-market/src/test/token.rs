//! A token the Stellar Asset Contract cannot be: it may take a fee on every
//! transfer, or call back into the market from inside one.

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, MuxedAddress};

use crate::P2PMarketClient;

#[contracttype]
#[derive(Clone)]
enum Key {
    Balance(Address),
    FeeBps,
    /// (market, order id): `transfer` tries `cancel` on it first.
    Hook,
    HookRan,
    HookOk,
}

#[contract]
pub struct TestToken;

#[contractimpl]
impl TestToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        let total = Self::balance(env.clone(), to.clone()) + amount;
        env.storage().instance().set(&Key::Balance(to), &total);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage().instance().get(&Key::Balance(id)).unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128) {
        from.require_auth();
        let to = to.address();
        if let Some((market, id)) = env
            .storage()
            .instance()
            .get::<_, (Address, u64)>(&Key::Hook)
        {
            let outcome = P2PMarketClient::new(&env, &market).try_cancel(&to, &id);
            env.storage().instance().set(&Key::HookRan, &true);
            env.storage().instance().set(&Key::HookOk, &outcome.is_ok());
        }
        let fee_bps: i128 = env.storage().instance().get(&Key::FeeBps).unwrap_or(0);
        let fee = amount * fee_bps / 10_000;
        let from_total = Self::balance(env.clone(), from.clone()) - amount;
        assert!(from_total >= 0, "insufficient balance");
        env.storage()
            .instance()
            .set(&Key::Balance(from), &from_total);
        let to_total = Self::balance(env.clone(), to.clone()) + amount - fee;
        env.storage().instance().set(&Key::Balance(to), &to_total);
    }

    pub fn set_fee_bps(env: Env, bps: i128) {
        env.storage().instance().set(&Key::FeeBps, &bps);
    }

    pub fn set_hook(env: Env, market: Address, id: u64) {
        env.storage().instance().set(&Key::Hook, &(market, id));
    }

    pub fn hook_ran(env: Env) -> bool {
        env.storage().instance().get(&Key::HookRan).unwrap_or(false)
    }

    pub fn hook_ok(env: Env) -> bool {
        env.storage().instance().get(&Key::HookOk).unwrap_or(false)
    }
}
