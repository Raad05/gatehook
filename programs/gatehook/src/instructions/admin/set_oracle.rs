use anchor_lang::prelude::*;

use crate::{constants::*, error::ComplianceError, state::Registry};

#[derive(Accounts)]
pub struct SetOracle<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [REGISTRY_SEED, registry.issuer.as_ref()],
        bump = registry.bump,
        has_one = admin @ ComplianceError::NotAdmin,
    )]
    pub registry: Account<'info, Registry>,
}

pub fn handle_set_oracle(ctx: Context<SetOracle>, oracle: Pubkey) -> Result<()> {
    ctx.accounts.registry.oracle = oracle;
    Ok(())
}
