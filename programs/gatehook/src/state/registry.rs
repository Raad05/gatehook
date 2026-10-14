use anchor_lang::prelude::*;

/// One per issuer. Owns the identity set shared by all of the issuer's mints.
#[account]
#[derive(InitSpace)]
pub struct Registry {
    pub version: u8,
    /// Seed key; fixed at creation so the PDA survives admin rotation.
    pub issuer: Pubkey,
    /// Controls configs, pauses and freezes (multisig in production).
    pub admin: Pubkey,
    /// Writes identity attestations.
    pub oracle: Pubkey,
    pub bump: u8,
    /// Proposed admin awaiting `accept_admin`; default = none.
    pub pending_admin: Pubkey,
    pub reserved: [u8; 32],
}
