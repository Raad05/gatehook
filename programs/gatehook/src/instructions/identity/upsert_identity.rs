use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ComplianceError,
    state::{Identity, IdentityParams, Registry, Tier},
};

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct UpsertIdentity<'info> {
    pub oracle: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [REGISTRY_SEED, registry.issuer.as_ref()],
        bump = registry.bump,
        has_one = oracle @ ComplianceError::NotAdminOrOracle,
    )]
    pub registry: Account<'info, Registry>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Identity::INIT_SPACE,
        seeds = [IDENTITY_SEED, registry.key().as_ref(), wallet.as_ref()],
        bump
    )]
    pub identity: Account<'info, Identity>,
    pub system_program: Program<'info, System>,
}

/// Creates or refreshes an attestation. Freeze state and velocity counters
/// are preserved so an oracle refresh cannot undo an admin freeze.
pub fn handle_upsert_identity(
    ctx: Context<UpsertIdentity>,
    wallet: Pubkey,
    params: IdentityParams,
) -> Result<()> {
    require!(params.tier != Tier::None, ComplianceError::InvalidTier);
    require!(
        params.jurisdiction != JURISDICTION_UNSET,
        ComplianceError::InvalidJurisdiction
    );

    let identity = &mut ctx.accounts.identity;
    if identity.version == 0 {
        identity.version = ACCOUNT_VERSION;
        identity.registry = ctx.accounts.registry.key();
        identity.wallet = wallet;
        identity.bump = ctx.bumps.identity;
    }
    identity.tier = params.tier;
    identity.jurisdiction = params.jurisdiction;
    identity.kyc_expiry = params.kyc_expiry;
    identity.lockup_until = params.lockup_until;
    Ok(())
}
