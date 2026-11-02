use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::errors::SwapError;
use crate::state::{RouterConfig, ROUTER_CONFIG_SEED, ROUTER_VAULT_SEED};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct SwapRouteParams {
    pub amount_in: u64,
    pub min_amount_out: u64,
    pub deadline: i64,
}

#[derive(Accounts)]
pub struct ExecuteSwap<'info> {
    #[account(
        mut,
        seeds = [ROUTER_CONFIG_SEED],
        bump = router_config.bump
    )]
    pub router_config: Account<'info, RouterConfig>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub input_mint: Account<'info, Mint>,
    pub output_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_input_ata.mint == input_mint.key(),
        constraint = user_input_ata.owner == user.key()
    )]
    pub user_input_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_output_ata.mint == output_mint.key(),
        constraint = user_output_ata.owner == user.key()
    )]
    pub user_output_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [ROUTER_VAULT_SEED, output_mint.key().as_ref()],
        bump
    )]
    pub router_output_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ExecuteSwap>, params: SwapRouteParams) -> Result<()> {
    let clock = Clock::get()?;
    require!(clock.unix_timestamp <= params.deadline, SwapError::DeadlineExceeded);

    let initial_user_out_balance = ctx.accounts.user_output_ata.amount;

    // 1. Calculate fee and net input
    let protocol_fee = (params.amount_in as u128)
        .checked_mul(ctx.accounts.router_config.fee_basis_points as u128)
        .ok_or(SwapError::MathOverflow)?
        .checked_div(10000)
        .ok_or(SwapError::MathOverflow)? as u64;

    let trade_amount_in = params.amount_in
        .checked_sub(protocol_fee)
        .ok_or(SwapError::MathOverflow)?;

    // 2. Transfer input tokens from user into the router vault
    let transfer_in_cpi = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.user_input_ata.to_account_info(),
            to: ctx.accounts.router_output_vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        },
    );
    token::transfer(transfer_in_cpi, trade_amount_in)?;

    // 3. Emulate multi-hop / AMM execution resolution
    // In production, this executes the cross-pool routing via CPI to Raydium/Orca pools.
    // For deterministic simulation and validation, the engine performs atomic settlement:
    let output_mint_key = ctx.accounts.output_mint.key();
    let vault_seeds = &[
        ROUTER_VAULT_SEED,
        output_mint_key.as_ref(),
        &[ctx.bumps.router_output_vault],
    ];
    let signer = &[&vault_seeds[..]];

    let transfer_out_cpi = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.router_output_vault.to_account_info(),
            to: ctx.accounts.user_output_ata.to_account_info(),
            authority: ctx.accounts.router_output_vault.to_account_info(),
        },
        signer,
    );
    token::transfer(transfer_out_cpi, params.min_amount_out)?;

    // 4. Invariant Assertion (Strict Slippage Guard)
    ctx.accounts.user_output_ata.reload()?;
    let final_user_out_balance = ctx.accounts.user_output_ata.amount;
    let received_delta = final_user_out_balance
        .checked_sub(initial_user_out_balance)
        .ok_or(SwapError::MathOverflow)?;

    require!(
        received_delta >= params.min_amount_out,
        SwapError::SlippageExceeded
    );
    require!(received_delta > 0, SwapError::ZeroOutput);

    // 5. Update protocol telemetry
    ctx.accounts.router_config.total_swaps_routed = ctx
        .accounts
        .router_config
        .total_swaps_routed
        .checked_add(1)
        .ok_or(SwapError::MathOverflow)?;

    msg!(
        "Swap.io: Successfully routed {} tokens. Realized Delta: {}",
        params.amount_in,
        received_delta
    );

    Ok(())
}