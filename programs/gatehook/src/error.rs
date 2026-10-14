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
    // Transfer hook rejections. Append only: codes are part of the client API.
    #[msg("Hook invoked outside of a Token-2022 transfer")]
    NotTransferring,
    #[msg("Config does not belong to this mint")]
    MintMismatch,
    #[msg("Transfers are paused for this mint")]
    Paused,
    #[msg("Amount exceeds the per-transfer cap")]
    AmountExceedsMax,
    #[msg("Sender has no identity in this registry")]
    SenderIdentityNotFound,
    #[msg("Recipient has no identity in this registry")]
    RecipientIdentityNotFound,
    #[msg("Sender identity is frozen")]
    SenderFrozen,
    #[msg("Recipient identity is frozen")]
    RecipientFrozen,
    #[msg("Sender KYC has expired")]
    SenderKycExpired,
    #[msg("Recipient KYC has expired")]
    RecipientKycExpired,
    #[msg("Sender tier is not allowed for this mint")]
    SenderTierNotAllowed,
    #[msg("Recipient tier is not allowed for this mint")]
    RecipientTierNotAllowed,
    #[msg("Sender jurisdiction is not allowed for this mint")]
    SenderJurisdictionNotAllowed,
    #[msg("Recipient jurisdiction is not allowed for this mint")]
    RecipientJurisdictionNotAllowed,
    #[msg("Reg S holders cannot transfer to US persons during the compliance period")]
    RegSRestricted,
    #[msg("Mint is in its issuance lockup period")]
    GlobalLockup,
    #[msg("Sender is in their holding period")]
    HolderLockup,
    #[msg("Transfer exceeds the sender's velocity limit")]
    VelocityLimitExceeded,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Signer is not the pending admin")]
    NotPendingAdmin,
}

/// `require!` for an error chosen at runtime (the macro only takes paths).
pub fn ensure(condition: bool, error: ComplianceError) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(error.into())
    }
}
