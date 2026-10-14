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

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(jurisdictions: &[u8], tiers: &[Tier]) -> ComplianceRules {
        let mut allowed_jurisdictions = [0u64; 4];
        for j in jurisdictions {
            allowed_jurisdictions[(*j / 64) as usize] |= 1 << (*j % 64);
        }
        ComplianceRules {
            max_tx_amount: 0,
            velocity_window_secs: 0,
            velocity_limit_per_tier: [0; N_TIERS],
            lockup_until: 0,
            reg_s_compliance_until: 0,
            allowed_jurisdictions,
            allowed_tiers: tiers.iter().fold(0, |acc, t| acc | 1 << *t as u8),
        }
    }

    #[test]
    fn jurisdiction_bitmap_word_boundaries() {
        let r = rules(&[1, 63, 64, 127, 128, 255], &[]);
        for j in [1, 63, 64, 127, 128, 255] {
            assert!(r.jurisdiction_allowed(j), "{j}");
        }
        for j in [2, 62, 65, 126, 129, 254] {
            assert!(!r.jurisdiction_allowed(j), "{j}");
        }
    }

    #[test]
    fn unset_jurisdiction_never_allowed() {
        let r = rules(&[0, 1], &[]);
        assert!(!r.jurisdiction_allowed(JURISDICTION_UNSET));
    }

    #[test]
    fn tier_bitmap() {
        let r = rules(&[], &[Tier::RegDAccredited, Tier::Venue]);
        assert!(r.tier_allowed(Tier::RegDAccredited));
        assert!(r.tier_allowed(Tier::Venue));
        assert!(!r.tier_allowed(Tier::RegSNonUs));
        assert!(!r.tier_allowed(Tier::Issuer));
    }

    #[test]
    fn tier_none_never_allowed() {
        let r = rules(&[], &[Tier::None, Tier::RegDAccredited]);
        assert!(!r.tier_allowed(Tier::None));
    }

    #[test]
    fn velocity_limit_requires_window() {
        let mut r = rules(&[], &[]);
        assert!(r.validate().is_ok());
        r.velocity_limit_per_tier[1] = 1;
        assert!(r.validate().is_err());
        r.velocity_window_secs = 1;
        assert!(r.validate().is_ok());
    }
}
