use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, Token2022};

use crate::{
    constants::*,
    error::ComplianceError,
    state::{ComplianceConfig, ComplianceRules, Registry},
};

#[derive(Accounts)]
pub struct InitMintConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [REGISTRY_SEED, registry.issuer.as_ref()],
        bump = registry.bump,
        has_one = admin @ ComplianceError::NotAdmin,
    )]
    pub registry: Account<'info, Registry>,
    /// Must point its transfer hook at this program, with the admin as hook
    /// authority, so nobody can attach a config to someone else's mint.
    #[account(
        mint::token_program = token_program,
        extensions::transfer_hook::authority = admin,
        extensions::transfer_hook::program_id = crate::ID,
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = admin,
        space = 8 + ComplianceConfig::INIT_SPACE,
        seeds = [CONFIG_SEED, mint.key().as_ref()],
        bump
    )]
    pub config: Account<'info, ComplianceConfig>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_mint_config(ctx: Context<InitMintConfig>, rules: ComplianceRules) -> Result<()> {
    rules.validate()?;
    ctx.accounts.config.set_inner(ComplianceConfig {
        version: ACCOUNT_VERSION,
        registry: ctx.accounts.registry.key(),
        mint: ctx.accounts.mint.key(),
        paused: false,
        rules,
        bump: ctx.bumps.config,
        reserved: [0; 64],
    });
    Ok(())
}
