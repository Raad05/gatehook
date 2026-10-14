//! One test per hook rejection reason, plus the boundary/exemption that
//! makes each rule pass.

mod common;

use {
    anchor_lang::{
        solana_program::instruction::{AccountMeta, Instruction},
        InstructionData,
    },
    common::{hook::*, *},
    gatehook::{error::ComplianceError as E, Tier},
    solana_signer::Signer,
};

const NOW: i64 = 1_700_000_000;
const DAY: i64 = 86_400;

fn fixture() -> HookFixture {
    let mut f = HookFixture::new(default_rules());
    f.ctx.set_time(NOW);
    f
}

fn params_with(
    tier: Tier,
    edit: impl FnOnce(&mut gatehook::IdentityParams),
) -> gatehook::IdentityParams {
    let mut p = identity_params(tier);
    edit(&mut p);
    p
}

// ---- per-transfer cap ----

#[test]
fn max_tx_amount_is_inclusive() {
    let mut rules = default_rules();
    rules.max_tx_amount = 100;
    let mut f = HookFixture::new(rules);
    let a = f.kyc_holder(1_000);
    let b = f.kyc_holder(0);

    f.transfer(&a, &b, 100).unwrap();
    assert_err(f.transfer(&a, &b, 101), E::AmountExceedsMax);
}

// ---- freeze ----

#[test]
fn frozen_recipient_rejected() {
    let mut f = fixture();
    let a = f.kyc_holder(1_000);
    let b = f.kyc_holder(0);
    let issuer = f.issuer();
    f.admin_send(
        f.ctx
            .set_identity_frozen_ix(&issuer.pubkey(), &b.wallet.pubkey(), true),
    );

    assert_err(f.transfer(&a, &b, 1), E::RecipientFrozen);
}

#[test]
fn frozen_sender_rejected_until_unfrozen() {
    let mut f = fixture();
    let a = f.kyc_holder(1_000);
    let b = f.kyc_holder(0);
    let issuer = f.issuer();
    f.admin_send(
        f.ctx
            .set_identity_frozen_ix(&issuer.pubkey(), &a.wallet.pubkey(), true),
    );
    assert_err(f.transfer(&a, &b, 1), E::SenderFrozen);

    f.admin_send(
        f.ctx
            .set_identity_frozen_ix(&issuer.pubkey(), &a.wallet.pubkey(), false),
    );
    f.transfer(&a, &b, 1).unwrap();
}

// ---- KYC expiry ----

#[test]
fn sender_kyc_expires_at_expiry_timestamp() {
    let mut f = fixture();
    let a = f.holder(
        params_with(Tier::RegDAccredited, |p| p.kyc_expiry = NOW + DAY),
        1_000,
    );
    let b = f.kyc_holder(0);

    f.ctx.set_time(NOW + DAY - 1);
    f.transfer(&a, &b, 1).unwrap();
    f.ctx.set_time(NOW + DAY);
    assert_err(f.transfer(&a, &b, 1), E::SenderKycExpired);
}

#[test]
fn recipient_kyc_expired_rejected() {
    let mut f = fixture();
    let a = f.kyc_holder(1_000);
    let b = f.holder(
        params_with(Tier::RegDAccredited, |p| p.kyc_expiry = NOW - 1),
        0,
    );

    assert_err(f.transfer(&a, &b, 1), E::RecipientKycExpired);
}

#[test]
fn oracle_refresh_restores_expired_kyc() {
    let mut f = fixture();
    let a = f.holder(
        params_with(Tier::RegDAccredited, |p| p.kyc_expiry = NOW - 1),
        1_000,
    );
    let b = f.kyc_holder(0);
    assert_err(f.transfer(&a, &b, 1), E::SenderKycExpired);

    f.upsert(&a.wallet.pubkey(), identity_params(Tier::RegDAccredited));
    f.transfer(&a, &b, 1).unwrap();
}

// ---- tiers ----

#[test]
fn sender_tier_not_allowed() {
    let mut rules = default_rules();
    rules.allowed_tiers = 1 << Tier::RegDAccredited as u8;
    let mut f = HookFixture::new(rules);
    let a = f.holder(identity_params(Tier::QualifiedPurchaser), 1_000);
    let b = f.kyc_holder(0);

    assert_err(f.transfer(&a, &b, 1), E::SenderTierNotAllowed);
}

