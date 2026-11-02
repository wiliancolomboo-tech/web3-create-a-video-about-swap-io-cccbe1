use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use crate::errors::SwapIoError;
use crate::state::PoolState;

#[derive(Accounts)]
pub struct SwapTokens<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, PoolState>,

    pub token_in_mint: InterfaceAccount<'info, Mint>,
    pub token_out_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = vault_in.key() == pool.vault_a || vault_in.key() == pool.vault_b @ SwapIoError::InsufficientReserves
    )]
    pub vault_in: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = vault_out.key() == pool.vault_a || vault_out.key() == pool.vault_b @ SwapIoError::InsufficientReserves
    )]
    pub vault_out: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = token_in_mint,
        token::authority = user,
    )]
    pub user_token_in: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = token_out_mint,
        token::authority = user,
    )]
    pub user_token_out: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<SwapTokens>, amount_in: u64, minimum_amount_out: u64) -> Result<()> {
    require!(amount_in > 0, SwapIoError::ZeroAmountIn);
    require_keys_neq!(
        ctx.accounts.token_in_mint.key(),
        ctx.accounts.token_out_mint.key(),
        SwapIoError::IdenticalTokens
    );

    let reserve_in = ctx.accounts.vault_in.amount;
    let reserve_out = ctx.accounts.vault_out.amount;

    require!(reserve_in > 0 && reserve_out > 0, SwapIoError::InsufficientReserves);

    // Compute Constant Product AMM output:
    // dy = (dx * (10_000 - fee) * y) / (x * 10_000 + dx * (10_000 - fee))
    let fee_factor = 10_000u128
        .checked_sub(ctx.accounts.pool.fee_bps as u128)
        .ok_or(SwapIoError::MathOverflow)?;

    let amount_in_u128 = amount_in as u128;
    let reserve_in_u128 = reserve_in as u128;
    let reserve_out_u128 = reserve_out as u128;

    let amount_in_with_fee = amount_in_u128
        .checked_mul(fee_factor)
        .ok_or(SwapIoError::MathOverflow)?;

    let numerator = amount_in_with_fee
        .checked_mul(reserve_out_u128)
        .ok_or(SwapIoError::MathOverflow)?;

    let denominator = reserve_in_u128
        .checked_mul(10_000u128)
        .ok_or(SwapIoError::MathOverflow)?
        .checked_add(amount_in_with_fee)
        .ok_or(SwapIoError::MathOverflow)?;

    let amount_out_u128 = numerator
        .checked_div(denominator)
        .ok_or(SwapIoError::MathOverflow)?;

    let amount_out = u64::try_from(amount_out_u128)
        .map_err(|_| SwapIoError::MathOverflow)?;

    // Slippage safety assertion
    require!(amount_out >= minimum_amount_out, SwapIoError::SlippageExceeded);

    // 1. CPI: Transfer user input tokens into the vault
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_token_in.to_account_info(),
                mint: ctx.accounts.token_in_mint.to_account_info(),
                to: ctx.accounts.vault_in.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount_in,
        ctx.accounts.token_in_mint.decimals,
    )?;

    // 2. CPI: Transfer vault tokens out to user using Pool PDA signer seeds
    let mint_a_key = ctx.accounts.pool.token_a_mint;
    let mint_b_key = ctx.accounts.pool.token_b_mint;
    let pool_bump = ctx.accounts.pool.bump;

    let signer_seeds: &[&[&[u8]]] = &[&[
        b"pool",
        mint_a_key.as_ref(),
        mint_b_key.as_ref(),
        &[pool_bump],
    ]];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault_out.to_account_info(),
                mint: ctx.accounts.token_out_mint.to_account_info(),
                to: ctx.accounts.user_token_out.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            signer_seeds,
        ),
        amount_out,
        ctx.accounts.token_out_mint.decimals,
    )?;

    // 3. State update: update volume and timestamps
    let pool = &mut ctx.accounts.pool;
    let current_slot = Clock::get()?.slot;
    pool.last_trade_slot = current_slot;

    if ctx.accounts.token_in_mint.key() == pool.token_a_mint {
        pool.cumulative_volume_a = pool
            .cumulative_volume_a
            .checked_add(amount_in_u128)
            .ok_or(SwapIoError::MathOverflow)?;
    } else {
        pool.cumulative_volume_b = pool
            .cumulative_volume_b
            .checked_add(amount_in_u128)
            .ok_or(SwapIoError::MathOverflow)?;
    }

    Ok(())
}