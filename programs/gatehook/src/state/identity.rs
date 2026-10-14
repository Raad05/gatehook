use anchor_lang::prelude::*;

use crate::error::{ensure, ComplianceError};

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

impl Identity {
    /// Loads an identity passed as an unchecked hook account. Anchor's
    /// owner + discriminator check proves it is a real `Identity`; the field
    /// checks bind it to this registry and wallet without a PDA derivation.
    pub fn load(
        info: &AccountInfo,
        registry: &Pubkey,
        wallet: &Pubkey,
        not_found: ComplianceError,
    ) -> Result<Self> {
        ensure(info.owner == &crate::ID && !info.data_is_empty(), not_found)?;
        let identity = Self::try_deserialize(&mut &info.try_borrow_data()?[..])
            .map_err(|_| Error::from(not_found))?;
        ensure(
            identity.registry == *registry && identity.wallet == *wallet,
            not_found,
        )?;
        Ok(identity)
    }
}
