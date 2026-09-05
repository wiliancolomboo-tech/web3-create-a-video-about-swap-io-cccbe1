use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("Swp1o11111111111111111111111111111111111111");

#[program]
pub mod swap_io {
    use super::*;

    /// Initializes a new liquidity pool for a token pair.
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        pool_bump: u8,
        vault_a_bump: u8,
        vault_b_bump: u8,
        fee_basis_points: u16,
    ) -> Result<()> {
        require!(fee_basis_points <= 1000, SwapError::FeeTooHigh); // Max fee: 10%

        let pool = &mut ctx.accounts.pool_state;
        pool.initializer = ctx.accounts.initializer.key();
        pool.mint_a = ctx.accounts.mint_a.key();
        pool.mint_b = ctx.accounts.mint_b.key();
        pool.vault_a = ctx.accounts.vault_a.key();
        pool.vault_b = ctx.accounts.vault_b.key();
        pool.fee_basis_points = fee_basis_points;
        pool.pool_bump = pool_bump;
        pool.vault_a_bump = vault_a_bump;
        pool.vault_b_bump = vault_b_bump;
        pool.is_locked = false;

        emit!(PoolInitializedEvent {
            pool: pool.key(),
            mint_a: pool.mint_a,
            mint_b: pool.mint_b,
            fee_basis_points,
        });

        Ok(())
    }

    /// Executes an atomic constant-product token swap with Token-2022 extension awareness.
    pub fn swap(ctx: Context<Swap>, amount_in: u64, min_amount_out: u64) -> Result<()> {
        require!(amount_in > 0, SwapError::ZeroAmount);
        
        let pool = &mut ctx.accounts.pool_state;
        require!(!pool.is_locked, SwapError::ReentrancyDetected);
        pool.is_locked = true; // Mutex pattern for strict reentrancy prevention

        let reserve_in = ctx.accounts.vault_in.amount;
        let reserve_out = ctx.accounts.vault_out.amount;

        require!(reserve_in > 0 && reserve_out > 0, SwapError::InsufficientLiquidity);

        // Constant-product invariant calculation:
        // dy = (y * dx * (10000 - fee)) / (x * 10000 + dx * (10000 - fee))
        let fee_factor = 10000u128
            .checked_sub(pool.fee_basis_points as u128)
            .ok_or(SwapError::MathOverflow)?;

        let amount_in_u128 = amount_in as u128;
        let reserve_in_u128 = reserve_in as u128;
        let reserve_out_u128 = reserve_out as u128;

        let amount_in_with_fee = amount_in_u128
            .checked_mul(fee_factor)
            .ok_or(SwapError::MathOverflow)?;

        let numerator = amount_in_with_fee
            .checked_mul(reserve_out_u128)
            .ok_or(SwapError::MathOverflow)?;

        let denominator = reserve_in_u128
            .checked_mul(10000u128)
            .ok_or(SwapError::MathOverflow)?
            .checked_add(amount_in_with_fee)
            .ok_or(SwapError::MathOverflow)?;

        let amount_out_u128 = numerator
            .checked_div(denominator)
            .ok_or(SwapError::MathOverflow)?;

        let amount_out = u64::try_from(amount_out_u128).map_err(|_| SwapError::MathOverflow)?;

        // Slippage assertion
        require!(amount_out >= min_amount_out, SwapError::SlippageExceeded);

        // Calculate protocol fee (10% of total fee)
        let total_fee = amount_in_u128
            .checked_mul(pool.fee_basis_points as u128)
            .ok_or(SwapError::MathOverflow)?
            .checked_div(10000u128)
            .ok_or(SwapError::MathOverflow)?;
        let protocol_fee = u64::try_from(total_fee / 10).unwrap_or(0);

        // 1. CPI: Transfer tokens from user to vault_in using TransferChecked (Token-2022 compatible)
        let transfer_in_accounts = TransferChecked {
            from: ctx.accounts.user_token_in.to_account_info(),
            mint: ctx.accounts.mint_in.to_account_info(),
            to: ctx.accounts.vault_in.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_in_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            transfer_in_accounts,
        );
        token_interface::transfer_checked(
            cpi_in_ctx,
            amount_in,
            ctx.accounts.mint_in.decimals,
        )?;

        // 2. CPI: Transfer tokens from vault_out to user with PDA signing
        let mint_a_key = pool.mint_a;
        let mint_b_key = pool.mint_b;
        let pool_bump = pool.pool_bump;
        let pool_seeds: &[&[&[u8]]] = &[&[
            b"pool",
            mint_a_key.as_ref(),
            mint_b_key.as_ref(),
            &[pool_bump],
        ]];

        let transfer_out_accounts = TransferChecked {
            from: ctx.accounts.vault_out.to_account_info(),
            mint: ctx.accounts.mint_out.to_account_info(),
            to: ctx.accounts.user_token_out.to_account_info(),
            authority: pool.to_account_info(),
        };
        let cpi_out_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_out_accounts,
            pool_seeds,
        );
        token_interface::transfer_checked(
            cpi_out_ctx,
            amount_out,
            ctx.accounts.mint_out.decimals,
        )?;

        // Release mutex lock
        pool.is_locked = false;

        emit!(SwapExecutedEvent {
            pool: pool.key(),
            user: ctx.accounts.user.key(),
            mint_in: ctx.accounts.mint_in.key(),
            mint_out: ctx.accounts.mint_out.key(),
            amount_in,
            amount_out,
            protocol_fee,
        });

        Ok(())
    }
}

