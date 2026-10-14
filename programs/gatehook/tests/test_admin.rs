mod common;

use {
    anchor_lang::error::ErrorCode as AnchorError,
    common::*,
    gatehook::{error::ComplianceError, ComplianceConfig, Registry},
    solana_keypair::Keypair,
    solana_signer::Signer,
};

#[test]
fn init_registry_sets_issuer_as_admin() {
    let ctx = Ctx::new();
    let registry: Registry = ctx.fetch(&ctx.registry).unwrap();
    assert_eq!(registry.issuer, ctx.issuer.pubkey());
    assert_eq!(registry.admin, ctx.issuer.pubkey());
    assert_eq!(registry.oracle, ctx.oracle.pubkey());
    assert_eq!(registry.version, gatehook::ACCOUNT_VERSION);
}

#[test]
fn init_registry_twice_fails() {
    let mut ctx = Ctx::new();
    let issuer = ctx.issuer.insecure_clone();
    let ix = ctx.init_registry_ix();
    assert!(ctx.send(&[ix], &[&issuer]).is_err());
}

#[test]
fn set_oracle_admin_only() {
    let mut ctx = Ctx::new();
    let issuer = ctx.issuer.insecure_clone();
    let attacker = ctx.funded_keypair();
    let new_oracle = Keypair::new().pubkey();

    let ix = ctx.set_oracle_ix(&attacker.pubkey(), new_oracle);
    let err = ctx.send(&[ix], &[&attacker]).unwrap_err();
    assert!(err.contains(&code(ComplianceError::NotAdmin)), "{err}");

    let ix = ctx.set_oracle_ix(&issuer.pubkey(), new_oracle);
    ctx.send(&[ix], &[&issuer]).unwrap();
    let registry: Registry = ctx.fetch(&ctx.registry).unwrap();
    assert_eq!(registry.oracle, new_oracle);
}

#[test]
fn init_mint_config_stores_rules() {
    let mut ctx = Ctx::new();
    let issuer = ctx.issuer.insecure_clone();
    let mint = ctx.create_hook_mint(&issuer.pubkey(), &gatehook::id());

    let ix = ctx.init_mint_config_ix(&issuer.pubkey(), &mint, default_rules());
    ctx.send(&[ix], &[&issuer]).unwrap();

    let config: ComplianceConfig = ctx.fetch(&config_pda(&mint)).unwrap();
    assert_eq!(config.registry, ctx.registry);
    assert_eq!(config.mint, mint);
    assert!(!config.paused);
    assert_eq!(config.rules, default_rules());
}

#[test]
fn init_mint_config_rejects_foreign_hook_program() {
    let mut ctx = Ctx::new();
    let issuer = ctx.issuer.insecure_clone();
    let mint = ctx.create_hook_mint(&issuer.pubkey(), &Keypair::new().pubkey());

    let ix = ctx.init_mint_config_ix(&issuer.pubkey(), &mint, default_rules());
    let err = ctx.send(&[ix], &[&issuer]).unwrap_err();
    assert!(
        err.contains(&code(
            AnchorError::ConstraintMintTransferHookExtensionProgramId
        )),
        "{err}"
    );
}

#[test]
fn init_mint_config_rejects_when_admin_not_hook_authority() {
    let mut ctx = Ctx::new();
    let issuer = ctx.issuer.insecure_clone();
    let other = Keypair::new().pubkey();
    let mint = ctx.create_hook_mint(&other, &gatehook::id());

    let ix = ctx.init_mint_config_ix(&issuer.pubkey(), &mint, default_rules());
    let err = ctx.send(&[ix], &[&issuer]).unwrap_err();
    assert!(
        err.contains(&code(
            AnchorError::ConstraintMintTransferHookExtensionAuthority
        )),
        "{err}"
    );
}

