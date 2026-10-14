use anchor_lang::prelude::*;

use crate::instructions::identity::set_identity_frozen::ModifyIdentity;

/// Closes the identity; rent goes to the signing admin/oracle. Missing
/// identity = transfer rejected by the hook.
pub fn handle_revoke_identity(ctx: Context<ModifyIdentity>) -> Result<()> {
    ctx.accounts
        .identity
        .close(ctx.accounts.authority.to_account_info())
}
