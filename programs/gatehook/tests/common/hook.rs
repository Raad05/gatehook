#![allow(dead_code)]

use {
    super::*,
    anchor_lang::prelude::Pubkey,
    gatehook::{ComplianceRules, IdentityParams, Tier},
    solana_keypair::Keypair,
    solana_signer::Signer,
};

/// Holder wallet + its token account for the fixture mint.
pub struct Holder {
    pub wallet: Keypair,
    pub token: Pubkey,
}

/// Registry + hook mint with config and extra metas initialized.
pub struct HookFixture {
    pub ctx: Ctx,
    pub mint: Pubkey,
}

impl HookFixture {
    pub fn new(rules: ComplianceRules) -> Self {
        Self::build(rules, false)
    }

    /// Mint also has the issuer (registry admin) as permanent delegate.
    pub fn with_permanent_delegate(rules: ComplianceRules) -> Self {
        Self::build(rules, true)
    }

    fn build(rules: ComplianceRules, permanent_delegate: bool) -> Self {
        let mut ctx = Ctx::new();
        let issuer = ctx.issuer.insecure_clone();
        let delegate = issuer.pubkey();
        let mint = ctx.create_mint(
            &issuer.pubkey(),
            &gatehook::id(),
            permanent_delegate.then_some(&delegate),
        );
        let ixs = [
            ctx.init_mint_config_ix(&issuer.pubkey(), &mint, rules),
            ctx.init_extra_account_metas_ix(&issuer.pubkey(), &mint),
        ];
        ctx.send(&ixs, &[&issuer]).unwrap();
        Self { ctx, mint }
    }

    pub fn issuer(&self) -> Keypair {
        self.ctx.issuer.insecure_clone()
    }

    /// Funded wallet with a token account, no identity.
    pub fn holder_without_identity(&mut self, balance: u64) -> Holder {
        let wallet = self.ctx.funded_keypair();
        let token = self.ctx.create_token_account(&self.mint, &wallet.pubkey());
        if balance > 0 {
            self.ctx.mint_to(&self.mint, &token, balance);
        }
        Holder { wallet, token }
    }

    pub fn holder(&mut self, params: IdentityParams, balance: u64) -> Holder {
        let holder = self.holder_without_identity(balance);
        self.upsert(&holder.wallet.pubkey(), params);
        holder
    }

    pub fn kyc_holder(&mut self, balance: u64) -> Holder {
        self.holder(identity_params(Tier::RegDAccredited), balance)
    }

    pub fn upsert(&mut self, wallet: &Pubkey, params: IdentityParams) {
        let oracle = self.ctx.oracle.insecure_clone();
        let ix = self
            .ctx
            .upsert_identity_ix(&oracle.pubkey(), *wallet, params);
        self.ctx.send(&[ix], &[&oracle]).unwrap();
    }

    /// Owner-signed transfer.
    pub fn transfer(&mut self, from: &Holder, to: &Holder, amount: u64) -> Result<(), String> {
        let ix = self.transfer_ix(from, to, amount);
        let signer = from.wallet.insecure_clone();
        self.ctx.send(&[ix], &[&signer])
    }

    pub fn transfer_ix(
        &self,
        from: &Holder,
        to: &Holder,
        amount: u64,
    ) -> anchor_lang::solana_program::instruction::Instruction {
        self.ctx.transfer_ix(
            &from.token,
            &self.mint,
            &to.token,
            &from.wallet.pubkey(),
            &from.wallet.pubkey(),
            &to.wallet.pubkey(),
            amount,
        )
    }

    pub fn identity(&self, wallet: &Pubkey) -> gatehook::Identity {
        self.ctx
            .fetch(&identity_pda(&self.ctx.registry, wallet))
            .unwrap()
    }

    pub fn update_rules(&mut self, rules: ComplianceRules) {
        let issuer = self.issuer();
        let ix = self
            .ctx
            .update_config_ix(&issuer.pubkey(), &self.mint, rules);
        self.admin_send(ix);
    }

    pub fn admin_send(&mut self, ix: anchor_lang::solana_program::instruction::Instruction) {
        let issuer = self.issuer();
        self.ctx.send(&[ix], &[&issuer]).unwrap();
    }
}
