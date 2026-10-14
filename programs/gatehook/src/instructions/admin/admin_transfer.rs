use anchor_lang::prelude::*;

use crate::{constants::*, error::ComplianceError, state::Registry};

/// Two-step admin rotation (e.g. hot key -> multisig): the current admin
/// proposes, the new admin accepts. A typo'd key can never take over.
#[derive(Accounts)]
pub struct ProposeAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [REGISTRY_SEED, registry.issuer.as_ref()],
        bump = registry.bump,
        has_one = admin @ ComplianceError::NotAdmin,
    )]
    pub registry: Account<'info, Registry>,
}

/// `new_admin = Pubkey::default()` cancels a pending proposal.
pub fn handle_propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.registry.pending_admin = new_admin;
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(
        mut,
        seeds = [REGISTRY_SEED, registry.issuer.as_ref()],
        bump = registry.bump,
        constraint = registry.pending_admin == new_admin.key()
            && registry.pending_admin != Pubkey::default() @ ComplianceError::NotPendingAdmin,
    )]
    pub registry: Account<'info, Registry>,
}

pub fn handle_accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    registry.admin = ctx.accounts.new_admin.key();
    registry.pending_admin = Pubkey::default();
    Ok(())
}
