mod common;

use {
    anchor_lang::{
        solana_program::instruction::{AccountMeta, Instruction},
        InstructionData,
    },
    anchor_spl::token_2022::spl_token_2022,
    common::{hook::*, *},
    gatehook::{error::ComplianceError, Identity, Tier},
    solana_keypair::Keypair,
    solana_signer::Signer,
};

#[test]
fn compliant_transfer_succeeds() {
    let mut f = HookFixture::new(default_rules());
    let alice = f.kyc_holder(1_000);
    let bob = f.kyc_holder(0);

    f.transfer(&alice, &bob, 400).unwrap();

    assert_eq!(f.ctx.token_balance(&alice.token), 600);
    assert_eq!(f.ctx.token_balance(&bob.token), 400);
}

#[test]
fn transfer_to_wallet_without_identity_fails() {
    let mut f = HookFixture::new(default_rules());
    let alice = f.kyc_holder(1_000);
    let mallory = f.holder_without_identity(0);

    let err = f.transfer(&alice, &mallory, 1).unwrap_err();
    assert!(
        err.contains(&code(ComplianceError::RecipientIdentityNotFound)),
        "{err}"
    );
}

#[test]
fn transfer_from_wallet_without_identity_fails() {
    let mut f = HookFixture::new(default_rules());
    let mallory = f.holder_without_identity(1_000);
    let bob = f.kyc_holder(0);

    let err = f.transfer(&mallory, &bob, 1).unwrap_err();
    assert!(
        err.contains(&code(ComplianceError::SenderIdentityNotFound)),
        "{err}"
    );
}

#[test]
fn identity_from_other_registry_is_rejected() {
    // A second issuer's oracle attests Bob; that must not count for this mint.
    let mut f = HookFixture::new(default_rules());
    let alice = f.kyc_holder(1_000);
    let bob = f.holder_without_identity(0);

    let mut other = Ctx::new();
    let other_oracle = other.oracle.insecure_clone();
    let ix = other.upsert_identity_ix(
        &other_oracle.pubkey(),
        bob.wallet.pubkey(),
        identity_params(Tier::RegDAccredited),
    );
    other.send(&[ix], &[&other_oracle]).unwrap();
    let foreign = identity_pda(&other.registry, &bob.wallet.pubkey());
    let account = other.svm.get_account(&foreign).unwrap();
    // Plant the foreign identity at the address the hook resolves for Bob.
    f.ctx
        .svm
        .set_account(identity_pda(&f.ctx.registry, &bob.wallet.pubkey()), account)
        .unwrap();

    let err = f.transfer(&alice, &bob, 1).unwrap_err();
    assert!(
        err.contains(&code(ComplianceError::RecipientIdentityNotFound)),
        "{err}"
    );
}

#[test]
fn direct_execute_call_is_rejected() {
    let mut f = HookFixture::new(default_rules());
    let alice = f.kyc_holder(1_000);
    let bob = f.kyc_holder(0);

    let mut accounts = vec![
        AccountMeta::new_readonly(alice.token, false),
        AccountMeta::new_readonly(f.mint, false),
        AccountMeta::new_readonly(bob.token, false),
        AccountMeta::new_readonly(alice.wallet.pubkey(), true),
    ];
    let extras = f
        .ctx
        .hook_extra_metas(&f.mint, &alice.wallet.pubkey(), &bob.wallet.pubkey());
    accounts.push(extras[5].clone()); // validation account at index 4
    accounts.extend_from_slice(&extras[..4]);
    let ix = Instruction::new_with_bytes(
        gatehook::id(),
        &gatehook::instruction::Execute { amount: 1 }.data(),
        accounts,
    );
    let signer = alice.wallet.insecure_clone();
    let err = f.ctx.send(&[ix], &[&signer]).unwrap_err();
    assert!(
        err.contains(&code(ComplianceError::NotTransferring)),
        "{err}"
    );
}

#[test]
fn paused_mint_rejects_transfers() {
    let mut f = HookFixture::new(default_rules());
    let alice = f.kyc_holder(1_000);
    let bob = f.kyc_holder(0);
    let issuer = f.issuer();

    f.admin_send(f.ctx.set_pause_ix(&issuer.pubkey(), &f.mint, true));
    let err = f.transfer(&alice, &bob, 1).unwrap_err();
    assert!(err.contains(&code(ComplianceError::Paused)), "{err}");

    f.admin_send(f.ctx.set_pause_ix(&issuer.pubkey(), &f.mint, false));
    f.transfer(&alice, &bob, 1).unwrap();
}

#[test]
fn velocity_limit_tracks_and_resets_window() {
    let mut rules = default_rules();
    rules.velocity_window_secs = 3_600;
    rules.velocity_limit_per_tier[Tier::RegDAccredited as usize] = 500;
    let mut f = HookFixture::new(rules);
    f.ctx.set_time(1_000_000);
    let alice = f.kyc_holder(10_000);
    let bob = f.kyc_holder(0);

    f.transfer(&alice, &bob, 300).unwrap();
    f.transfer(&alice, &bob, 200).unwrap();
    let err = f.transfer(&alice, &bob, 1).unwrap_err();
    assert!(
        err.contains(&code(ComplianceError::VelocityLimitExceeded)),
        "{err}"
    );

    let identity: Identity = f
        .ctx
        .fetch(&identity_pda(&f.ctx.registry, &alice.wallet.pubkey()))
        .unwrap();
    assert_eq!(identity.window_volume, 500);
    assert_eq!(identity.window_start, 1_000_000);

    f.ctx.set_time(1_000_000 + 3_600);
    f.transfer(&alice, &bob, 500).unwrap();
}

