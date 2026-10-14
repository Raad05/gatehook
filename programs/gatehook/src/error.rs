use anchor_lang::prelude::*;

#[error_code]
pub enum ComplianceError {
    #[msg("Signer is not the registry admin")]
    NotAdmin,
    #[msg("Signer is neither the registry admin nor the oracle")]
    NotAdminOrOracle,
    #[msg("Tier is not valid for this operation")]
    InvalidTier,
    #[msg("Jurisdiction is not valid")]
    InvalidJurisdiction,
    #[msg("Velocity window must be positive when a velocity limit is set")]
    InvalidVelocityWindow,
    #[msg("Account does not belong to this registry")]
    RegistryMismatch,
}