#[test]
fn recipient_tier_not_allowed() {
    let mut rules = default_rules();
    rules.allowed_tiers = 1 << Tier::RegDAccredited as u8;
    let mut f = HookFixture::new(rules);
    let a = f.kyc_holder(1_000);
    let b = f.holder(identity_params(Tier::QualifiedPurchaser), 0);

    assert_err(f.transfer(&a, &b, 1), E::RecipientTierNotAllowed);
}

#[test]
fn tier_allowlist_change_applies_immediately() {
    let mut f = fixture();
    let a = f.kyc_holder(1_000);
    let b = f.holder(identity_params(Tier::QualifiedPurchaser), 0);
    f.transfer(&a, &b, 1).unwrap();

    let mut rules = default_rules();
    rules.allowed_tiers &= !(1 << Tier::QualifiedPurchaser as u8);
    f.update_rules(rules);
    assert_err(f.transfer(&a, &b, 1), E::RecipientTierNotAllowed);
}

// ---- jurisdictions ----

#[test]
fn sender_jurisdiction_not_allowed() {
    let mut f = fixture();
    let a = f.holder(
        params_with(Tier::RegDAccredited, |p| p.jurisdiction = 77),
        1_000,
    );
    let b = f.kyc_holder(0);

    assert_err(f.transfer(&a, &b, 1), E::SenderJurisdictionNotAllowed);
}

#[test]
fn recipient_jurisdiction_not_allowed() {
    let mut f = fixture();
    let a = f.kyc_holder(1_000);
    let b = f.holder(
        params_with(Tier::RegDAccredited, |p| p.jurisdiction = 200),
        0,
    );

    assert_err(f.transfer(&a, &b, 1), E::RecipientJurisdictionNotAllowed);
}

// ---- Reg S ----

fn reg_s_fixture() -> (HookFixture, Holder, Holder, Holder) {
    let mut rules = default_rules();
    rules.reg_s_compliance_until = NOW + 40 * DAY;
    let mut f = HookFixture::new(rules);
    f.ctx.set_time(NOW);
    let reg_s = f.holder(
        params_with(Tier::RegSNonUs, |p| p.jurisdiction = JURISDICTION_DE),
        1_000,
    );
    let us = f.kyc_holder(0);
    let de = f.holder(
        params_with(Tier::RegSNonUs, |p| p.jurisdiction = JURISDICTION_DE),
        0,
    );
    (f, reg_s, us, de)
}

#[test]
fn reg_s_to_us_rejected_during_compliance_period() {
    let (mut f, reg_s, us, _) = reg_s_fixture();
    assert_err(f.transfer(&reg_s, &us, 1), E::RegSRestricted);
}

#[test]
fn reg_s_to_non_us_allowed_during_compliance_period() {
    let (mut f, reg_s, _, de) = reg_s_fixture();
    f.transfer(&reg_s, &de, 1).unwrap();
}

#[test]
fn reg_s_to_us_allowed_after_compliance_period() {
    let (mut f, reg_s, us, _) = reg_s_fixture();
    f.ctx.set_time(NOW + 40 * DAY);
    f.transfer(&reg_s, &us, 1).unwrap();
}

#[test]
fn reg_d_to_us_unaffected_by_reg_s_period() {
    let (mut f, _, us, _) = reg_s_fixture();
    let reg_d = f.kyc_holder(1_000);
    f.transfer(&reg_d, &us, 1).unwrap();
}

// ---- lockups ----

#[test]
fn global_lockup_blocks_until_timestamp() {
    let mut rules = default_rules();
    rules.lockup_until = NOW + DAY;
    let mut f = HookFixture::new(rules);
    f.ctx.set_time(NOW);
    let a = f.kyc_holder(1_000);
    let b = f.kyc_holder(0);

    assert_err(f.transfer(&a, &b, 1), E::GlobalLockup);
    f.ctx.set_time(NOW + DAY);
    f.transfer(&a, &b, 1).unwrap();
}