#[test]
fn delegate_transfer_is_checked_against_owner_identity() {
    let mut f = HookFixture::new(default_rules());
    let alice = f.kyc_holder(1_000);
    let bob = f.kyc_holder(0);
    // Router/delegate with no identity of its own.
    let router = f.ctx.funded_keypair();

    let approve = spl_token_2022::instruction::approve(
        &spl_token_2022::ID,
        &alice.token,
        &router.pubkey(),
        &alice.wallet.pubkey(),
        &[],
        1_000,
    )
    .unwrap();
    let signer = alice.wallet.insecure_clone();
    f.ctx.send(&[approve], &[&signer]).unwrap();

    let delegated = |f: &HookFixture| {
        f.ctx.transfer_ix(
            &alice.token,
            &f.mint,
            &bob.token,
            &router.pubkey(),
            &alice.wallet.pubkey(),
            &bob.wallet.pubkey(),
            100,
        )
    };
    f.ctx.send(&[delegated(&f)], &[&router]).unwrap();
    assert_eq!(f.ctx.token_balance(&bob.token), 100);

    let issuer = f.issuer();
    f.admin_send(
        f.ctx
            .set_identity_frozen_ix(&issuer.pubkey(), &alice.wallet.pubkey(), true),
    );
    let err = f.ctx.send(&[delegated(&f)], &[&router]).unwrap_err();
    assert!(err.contains(&code(ComplianceError::SenderFrozen)), "{err}");
}

#[test]
fn admin_permanent_delegate_can_claw_back_from_frozen_holder() {
    let mut f = HookFixture::with_permanent_delegate(default_rules());
    let alice = f.kyc_holder(1_000);
    let issuer = f.issuer();
    let treasury = Holder {
        wallet: issuer.insecure_clone(),
        token: f.ctx.create_token_account(&f.mint, &issuer.pubkey()),
    };
    f.upsert(&issuer.pubkey(), identity_params(Tier::Issuer));
    f.admin_send(
        f.ctx
            .set_identity_frozen_ix(&issuer.pubkey(), &alice.wallet.pubkey(), true),
    );

    let ix = f.ctx.transfer_ix(
        &alice.token,
        &f.mint,
        &treasury.token,
        &issuer.pubkey(),
        &alice.wallet.pubkey(),
        &issuer.pubkey(),
        1_000,
    );
    f.admin_send(ix);
    assert_eq!(f.ctx.token_balance(&treasury.token), 1_000);
}

#[test]
fn non_admin_delegate_gets_no_bypass() {
    // Same shape as a clawback, but the delegate is not the registry admin.
    let mut f = HookFixture::new(default_rules());
    let alice = f.kyc_holder(1_000);
    let bob = f.kyc_holder(0);
    let delegate = Keypair::new();
    f.ctx
        .svm
        .airdrop(&delegate.pubkey(), 1_000_000_000)
        .unwrap();
    let approve = spl_token_2022::instruction::approve(
        &spl_token_2022::ID,
        &alice.token,
        &delegate.pubkey(),
        &alice.wallet.pubkey(),
        &[],
        1_000,
    )
    .unwrap();
    let signer = alice.wallet.insecure_clone();
    f.ctx.send(&[approve], &[&signer]).unwrap();
    let issuer = f.issuer();
    f.admin_send(
        f.ctx
            .set_identity_frozen_ix(&issuer.pubkey(), &alice.wallet.pubkey(), true),
    );

    let ix = f.ctx.transfer_ix(
        &alice.token,
        &f.mint,
        &bob.token,
        &delegate.pubkey(),
        &alice.wallet.pubkey(),
        &bob.wallet.pubkey(),
        1,
    );
    let err = f.ctx.send(&[ix], &[&delegate]).unwrap_err();
    assert!(err.contains(&code(ComplianceError::SenderFrozen)), "{err}");
}

#[test]
fn admin_clawback_cannot_target_unverified_recipient() {
    let mut f = HookFixture::with_permanent_delegate(default_rules());
    let alice = f.kyc_holder(1_000);
    let mallory = f.holder_without_identity(0);
    let frozen = f.kyc_holder(0);
    let issuer = f.issuer();
    f.admin_send(
        f.ctx
            .set_identity_frozen_ix(&issuer.pubkey(), &frozen.wallet.pubkey(), true),
    );

    let clawback_to = |f: &HookFixture, to: &Holder| {
        f.ctx.transfer_ix(
            &alice.token,
            &f.mint,
            &to.token,
            &issuer.pubkey(),
            &alice.wallet.pubkey(),
            &to.wallet.pubkey(),
            1,
        )
    };
    let ix = clawback_to(&f, &mallory);
    assert_err(
        f.ctx.send(&[ix], &[&issuer]),
        ComplianceError::RecipientIdentityNotFound,
    );
    let ix = clawback_to(&f, &frozen);
    assert_err(
        f.ctx.send(&[ix], &[&issuer]),
        ComplianceError::RecipientFrozen,
    );
}

#[test]
fn admin_clawback_ignores_pause_and_sender_state() {
    let mut f = HookFixture::with_permanent_delegate(default_rules());
    let alice = f.kyc_holder(1_000);
    let bob = f.kyc_holder(0);
    let issuer = f.issuer();
    f.admin_send(f.ctx.set_pause_ix(&issuer.pubkey(), &f.mint, true));
    f.admin_send(
        f.ctx
            .revoke_identity_ix(&issuer.pubkey(), &alice.wallet.pubkey()),
    );

    let ix = f.ctx.transfer_ix(
        &alice.token,
        &f.mint,
        &bob.token,
        &issuer.pubkey(),
        &alice.wallet.pubkey(),
        &bob.wallet.pubkey(),
        1_000,
    );
    f.admin_send(ix);
    assert_eq!(f.ctx.token_balance(&bob.token), 1_000);
}
