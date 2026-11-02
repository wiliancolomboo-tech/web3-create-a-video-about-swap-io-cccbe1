use anchor_lang::prelude::*;
use crate::state::{RouterConfig, ROUTER_CONFIG_SEED};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = RouterConfig::LEN,
        seeds = [ROUTER_CONFIG_SEED],
        bump
    )]
    pub router_config: Account<'info, RouterConfig>,

    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: Safe address receiving optional protocol fee take
    pub fee_recipient: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Initialize>, fee_basis_points: u16) -> Result<()> {
    let config = &mut ctx.accounts.router_config;
    config.admin = ctx.accounts.admin.key();
    config.fee_recipient = ctx.accounts.fee_recipient.key();
    config.fee_basis_points = fee_basis_points;
    config.bump = ctx.bumps.router_config;
    config.total_swaps_routed = 0;
    Ok(())
}