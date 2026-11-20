use soroban_sdk::contracterror;

/// Every way a call fails on purpose. A call fails with
/// `Error(Contract, #code)`; the codes are part of the interface.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Reserved: owner functions require the owner's auth, so a stranger fails the host's auth check.
    NotOwner = 1,
    /// `accept_ownership` with no pending owner.
    NotPendingOwner = 2,
    /// Reserved: `resolve` requires the arbiter's auth, so a stranger fails the host's auth check.
    NotArbiter = 3,
    /// The acting address does not play a role that may do this.
    NotAuthorized = 4,
    /// Paused: no deposits, new orders or acceptances.
    IsPaused = 5,
    ZeroAmount = 6,
    TokenNotAllowed = 7,
    /// Protocol fee above 300 bps or integrator fee above 500 bps.
    FeeTooHigh = 8,
    /// A window outside its bounds, or an accept window without a bond.
    BadWindow = 9,
    /// An integrator without a fee, or a fee without an integrator.
    BadIntegrator = 10,
    /// Seller and buyer, account and operator, or seller and matcher are the same address.
    SameParty = 11,
    /// The opener already used this ref_id.
    RefTaken = 12,
    /// ref_id is all zeros.
    EmptyRef = 13,
    InsufficientBalance = 14,
    /// The market received less than the amount (a token that takes a fee).
    ShortDeposit = 15,
    UnknownOrder = 16,
    /// The order's status does not allow this.
    WrongStatus = 17,
    /// A deadline or the settle window passed.
    Expired = 18,
    /// The settle window has not passed (or the order has none).
    NotYet = 19,
    /// `resolve` split more than the order's amount or bond.
    BadSplit = 20,
    /// Permission bits outside PERM_ALL (15).
    InvalidPermissions = 21,
    /// An amount, bond, cap or split below zero.
    NegativeAmount = 22,
}
