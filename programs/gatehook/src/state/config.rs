use anchor_lang::prelude::*;

use crate::{constants::*, error::ComplianceError, state::Tier};

/// Per-mint compliance rules evaluated by the transfer hook.
#[account]
#[derive(InitSpace)]
pub struct ComplianceConfig {
    pub version: u8,
    pub registry: Pubkey,
    pub mint: Pubkey,
    pub paused: bool,
    pub rules: ComplianceRules,
    pub bump: u8,
    pub reserved: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct ComplianceRules {
    /// Max amount per transfer; 0 = no cap.
    pub max_tx_amount: u64,
    pub velocity_window_secs: i64,
    /// Max volume per window, indexed by `Tier as usize`; 0 = no limit.
    pub velocity_limit_per_tier: [u64; N_TIERS],
    /// No transfers before this unix timestamp (issuer exempt).
    pub lockup_until: i64,
    /// Until this timestamp, Reg S holders cannot transfer to US recipients.
    pub reg_s_compliance_until: i64,
    /// 256-bit bitmap over jurisdiction indices.
    pub allowed_jurisdictions: [u64; 4],
    /// Bitmap over `Tier as u8`.
    pub allowed_tiers: u8,
}

impl ComplianceRules {
    pub fn validate(&self) -> Result<()> {
        if self.velocity_limit_per_tier.iter().any(|l| *l > 0) {
            require!(
                self.velocity_window_secs > 0,
                ComplianceError::InvalidVelocityWindow
            );
        }
        Ok(())
    }

    pub fn jurisdiction_allowed(&self, jurisdiction: u8) -> bool {
        jurisdiction != JURISDICTION_UNSET
            && self.allowed_jurisdictions[(jurisdiction / 64) as usize]
                & (1u64 << (jurisdiction % 64))
                != 0
    }

    pub fn tier_allowed(&self, tier: Tier) -> bool {
        tier != Tier::None && self.allowed_tiers & (1u8 << tier as u8) != 0
    }
}
