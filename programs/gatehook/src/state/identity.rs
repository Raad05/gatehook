use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
#[repr(u8)]
pub enum Tier {
    None,
    RegDAccredited,
    RegSNonUs,
    QualifiedPurchaser,
    /// Issuer treasury; exempt from lockups.
    Issuer,
    /// Whitelisted AMM pool / escrow PDA.
    Venue,
}

/// KYC attestation for one wallet within one issuer registry.
#[account]
#[derive(InitSpace)]
pub struct Identity {
    pub version: u8,
    pub registry: Pubkey,
    pub wallet: Pubkey,
    pub tier: Tier,
    pub jurisdiction: u8,
    pub kyc_expiry: i64,
    /// Per-holder holding period (e.g. Rule 144).
    pub lockup_until: i64,
    pub frozen: bool,
    /// Velocity tracking, written by the transfer hook.
    pub window_start: i64,
    pub window_volume: u64,
    pub bump: u8,
    pub reserved: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct IdentityParams {
    pub tier: Tier,
    pub jurisdiction: u8,
    pub kyc_expiry: i64,
    pub lockup_until: i64,
}
