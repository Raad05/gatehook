use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ComplianceError,
    state::{ComplianceConfig, ComplianceRules, Registry},
};

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [REGISTRY_SEED, registry.issuer.as_ref()],
        bump = registry.bump,
        has_one = admin @ ComplianceError::NotAdmin,
    )]
    pub registry: Account<'info, Registry>,
    #[account(
        mut,
        seeds = [CONFIG_SEED, config.mint.as_ref()],
        bump = config.bump,
        has_one = registry @ ComplianceError::RegistryMismatch,
    )]
    pub config: Account<'info, ComplianceConfig>,
}

pub fn handle_update_config(ctx: Context<UpdateConfig>, rules: ComplianceRules) -> Result<()> {
    rules.validate()?;
    ctx.accounts.config.rules = rules;
    Ok(())
}