#[test]
fn holder_lockup_blocks_until_timestamp() {
    let mut f = fixture();
    let a = f.holder(
        params_with(Tier::RegDAccredited, |p| p.lockup_until = NOW + 180 * DAY),
        1_000,
    );
    let b = f.kyc_holder(0);

    assert_err(f.transfer(&a, &b, 1), E::HolderLockup);
    f.ctx.set_time(NOW + 180 * DAY);
    f.transfer(&a, &b, 1).unwrap();
}

#[test]
fn holder_lockup_does_not_block_receiving() {
    let mut f = fixture();
    let a = f.kyc_holder(1_000);
    let b = f.holder(
        params_with(Tier::RegDAccredited, |p| p.lockup_until = NOW + DAY),
        0,
    );

    f.transfer(&a, &b, 1).unwrap();
}

#[test]
fn issuer_exempt_from_lockups() {
    let mut rules = default_rules();
    rules.lockup_until = NOW + DAY;
    let mut f = HookFixture::new(rules);
    f.ctx.set_time(NOW);
    let treasury = f.holder(
        params_with(Tier::Issuer, |p| p.lockup_until = NOW + DAY),
        1_000,
    );
    let b = f.kyc_holder(0);

    f.transfer(&treasury, &b, 1).unwrap();
    assert_err(f.transfer(&b, &treasury, 1), E::GlobalLockup);
}

// ---- velocity ----

#[test]
fn velocity_limits_are_per_tier() {
    let mut rules = default_rules();
    rules.velocity_limit_per_tier[Tier::RegDAccredited as usize] = 10;
    let mut f = HookFixture::new(rules);
    f.ctx.set_time(NOW);
    let reg_d = f.kyc_holder(1_000);
    let qp = f.holder(identity_params(Tier::QualifiedPurchaser), 1_000);
    let b = f.kyc_holder(0);

    assert_err(f.transfer(&reg_d, &b, 11), E::VelocityLimitExceeded);
    // QP has no limit (0) and its counters are never touched.
    f.transfer(&qp, &b, 1_000).unwrap();
    let qp_identity = f.identity(&qp.wallet.pubkey());
    assert_eq!(
        (qp_identity.window_start, qp_identity.window_volume),
        (0, 0)
    );
}

#[test]
fn velocity_counts_only_sent_volume() {
    let mut rules = default_rules();
    rules.velocity_limit_per_tier[Tier::RegDAccredited as usize] = 100;
    let mut f = HookFixture::new(rules);
    f.ctx.set_time(NOW);
    let a = f.kyc_holder(1_000);
    let b = f.kyc_holder(1_000);

    f.transfer(&b, &a, 100).unwrap();
    // Receiving 100 doesn't consume A's allowance.
    f.transfer(&a, &b, 100).unwrap();
    assert_eq!(f.identity(&a.wallet.pubkey()).window_volume, 100);
}

#[test]
fn velocity_window_is_rolling_from_first_transfer() {
    let mut rules = default_rules();
    rules.velocity_window_secs = DAY;
    rules.velocity_limit_per_tier[Tier::RegDAccredited as usize] = 100;
    let mut f = HookFixture::new(rules);
    f.ctx.set_time(NOW);
    let a = f.kyc_holder(1_000);
    let b = f.kyc_holder(0);

    f.transfer(&a, &b, 60).unwrap();
    f.ctx.set_time(NOW + DAY - 1);
    assert_err(f.transfer(&a, &b, 41), E::VelocityLimitExceeded);
    f.transfer(&a, &b, 40).unwrap();
    f.ctx.set_time(NOW + DAY);
    f.transfer(&a, &b, 100).unwrap();
    assert_eq!(f.identity(&a.wallet.pubkey()).window_start, NOW + DAY);
}

// ---- identity edge cases ----

#[test]
fn revoked_identity_rejected() {
    let mut f = fixture();
    let a = f.kyc_holder(1_000);
    let b = f.kyc_holder(0);
    let issuer = f.issuer();
    f.admin_send(
        f.ctx
            .revoke_identity_ix(&issuer.pubkey(), &b.wallet.pubkey()),
    );

    assert_err(f.transfer(&a, &b, 1), E::RecipientIdentityNotFound);
}

