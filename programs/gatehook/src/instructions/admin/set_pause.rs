use anchor_lang::prelude::*;

use crate::instructions::admin::update_config::UpdateConfig;

pub fn handle_set_pause(ctx: Context<UpdateConfig>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    Ok(())
}
