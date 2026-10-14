mod common;

use {
    common::*,
    gatehook::{error::ComplianceError, Identity, Tier, JURISDICTION_UNSET},
    solana_keypair::Keypair,
    solana_signer::Signer,
};

fn setup_identity(ctx: &mut Ctx) -> anchor_lang::prelude::Pubkey {
    let oracle = ctx.oracle.insecure_clone();
    let wallet = Keypair::new().pubkey();
    let ix = ctx.upsert_identity_ix(
        &oracle.pubkey(),
        wallet,
        identity_params(Tier::RegDAccredited),
    );
    ctx.send(&[ix], &[&oracle]).unwrap();
    wallet
}

#[test]
fn upsert_creates_identity() {
    let mut ctx = Ctx::new();
    let wallet = setup_identity(&mut ctx);

    let identity: Identity = ctx.fetch(&identity_pda(&ctx.registry, &wallet)).unwrap();
    assert_eq!(identity.registry, ctx.registry);
    assert_eq!(identity.wallet, wallet);
    assert_eq!(identity.tier, Tier::RegDAccredited);
    assert_eq!(identity.jurisdiction, gatehook::JURISDICTION_US);
    assert_eq!(identity.kyc_expiry, i64::MAX);
    assert!(!identity.frozen);
    assert_eq!(identity.version, gatehook::ACCOUNT_VERSION);
}

#[test]
fn upsert_updates_existing_identity() {
    let mut ctx = Ctx::new();
    let oracle = ctx.oracle.insecure_clone();
    let wallet = setup_identity(&mut ctx);

    let mut params = identity_params(Tier::RegSNonUs);
    params.jurisdiction = JURISDICTION_DE;
    params.kyc_expiry = 1_900_000_000;
    params.lockup_until = 1_800_000_000;
    let ix = ctx.upsert_identity_ix(&oracle.pubkey(), wallet, params);
    ctx.send(&[ix], &[&oracle]).unwrap();

    let identity: Identity = ctx.fetch(&identity_pda(&ctx.registry, &wallet)).unwrap();
    assert_eq!(identity.tier, Tier::RegSNonUs);
    assert_eq!(identity.jurisdiction, JURISDICTION_DE);
    assert_eq!(identity.kyc_expiry, 1_900_000_000);
    assert_eq!(identity.lockup_until, 1_800_000_000);
}

#[test]
fn upsert_rejects_non_oracle() {
    let mut ctx = Ctx::new();
    let issuer = ctx.issuer.insecure_clone();
    // Even the admin cannot write attestations; only the oracle key can.
    let ix = ctx.upsert_identity_ix(
        &issuer.pubkey(),
        Keypair::new().pubkey(),
        identity_params(Tier::RegDAccredited),
    );
    let err = ctx.send(&[ix], &[&issuer]).unwrap_err();
    assert!(
        err.contains(&code(ComplianceError::NotAdminOrOracle)),
        "{err}"
    );
}

#[test]
fn upsert_rejects_invalid_params() {
    let mut ctx = Ctx::new();
    let oracle = ctx.oracle.insecure_clone();

    let ix = ctx.upsert_identity_ix(
        &oracle.pubkey(),
        Keypair::new().pubkey(),
        identity_params(Tier::None),
    );
    let err = ctx.send(&[ix], &[&oracle]).unwrap_err();
    assert!(err.contains(&code(ComplianceError::InvalidTier)), "{err}");

    let mut params = identity_params(Tier::RegDAccredited);
    params.jurisdiction = JURISDICTION_UNSET;
    let ix = ctx.upsert_identity_ix(&oracle.pubkey(), Keypair::new().pubkey(), params);
    let err = ctx.send(&[ix], &[&oracle]).unwrap_err();
    assert!(
        err.contains(&code(ComplianceError::InvalidJurisdiction)),
        "{err}"
    );
}

#[test]
fn freeze_by_admin_or_oracle_only() {
    let mut ctx = Ctx::new();
    let issuer = ctx.issuer.insecure_clone();
    let oracle = ctx.oracle.insecure_clone();
    let attacker = ctx.funded_keypair();
    let wallet = setup_identity(&mut ctx);
    let pda = identity_pda(&ctx.registry, &wallet);

    let ix = ctx.set_identity_frozen_ix(&attacker.pubkey(), &wallet, true);
    let err = ctx.send(&[ix], &[&attacker]).unwrap_err();
    assert!(
        err.contains(&code(ComplianceError::NotAdminOrOracle)),
        "{err}"
    );

    let ix = ctx.set_identity_frozen_ix(&issuer.pubkey(), &wallet, true);
    ctx.send(&[ix], &[&issuer]).unwrap();
    assert!(ctx.fetch::<Identity>(&pda).unwrap().frozen);

    let ix = ctx.set_identity_frozen_ix(&oracle.pubkey(), &wallet, false);
    ctx.send(&[ix], &[&oracle]).unwrap();
    assert!(!ctx.fetch::<Identity>(&pda).unwrap().frozen);
}

#[test]
fn upsert_preserves_freeze() {
    let mut ctx = Ctx::new();
    let issuer = ctx.issuer.insecure_clone();
    let oracle = ctx.oracle.insecure_clone();
    let wallet = setup_identity(&mut ctx);

    let ix = ctx.set_identity_frozen_ix(&issuer.pubkey(), &wallet, true);
    ctx.send(&[ix], &[&issuer]).unwrap();
    let ix = ctx.upsert_identity_ix(
        &oracle.pubkey(),
        wallet,
        identity_params(Tier::QualifiedPurchaser),
    );
    ctx.send(&[ix], &[&oracle]).unwrap();

    let identity: Identity = ctx.fetch(&identity_pda(&ctx.registry, &wallet)).unwrap();
    assert!(identity.frozen);
    assert_eq!(identity.tier, Tier::QualifiedPurchaser);
}

#[test]
fn revoke_closes_identity_and_refunds_signer() {
    let mut ctx = Ctx::new();
    let issuer = ctx.issuer.insecure_clone();
    let attacker = ctx.funded_keypair();
    let wallet = setup_identity(&mut ctx);
    let pda = identity_pda(&ctx.registry, &wallet);

    let ix = ctx.revoke_identity_ix(&attacker.pubkey(), &wallet);
    let err = ctx.send(&[ix], &[&attacker]).unwrap_err();
    assert!(
        err.contains(&code(ComplianceError::NotAdminOrOracle)),
        "{err}"
    );

    let rent = ctx.svm.get_account(&pda).unwrap().lamports;
    let before = ctx.svm.get_balance(&issuer.pubkey()).unwrap();
    let ix = ctx.revoke_identity_ix(&issuer.pubkey(), &wallet);
    ctx.send(&[ix], &[&issuer]).unwrap();
    let after = ctx.svm.get_balance(&issuer.pubkey()).unwrap();

    assert!(ctx.fetch::<Identity>(&pda).is_none());
    assert_eq!(after, before + rent - 5_000);
}