#[test]
fn identity_of_other_wallet_rejected() {
    // Same registry, but the planted record attests a different wallet.
    let mut f = fixture();
    let a = f.kyc_holder(1_000);
    let b = f.holder_without_identity(0);
    let c = f.kyc_holder(0);
    let c_account = f
        .ctx
        .svm
        .get_account(&identity_pda(&f.ctx.registry, &c.wallet.pubkey()))
        .unwrap();
    f.ctx
        .svm
        .set_account(identity_pda(&f.ctx.registry, &b.wallet.pubkey()), c_account)
        .unwrap();

    assert_err(f.transfer(&a, &b, 1), E::RecipientIdentityNotFound);
}

#[test]
fn self_transfer_between_own_accounts() {
    let mut f = fixture();
    let a = f.kyc_holder(1_000);
    let a2 = Holder {
        wallet: a.wallet.insecure_clone(),
        token: f.ctx.create_token_account(&f.mint, &a.wallet.pubkey()),
    };

    f.transfer(&a, &a2, 250).unwrap();
    assert_eq!(f.ctx.token_balance(&a2.token), 250);
}

// ---- account substitution (direct calls; Anchor constraints run first) ----

fn direct_execute(
    f: &mut HookFixture,
    from: &Holder,
    to: &Holder,
    edit: impl FnOnce(&mut Vec<AccountMeta>),
) -> Result<(), String> {
    let extras = f
        .ctx
        .hook_extra_metas(&f.mint, &from.wallet.pubkey(), &to.wallet.pubkey());
    let mut accounts = vec![
        AccountMeta::new_readonly(from.token, false),
        AccountMeta::new_readonly(f.mint, false),
        AccountMeta::new_readonly(to.token, false),
        AccountMeta::new_readonly(from.wallet.pubkey(), true),
        extras[5].clone(),
    ];
    accounts.extend_from_slice(&extras[..4]);
    edit(&mut accounts);
    let ix = Instruction::new_with_bytes(
        gatehook::id(),
        &gatehook::instruction::Execute { amount: 1 }.data(),
        accounts,
    );
    let signer = from.wallet.insecure_clone();
    f.ctx.send(&[ix], &[&signer])
}

#[test]
fn config_of_other_mint_rejected() {
    let mut f = fixture();
    let a = f.kyc_holder(1_000);
    let b = f.kyc_holder(0);
    let issuer = f.issuer();
    let other_mint = f.ctx.create_hook_mint(&issuer.pubkey(), &gatehook::id());
    f.admin_send(
        f.ctx
            .init_mint_config_ix(&issuer.pubkey(), &other_mint, default_rules()),
    );

    let res = direct_execute(&mut f, &a, &b, |acc| {
        acc[5] = AccountMeta::new_readonly(config_pda(&other_mint), false);
    });
    assert_err(res, E::MintMismatch);
}

#[test]
fn registry_not_matching_config_rejected() {
    let mut f = fixture();
    let a = f.kyc_holder(1_000);
    let b = f.kyc_holder(0);
    let other = Ctx::new();
    let other_registry = other.registry;
    let account = other.svm.get_account(&other_registry).unwrap();
    f.ctx.svm.set_account(other_registry, account).unwrap();

    let res = direct_execute(&mut f, &a, &b, |acc| {
        acc[6] = AccountMeta::new_readonly(other_registry, false);
    });
    assert_err(res, E::RegistryMismatch);
}

// ---- compute budget ----

/// Hook runs inside every transfer, including multi-hop swaps; keep the
/// whole transfer well under the default 200k per-instruction budget.
const MAX_TRANSFER_CU: u64 = 60_000;

#[test]
fn transfer_with_velocity_stays_within_cu_budget() {
    let mut rules = default_rules();
    rules.max_tx_amount = 1_000;
    rules.velocity_limit_per_tier[Tier::RegDAccredited as usize] = 1_000;
    rules.reg_s_compliance_until = NOW + DAY;
    let mut f = HookFixture::new(rules);
    f.ctx.set_time(NOW);
    let a = f.kyc_holder(1_000);
    let b = f.kyc_holder(0);

    let ix = f.transfer_ix(&a, &b, 10);
    let signer = a.wallet.insecure_clone();
    let cu = f.ctx.send_cu(&[ix], &[&signer]).unwrap();
    println!("transfer_checked + hook: {cu} CU");
    assert!(cu <= MAX_TRANSFER_CU, "{cu} CU > {MAX_TRANSFER_CU}");
}
