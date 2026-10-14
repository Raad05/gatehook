use anchor_lang::prelude::*;

#[constant]
pub const REGISTRY_SEED: &[u8] = b"registry";

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

#[constant]
pub const IDENTITY_SEED: &[u8] = b"identity";

/// Number of `Tier` variants; sizes per-tier arrays in `ComplianceConfig`.
pub const N_TIERS: usize = 6;

/// Jurisdiction index 0 means "unset" and is never allowed.
#[constant]
pub const JURISDICTION_UNSET: u8 = 0;

/// Internal jurisdiction index for the United States (ISO mapping lives in the SDK).
#[constant]
pub const JURISDICTION_US: u8 = 1;

pub const ACCOUNT_VERSION: u8 = 1;