#[test]
fn init_mint_config_rejects_velocity_limit_without_window() {
    let mut ctx = Ctx::new();
    let issuer = ctx.issuer.insecure_clone();
    let mint = ctx.create_hook_mint(&issuer.pubkey(), &gatehook::id());

    let mut rules = default_rules();
    rules.velocity_limit_per_tier[1] = 1_000;
    rules.velocity_window_secs = 0;
    let ix = ctx.init_mint_config_ix(&issuer.pubkey(), &mint, rules);
    let err = ctx.send(&[ix], &[&issuer]).unwrap_err();
    assert!(
        err.contains(&code(ComplianceError::InvalidVelocityWindow)),
        "{err}"
    );
}

#[test]
fn update_config_and_pause_admin_only() {
    let mut ctx = Ctx::new();
    let issuer = ctx.issuer.insecure_clone();
    let attacker = ctx.funded_keypair();
    let mint = ctx.create_hook_mint(&issuer.pubkey(), &gatehook::id());
    let ix = ctx.init_mint_config_ix(&issuer.pubkey(), &mint, default_rules());
    ctx.send(&[ix], &[&issuer]).unwrap();

    let mut rules = default_rules();
    rules.max_tx_amount = 500;

    let ix = ctx.update_config_ix(&attacker.pubkey(), &mint, rules);
    let err = ctx.send(&[ix], &[&attacker]).unwrap_err();
    assert!(err.contains(&code(ComplianceError::NotAdmin)), "{err}");
    let ix = ctx.set_pause_ix(&attacker.pubkey(), &mint, true);
    let err = ctx.send(&[ix], &[&attacker]).unwrap_err();
    assert!(err.contains(&code(ComplianceError::NotAdmin)), "{err}");

    let ixs = [
        ctx.update_config_ix(&issuer.pubkey(), &mint, rules),
        ctx.set_pause_ix(&issuer.pubkey(), &mint, true),
    ];
    ctx.send(&ixs, &[&issuer]).unwrap();
    let config: ComplianceConfig = ctx.fetch(&config_pda(&mint)).unwrap();
    assert_eq!(config.rules.max_tx_amount, 500);
    assert!(config.paused);

    let ix = ctx.set_pause_ix(&issuer.pubkey(), &mint, false);
    ctx.send(&[ix], &[&issuer]).unwrap();
    let config: ComplianceConfig = ctx.fetch(&config_pda(&mint)).unwrap();
    assert!(!config.paused);
}

#[test]
fn update_config_rejects_config_of_other_registry() {
    // Second issuer with its own registry tries to edit the first issuer's config.
    let mut ctx = Ctx::new();
    let issuer = ctx.issuer.insecure_clone();
    let mint = ctx.create_hook_mint(&issuer.pubkey(), &gatehook::id());
    let ix = ctx.init_mint_config_ix(&issuer.pubkey(), &mint, default_rules());
    ctx.send(&[ix], &[&issuer]).unwrap();

    let other_issuer = ctx.funded_keypair();
    let other_registry = registry_pda(&other_issuer.pubkey());
    let ix = anchor_lang::solana_program::instruction::Instruction::new_with_bytes(
        gatehook::id(),
        &anchor_lang::InstructionData::data(&gatehook::instruction::InitRegistry {
            oracle: other_issuer.pubkey(),
        }),
        anchor_lang::ToAccountMetas::to_account_metas(
            &gatehook::accounts::InitRegistry {
                issuer: other_issuer.pubkey(),
                registry: other_registry,
                system_program: anchor_lang::solana_program::system_program::ID,
            },
            None,
        ),
    );
    ctx.send(&[ix], &[&other_issuer]).unwrap();

    ctx.registry = other_registry;
    let ix = ctx.set_pause_ix(&other_issuer.pubkey(), &mint, true);
    let err = ctx.send(&[ix], &[&other_issuer]).unwrap_err();
    assert!(
        err.contains(&code(ComplianceError::RegistryMismatch)),
        "{err}"
    );
}

