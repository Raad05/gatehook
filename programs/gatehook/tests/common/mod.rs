#![allow(dead_code)]

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            instruction::{AccountMeta, Instruction},
            system_program,
        },
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::token_2022::spl_token_2022::{
        self,
        extension::{transfer_hook, ExtensionType},
    },
    gatehook::{ComplianceRules, IdentityParams, Tier, JURISDICTION_US, N_TIERS},
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

pub const JURISDICTION_DE: u8 = 2;

pub struct Ctx {
    pub svm: LiteSVM,
    pub issuer: Keypair,
    pub oracle: Keypair,
    pub registry: Pubkey,
}

impl Ctx {
    /// Fresh SVM with the program loaded and an initialized registry.
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(
            env!("CARGO_TARGET_TMPDIR"),
            "/../deploy/gatehook.so"
        ));
        svm.add_program(gatehook::id(), bytes).unwrap();

        let issuer = Keypair::new();
        let oracle = Keypair::new();
        svm.airdrop(&issuer.pubkey(), 10_000_000_000).unwrap();
        svm.airdrop(&oracle.pubkey(), 10_000_000_000).unwrap();

        let registry = registry_pda(&issuer.pubkey());
        let mut ctx = Self { svm, issuer, oracle, registry };
        let ix = ctx.init_registry_ix();
        ctx.send(&[ix], &[&ctx.issuer.insecure_clone()]).unwrap();
        ctx
    }

    pub fn funded_keypair(&mut self) -> Keypair {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        kp
    }

    /// Sends `ixs` with `signers[0]` as fee payer. Returns the error debug
    /// string on failure so tests can match custom error codes.
    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        self.svm.expire_blockhash();
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| format!("{:?}", e.err))
    }

    pub fn fetch<T: AccountDeserialize>(&self, address: &Pubkey) -> Option<T> {
        let account = self.svm.get_account(address)?;
        if account.data.is_empty() {
            return None;
        }
        T::try_deserialize(&mut account.data.as_slice()).ok()
    }

    /// Creates a Token-2022 mint with the TransferHook extension.
    pub fn create_hook_mint(&mut self, hook_authority: &Pubkey, hook_program: &Pubkey) -> Pubkey {
        let mint = Keypair::new();
        let payer = self.issuer.insecure_clone();
        let space = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&[
            ExtensionType::TransferHook,
        ])
        .unwrap();
        let lamports = self.svm.minimum_balance_for_rent_exemption(space);
        let ixs = [
            create_account_ix(&payer.pubkey(), &mint.pubkey(), lamports, space as u64, &spl_token_2022::ID),
            transfer_hook::instruction::initialize(
                &spl_token_2022::ID,
                &mint.pubkey(),
                Some(*hook_authority),
                Some(*hook_program),
            )
            .unwrap(),
            spl_token_2022::instruction::initialize_mint2(
                &spl_token_2022::ID,
                &mint.pubkey(),
                &payer.pubkey(),
                None,
                6,
            )
            .unwrap(),
        ];
        self.send(&ixs, &[&payer, &mint]).unwrap();
        mint.pubkey()
    }

    pub fn init_registry_ix(&self) -> Instruction {
        Instruction::new_with_bytes(
            gatehook::id(),
            &gatehook::instruction::InitRegistry { oracle: self.oracle.pubkey() }.data(),
            gatehook::accounts::InitRegistry {
                issuer: self.issuer.pubkey(),
                registry: self.registry,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn init_mint_config_ix(&self, admin: &Pubkey, mint: &Pubkey, rules: ComplianceRules) -> Instruction {
        Instruction::new_with_bytes(
            gatehook::id(),
            &gatehook::instruction::InitMintConfig { rules }.data(),
            gatehook::accounts::InitMintConfig {
                admin: *admin,
                registry: self.registry,
                mint: *mint,
                config: config_pda(mint),
                token_program: spl_token_2022::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn update_config_accounts(&self, admin: &Pubkey, mint: &Pubkey) -> Vec<AccountMeta> {
        gatehook::accounts::UpdateConfig {
            admin: *admin,
            registry: self.registry,
            config: config_pda(mint),
        }
        .to_account_metas(None)
    }

    pub fn update_config_ix(&self, admin: &Pubkey, mint: &Pubkey, rules: ComplianceRules) -> Instruction {
        Instruction::new_with_bytes(
            gatehook::id(),
            &gatehook::instruction::UpdateConfig { rules }.data(),
            self.update_config_accounts(admin, mint),
        )
    }

    pub fn set_pause_ix(&self, admin: &Pubkey, mint: &Pubkey, paused: bool) -> Instruction {
        Instruction::new_with_bytes(
            gatehook::id(),
            &gatehook::instruction::SetPause { paused }.data(),
            self.update_config_accounts(admin, mint),
        )
    }

    pub fn set_oracle_ix(&self, admin: &Pubkey, oracle: Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            gatehook::id(),
            &gatehook::instruction::SetOracle { oracle }.data(),
            gatehook::accounts::SetOracle { admin: *admin, registry: self.registry }
                .to_account_metas(None),
        )
    }

    pub fn upsert_identity_ix(&self, oracle: &Pubkey, wallet: Pubkey, params: IdentityParams) -> Instruction {
        Instruction::new_with_bytes(
            gatehook::id(),
            &gatehook::instruction::UpsertIdentity { wallet, params }.data(),
            gatehook::accounts::UpsertIdentity {
                oracle: *oracle,
                payer: *oracle,
                registry: self.registry,
                identity: identity_pda(&self.registry, &wallet),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn modify_identity_accounts(&self, authority: &Pubkey, wallet: &Pubkey) -> Vec<AccountMeta> {
        gatehook::accounts::ModifyIdentity {
            authority: *authority,
            registry: self.registry,
            identity: identity_pda(&self.registry, wallet),
        }
        .to_account_metas(None)
    }

    pub fn set_identity_frozen_ix(&self, authority: &Pubkey, wallet: &Pubkey, frozen: bool) -> Instruction {
        Instruction::new_with_bytes(
            gatehook::id(),
            &gatehook::instruction::SetIdentityFrozen { frozen }.data(),
            self.modify_identity_accounts(authority, wallet),
        )
    }

    pub fn revoke_identity_ix(&self, authority: &Pubkey, wallet: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            gatehook::id(),
            &gatehook::instruction::RevokeIdentity {}.data(),
            self.modify_identity_accounts(authority, wallet),
        )
    }
}

pub fn registry_pda(issuer: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[gatehook::REGISTRY_SEED, issuer.as_ref()], &gatehook::id()).0
}

pub fn config_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[gatehook::CONFIG_SEED, mint.as_ref()], &gatehook::id()).0
}

pub fn identity_pda(registry: &Pubkey, wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[gatehook::IDENTITY_SEED, registry.as_ref(), wallet.as_ref()],
        &gatehook::id(),
    )
    .0
}

/// System program `CreateAccount` (variant 0), encoded by hand to avoid an
/// extra system-interface dependency.
fn create_account_ix(from: &Pubkey, to: &Pubkey, lamports: u64, space: u64, owner: &Pubkey) -> Instruction {
    let mut data = Vec::with_capacity(52);
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(&lamports.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(owner.as_ref());
    Instruction::new_with_bytes(
        system_program::ID,
        &data,
        vec![AccountMeta::new(*from, true), AccountMeta::new(*to, true)],
    )
}

pub fn default_rules() -> ComplianceRules {
    let mut allowed_jurisdictions = [0u64; 4];
    for j in [JURISDICTION_US, JURISDICTION_DE] {
        allowed_jurisdictions[(j / 64) as usize] |= 1 << (j % 64);
    }
    ComplianceRules {
        max_tx_amount: 0,
        velocity_window_secs: 86_400,
        velocity_limit_per_tier: [0; N_TIERS],
        lockup_until: 0,
        reg_s_compliance_until: 0,
        allowed_jurisdictions,
        allowed_tiers: 0b11_1110,
    }
}

pub fn identity_params(tier: Tier) -> IdentityParams {
    IdentityParams {
        tier,
        jurisdiction: JURISDICTION_US,
        kyc_expiry: i64::MAX,
        lockup_until: 0,
    }
}

/// Anchor custom error code as it appears in `InstructionError::Custom`.
pub fn code(e: impl Into<u32>) -> String {
    format!("Custom({})", e.into())
}
