use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, Token2022};
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

use crate::{
    constants::*,
    error::ComplianceError,
    state::{ComplianceConfig, Registry},
};

// Indices in the execute account list. 0-4 are fixed by the interface.
const SOURCE_INDEX: u8 = 0;
const MINT_INDEX: u8 = 1;
const DESTINATION_INDEX: u8 = 2;
const REGISTRY_INDEX: u8 = 6;
/// Offset of `owner` in an SPL token account.
const TOKEN_OWNER_OFFSET: u8 = 32;

#[derive(Accounts)]
pub struct InitExtraAccountMetas<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [REGISTRY_SEED, registry.issuer.as_ref()],
        bump = registry.bump,
        has_one = admin @ ComplianceError::NotAdmin,
    )]
    pub registry: Account<'info, Registry>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        seeds = [CONFIG_SEED, mint.key().as_ref()],
        bump = config.bump,
        has_one = registry @ ComplianceError::RegistryMismatch,
    )]
    pub config: Account<'info, ComplianceConfig>,
    /// CHECK: initialized below as a TLV `ExtraAccountMetaList`.
    #[account(
        init,
        payer = admin,
        space = ExtraAccountMetaList::size_of(extra_account_metas()?.len())?,
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

/// Accounts 5.. of `execute`: config, registry, sender identity, recipient
/// identity. Identities resolve from token-account owners, not the transfer
/// authority, so delegates cannot route around them.
pub fn extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
    let identity_of = |token_index: u8, writable: bool| {
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: IDENTITY_SEED.to_vec() },
                Seed::AccountKey { index: REGISTRY_INDEX },
                Seed::AccountData {
                    account_index: token_index,
                    data_index: TOKEN_OWNER_OFFSET,
                    length: 32,
                },
            ],
            false,
            writable,
        )
    };
    Ok(vec![
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: CONFIG_SEED.to_vec() },
                Seed::AccountKey { index: MINT_INDEX },
            ],
            false,
            false,
        )?,
        // Placeholder key; replaced with the mint's registry in the handler.
        ExtraAccountMeta::new_with_pubkey(&Pubkey::default(), false, false)?,
        identity_of(SOURCE_INDEX, true)?,
        identity_of(DESTINATION_INDEX, false)?,
    ])
}

pub fn handle_init_extra_account_metas(ctx: Context<InitExtraAccountMetas>) -> Result<()> {
    let mut metas = extra_account_metas()?;
    metas[1] = ExtraAccountMeta::new_with_pubkey(&ctx.accounts.registry.key(), false, false)?;
    let mut data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &metas)?;
    Ok(())
}