fn propose_admin_ix(
    ctx: &Ctx,
    admin: &anchor_lang::prelude::Pubkey,
    new_admin: anchor_lang::prelude::Pubkey,
) -> anchor_lang::solana_program::instruction::Instruction {
    anchor_lang::solana_program::instruction::Instruction::new_with_bytes(
        gatehook::id(),
        &anchor_lang::InstructionData::data(&gatehook::instruction::ProposeAdmin { new_admin }),
        anchor_lang::ToAccountMetas::to_account_metas(
            &gatehook::accounts::ProposeAdmin {
                admin: *admin,
                registry: ctx.registry,
            },
            None,
        ),
    )
}

fn accept_admin_ix(
    ctx: &Ctx,
    new_admin: &anchor_lang::prelude::Pubkey,
) -> anchor_lang::solana_program::instruction::Instruction {
    anchor_lang::solana_program::instruction::Instruction::new_with_bytes(
        gatehook::id(),
        &anchor_lang::InstructionData::data(&gatehook::instruction::AcceptAdmin {}),
        anchor_lang::ToAccountMetas::to_account_metas(
            &gatehook::accounts::AcceptAdmin {
                new_admin: *new_admin,
                registry: ctx.registry,
            },
            None,
        ),
    )
}

#[test]
fn admin_rotation_is_two_step() {
    let mut ctx = Ctx::new();
    let issuer = ctx.issuer.insecure_clone();
    let new_admin = ctx.funded_keypair();
    let attacker = ctx.funded_keypair();

    // Only the admin can propose.
    let ix = propose_admin_ix(&ctx, &attacker.pubkey(), attacker.pubkey());
    assert_err(ctx.send(&[ix], &[&attacker]), ComplianceError::NotAdmin);

    // Nothing pending: nobody can accept.
    let ix = accept_admin_ix(&ctx, &new_admin.pubkey());
    assert_err(
        ctx.send(&[ix], &[&new_admin]),
        ComplianceError::NotPendingAdmin,
    );

    let ix = propose_admin_ix(&ctx, &issuer.pubkey(), new_admin.pubkey());
    ctx.send(&[ix], &[&issuer]).unwrap();
    let registry: Registry = ctx.fetch(&ctx.registry).unwrap();
    assert_eq!(
        (registry.admin, registry.pending_admin),
        (issuer.pubkey(), new_admin.pubkey())
    );

    // Only the proposed key can accept.
    let ix = accept_admin_ix(&ctx, &attacker.pubkey());
    assert_err(
        ctx.send(&[ix], &[&attacker]),
        ComplianceError::NotPendingAdmin,
    );

    let ix = accept_admin_ix(&ctx, &new_admin.pubkey());
    ctx.send(&[ix], &[&new_admin]).unwrap();
    let registry: Registry = ctx.fetch(&ctx.registry).unwrap();
    assert_eq!(registry.admin, new_admin.pubkey());
    assert_eq!(
        registry.pending_admin,
        anchor_lang::prelude::Pubkey::default()
    );
    // PDA stays keyed by the original issuer.
    assert_eq!(registry.issuer, issuer.pubkey());

    // Old admin lost its powers; new admin has them.
    let ix = ctx.set_oracle_ix(&issuer.pubkey(), new_admin.pubkey());
    assert_err(ctx.send(&[ix], &[&issuer]), ComplianceError::NotAdmin);
    let ix = ctx.set_oracle_ix(&new_admin.pubkey(), new_admin.pubkey());
    ctx.send(&[ix], &[&new_admin]).unwrap();
}

#[test]
fn admin_proposal_can_be_cancelled() {
    let mut ctx = Ctx::new();
    let issuer = ctx.issuer.insecure_clone();
    let new_admin = ctx.funded_keypair();

    let ix = propose_admin_ix(&ctx, &issuer.pubkey(), new_admin.pubkey());
    ctx.send(&[ix], &[&issuer]).unwrap();
    let ix = propose_admin_ix(
        &ctx,
        &issuer.pubkey(),
        anchor_lang::prelude::Pubkey::default(),
    );
    ctx.send(&[ix], &[&issuer]).unwrap();

    let ix = accept_admin_ix(&ctx, &new_admin.pubkey());
    assert_err(
        ctx.send(&[ix], &[&new_admin]),
        ComplianceError::NotPendingAdmin,
    );
}
