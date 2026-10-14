use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ComplianceError,
    state::{Identity, Registry},
};

#[derive(Accounts)]
pub struct ModifyIdentity<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [REGISTRY_SEED, registry.issuer.as_ref()],
        bump = registry.bump,
        constraint = authority.key() == registry.admin
            || authority.key() == registry.oracle @ ComplianceError::NotAdminOrOracle,
    )]
    pub registry: Account<'info, Registry>,
    #[account(
        mut,
        seeds = [IDENTITY_SEED, registry.key().as_ref(), identity.wallet.as_ref()],
        bump = identity.bump,
        has_one = registry @ ComplianceError::RegistryMismatch,
    )]
    pub identity: Account<'info, Identity>,
}

pub fn handle_set_identity_frozen(ctx: Context<ModifyIdentity>, frozen: bool) -> Result<()> {
    ctx.accounts.identity.frozen = frozen;
    Ok(())
}