// ----------------------------- ACCOUNT CONTEXTS ----------------------------- //

#[derive(Accounts)]
#[instruction(pool_bump: u8, vault_a_bump: u8, vault_b_bump: u8)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub initializer: Signer<'info>,

    pub mint_a: InterfaceAccount<'info, Mint>,
    pub mint_b: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = initializer,
        space = 8 + PoolState::INIT_SPACE,
        seeds = [b"pool", mint_a.key().as_ref(), mint_b.key().as_ref()],
        bump
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        init,
        payer = initializer,
        seeds = [b"vault", pool_state.key().as_ref(), mint_a.key().as_ref()],
        bump,
        token::mint = mint_a,
        token::authority = pool_state,
    )]
    pub vault_a: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = initializer,
        seeds = [b"vault", pool_state.key().as_ref(), mint_b.key().as_ref()],
        bump,
        token::mint = mint_b,
        token::authority = pool_state,
    )]
    pub vault_b: InterfaceAccount<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool_state.mint_a.as_ref(), pool_state.mint_b.as_ref()],
        bump = pool_state.pool_bump,
    )]
    pub pool_state: Account<'info, PoolState>,

    pub mint_in: InterfaceAccount<'info, Mint>,
    pub mint_out: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = vault_in.key() == pool_state.vault_a || vault_in.key() == pool_state.vault_b @ SwapError::InvalidVault,
        token::mint = mint_in,
        token::authority = pool_state,
    )]
    pub vault_in: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = vault_out.key() == pool_state.vault_a || vault_out.key() == pool_state.vault_b @ SwapError::InvalidVault,
        token::mint = mint_out,
        token::authority = pool_state,
    )]
    pub vault_out: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = mint_in,
        token::authority = user,
    )]
    pub user_token_in: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = mint_out,
        token::authority = user,
    )]
    pub user_token_out: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

// ----------------------------- STATE DEFINITIONS ---------------------------- //

#[account]
#[derive(InitSpace)]
pub struct PoolState {
    pub initializer: Pubkey,   // 32
    pub mint_a: Pubkey,        // 32
    pub mint_b: Pubkey,        // 32
    pub vault_a: Pubkey,       // 32
    pub vault_b: Pubkey,       // 32
    pub fee_basis_points: u16, // 2
    pub pool_bump: u8,         // 1
    pub vault_a_bump: u8,      // 1
    pub vault_b_bump: u8,      // 1
    pub is_locked: bool,       // 1 (Reentrancy mutex)
}

// --------------------------------- EVENTS ----------------------------------- //

#[event]
pub struct PoolInitializedEvent {
    pub pool: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub fee_basis_points: u16,
}

#[event]
pub struct SwapExecutedEvent {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub mint_in: Pubkey,
    pub mint_out: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub protocol_fee: u64,
}

// --------------------------------- ERRORS ----------------------------------- //

#[error_code]
pub enum SwapError {
    #[msg("Fee basis points exceed maximum permitted threshold of 1000 bps")]
    FeeTooHigh,
    #[msg("Provided swap amount must be greater than zero")]
    ZeroAmount,
    #[msg("Insufficient pool token liquidity to complete trade")]
    InsufficientLiquidity,
    #[msg("Calculated swap output is below user-defined minimum (slippage check failed)")]
    SlippageExceeded,
    #[msg("Arithmetic overflow during invariant calculation")]
    MathOverflow,
    #[msg("Invalid vault account supplied for swap direction")]
    InvalidVault,
    #[msg("Reentrancy detected during swap execution")]
    ReentrancyDetected,
}