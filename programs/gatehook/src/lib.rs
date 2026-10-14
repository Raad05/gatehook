pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use spl_discriminator::SplDiscriminate;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

pub use constants::*;
pub use instructions::{admin::*, hook::*, identity::*};
pub use state::{config::*, identity::*, registry::*};

declare_id!("HbNmR9zK6d4BMBgzEWixgp6L3QZh4aP66Am13MXsBkaA");

#[program]
pub mod gatehook {
    use super::*;

    pub fn init_registry(ctx: Context<InitRegistry>, oracle: Pubkey) -> Result<()> {
        crate::instructions::admin::init_registry::handle_init_registry(ctx, oracle)
    }

    pub fn set_oracle(ctx: Context<SetOracle>, oracle: Pubkey) -> Result<()> {
        crate::instructions::admin::set_oracle::handle_set_oracle(ctx, oracle)
    }

    pub fn propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
        crate::instructions::admin::admin_transfer::handle_propose_admin(ctx, new_admin)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        crate::instructions::admin::admin_transfer::handle_accept_admin(ctx)
    }

    pub fn init_mint_config(ctx: Context<InitMintConfig>, rules: ComplianceRules) -> Result<()> {
        crate::instructions::admin::init_mint_config::handle_init_mint_config(ctx, rules)
    }

    pub fn update_config(ctx: Context<UpdateConfig>, rules: ComplianceRules) -> Result<()> {
        crate::instructions::admin::update_config::handle_update_config(ctx, rules)
    }

    pub fn set_pause(ctx: Context<UpdateConfig>, paused: bool) -> Result<()> {
        crate::instructions::admin::set_pause::handle_set_pause(ctx, paused)
    }

    pub fn upsert_identity(
        ctx: Context<UpsertIdentity>,
        wallet: Pubkey,
        params: IdentityParams,
    ) -> Result<()> {
        crate::instructions::identity::upsert_identity::handle_upsert_identity(ctx, wallet, params)
    }

    pub fn set_identity_frozen(ctx: Context<ModifyIdentity>, frozen: bool) -> Result<()> {
        crate::instructions::identity::set_identity_frozen::handle_set_identity_frozen(ctx, frozen)
    }

    pub fn revoke_identity(ctx: Context<ModifyIdentity>) -> Result<()> {
        crate::instructions::identity::revoke_identity::handle_revoke_identity(ctx)
    }

    pub fn init_extra_account_metas(ctx: Context<InitExtraAccountMetas>) -> Result<()> {
        crate::instructions::hook::init_extra_account_metas::handle_init_extra_account_metas(ctx)
    }

    /// Transfer hook entrypoint, CPI'd by Token-2022 on every `transfer_checked`.
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
        crate::instructions::hook::execute::handle_execute(ctx, amount)
    }
}
