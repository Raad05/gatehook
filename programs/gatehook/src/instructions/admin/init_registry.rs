use anchor_lang::prelude::*;

use crate::{constants::*, state::Registry};

#[derive(Accounts)]
pub struct InitRegistry<'info> {
    /// Issuer; becomes the initial admin.
    #[account(mut)]
    pub issuer: Signer<'info>,
    #[account(
        init,
        payer = issuer,
        space = 8 + Registry::INIT_SPACE,
        seeds = [REGISTRY_SEED, issuer.key().as_ref()],
        bump
    )]
    pub registry: Account<'info, Registry>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_registry(ctx: Context<InitRegistry>, oracle: Pubkey) -> Result<()> {
    let issuer = ctx.accounts.issuer.key();
    ctx.accounts.registry.set_inner(Registry {
        version: ACCOUNT_VERSION,
        issuer,
        admin: issuer,
        oracle,
        bump: ctx.bumps.registry,
        pending_admin: Pubkey::default(),
        reserved: [0; 32],
    });
    Ok(())
}
