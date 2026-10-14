use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::spl_token_2022::{
        extension::{transfer_hook::TransferHookAccount, BaseStateWithExtensions, StateWithExtensions},
        state::Account as SplTokenAccount,
    },
    token_interface::{Mint, TokenAccount},
};

use crate::{
    constants::*,
    error::{ensure, ComplianceError},
    state::{ComplianceConfig, ComplianceRules, Identity, Registry, Tier},
};

/// Account order is fixed by the transfer hook interface (0-4) and by the
/// mint's `ExtraAccountMetaList` (5-8).
#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(token::mint = mint)]
    pub source_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = mint)]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: transfer authority (owner or delegate); validated by Token-2022.
    pub authority: UncheckedAccount<'info>,
    /// CHECK: not read; Token-2022 resolved the extra accounts from it.
    pub extra_account_meta_list: UncheckedAccount<'info>,
    #[account(has_one = mint @ ComplianceError::MintMismatch)]
    pub config: Account<'info, ComplianceConfig>,
    #[account(address = config.registry @ ComplianceError::RegistryMismatch)]
    pub registry: Account<'info, Registry>,
    /// CHECK: loaded and validated by `Identity::load`.
    #[account(mut)]
    pub sender_identity: UncheckedAccount<'info>,
    /// CHECK: loaded and validated by `Identity::load`.
    pub recipient_identity: UncheckedAccount<'info>,
}

#[event]
pub struct TransferApproved {
    pub mint: Pubkey,
    pub from: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
    /// Admin moved tokens as delegate (permanent-delegate clawback).
    pub forced: bool,
}

pub fn handle_execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
    let accounts = &ctx.accounts;
    require!(is_transferring(&accounts.source_token)?, ComplianceError::NotTransferring);

    let from = accounts.source_token.owner;
    let to = accounts.destination_token.owner;
    let authority = accounts.authority.key();

    // Admin acting as delegate over someone else's tokens (permanent-delegate
    // clawback / court-ordered recovery) bypasses holder rules.
    let forced = authority == accounts.registry.admin && authority != from;
    if !forced {
        let registry = accounts.registry.key();
        let mut sender = Identity::load(
            &accounts.sender_identity,
            &registry,
            &from,
            ComplianceError::SenderIdentityNotFound,
        )?;
        let recipient = Identity::load(
            &accounts.recipient_identity,
            &registry,
            &to,
            ComplianceError::RecipientIdentityNotFound,
        )?;
        let now = Clock::get()?.unix_timestamp;

        if check_transfer(&accounts.config, &mut sender, &recipient, amount, now)? {
            sender.try_serialize(&mut &mut accounts.sender_identity.try_borrow_mut_data()?[..])?;
        }
    }

    emit!(TransferApproved {
        mint: accounts.mint.key(),
        from,
        to,
        amount,
        forced,
    });
    Ok(())
}

/// Evaluates all rules. Returns whether `sender` velocity state changed and
/// must be written back.
fn check_transfer(
    config: &ComplianceConfig,
    sender: &mut Identity,
    recipient: &Identity,
    amount: u64,
    now: i64,
) -> Result<bool> {
    let rules = &config.rules;
    require!(!config.paused, ComplianceError::Paused);
    if rules.max_tx_amount > 0 {
        require!(amount <= rules.max_tx_amount, ComplianceError::AmountExceedsMax);
    }

    check_holder(
        rules,
        sender,
        now,
        [
            ComplianceError::SenderFrozen,
            ComplianceError::SenderKycExpired,
            ComplianceError::SenderTierNotAllowed,
            ComplianceError::SenderJurisdictionNotAllowed,
        ],
    )?;
    check_holder(
        rules,
        recipient,
        now,
        [
            ComplianceError::RecipientFrozen,
            ComplianceError::RecipientKycExpired,
            ComplianceError::RecipientTierNotAllowed,
            ComplianceError::RecipientJurisdictionNotAllowed,
        ],
    )?;

    if sender.tier == Tier::RegSNonUs && now < rules.reg_s_compliance_until {
        require!(
            recipient.jurisdiction != JURISDICTION_US,
            ComplianceError::RegSRestricted
        );
    }

    if sender.tier != Tier::Issuer {
        require!(now >= rules.lockup_until, ComplianceError::GlobalLockup);
        require!(now >= sender.lockup_until, ComplianceError::HolderLockup);
    }

    let limit = rules.velocity_limit_per_tier[sender.tier as usize];
    if limit == 0 {
        return Ok(false);
    }
    if now.saturating_sub(sender.window_start) >= rules.velocity_window_secs {
        sender.window_start = now;
        sender.window_volume = 0;
    }
    let volume = sender
        .window_volume
        .checked_add(amount)
        .ok_or(ComplianceError::MathOverflow)?;
    require!(volume <= limit, ComplianceError::VelocityLimitExceeded);
    sender.window_volume = volume;
    Ok(true)
}

/// `errors` = [frozen, kyc expired, tier, jurisdiction] for this side.
fn check_holder(
    rules: &ComplianceRules,
    holder: &Identity,
    now: i64,
    errors: [ComplianceError; 4],
) -> Result<()> {
    let [frozen, expired, tier, jurisdiction] = errors;
    ensure(!holder.frozen, frozen)?;
    ensure(holder.kyc_expiry > now, expired)?;
    ensure(rules.tier_allowed(holder.tier), tier)?;
    ensure(rules.jurisdiction_allowed(holder.jurisdiction), jurisdiction)
}

/// Token-2022 sets `transferring` on the source account only for the
/// duration of a hooked transfer; rejects direct calls to `execute`.
fn is_transferring(source: &InterfaceAccount<TokenAccount>) -> Result<bool> {
    let info = source.to_account_info();
    let data = info.try_borrow_data()?;
    let state = StateWithExtensions::<SplTokenAccount>::unpack(&data)?;
    let ext = state
        .get_extension::<TransferHookAccount>()
        .map_err(|_| error!(ComplianceError::NotTransferring))?;
    Ok(bool::from(ext.transferring))
}
