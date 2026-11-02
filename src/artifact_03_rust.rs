use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("Swap1o1111111111111111111111111111111111111");

pub const SWAP_SEED: &[u8] = b"swap_state";
pub const VAULT_SEED: &[u8] = b"vault";

#[program]
pub mod swap_io {
    use super::*;

    /// Initializes a peer-to-peer or routed atomic swap order.
    /// Locks Maker's Asset A into a deterministic PDA-controlled Vault.
    pub fn initialize_swap(
        ctx: Context<InitializeSwap>,
        swap_id: u64,
        maker_amount: u64,
        taker_expected_amount: u64,
        expiry_timestamp: i64,
    ) -> Result<()> {
        require!(maker_amount > 0, SwapError::InvalidAmount);
        require!(taker_expected_amount > 0, SwapError::InvalidAmount);
        
        let current_time = Clock::get()?.unix_timestamp;
        require!(
            expiry_timestamp > current_time,
            SwapError::InvalidExpiration
        );

        let swap_state = &mut ctx.accounts.swap_state;
        swap_state.maker = ctx.accounts.maker.key();
        swap_state.swap_id = swap_id;
        swap_state.mint_a = ctx.accounts.mint_a.key();
        swap_state.mint_b = ctx.accounts.mint_b.key();
        swap_state.maker_amount = maker_amount;
        swap_state.taker_expected_amount = taker_expected_amount;
        swap_state.expiry_timestamp = expiry_timestamp;
        swap_state.bump = ctx.bumps.swap_state;
        swap_state.vault_bump = ctx.bumps.vault_a;

        // Perform TransferChecked from Maker ATA to PDA Vault A
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.maker_token_a.to_account_info(),
            mint: ctx.accounts.mint_a.to_account_info(),
            to: ctx.accounts.vault_a.to_account_info(),
            authority: ctx.accounts.maker.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
        );

        token_interface::transfer_checked(
            cpi_ctx,
            maker_amount,
            ctx.accounts.mint_a.decimals,
        )?;

        emit!(SwapCreatedEvent {
            swap_id,
            maker: swap_state.maker,
            mint_a: swap_state.mint_a,
            mint_b: swap_state.mint_b,
            maker_amount,
            taker_expected_amount,
            expiry_timestamp,
        });

        Ok(())
    }

    /// Executes the atomic swap. The Taker sends Token B directly to Maker,
    /// and the SwapState PDA releases Token A to the Taker.
    pub fn execute_swap(ctx: Context<ExecuteSwap>) -> Result<()> {
        let current_time = Clock::get()?.unix_timestamp;
        require!(
            current_time <= ctx.accounts.swap_state.expiry_timestamp,
            SwapError::SwapExpired
        );

        let expected_taker_amount = ctx.accounts.swap_state.taker_expected_amount;
        let maker_amount = ctx.accounts.swap_state.maker_amount;

        // Verify Vault Token Balance matches expected deposit
        require!(
            ctx.accounts.vault_a.amount >= maker_amount,
            SwapError::InsufficientVaultBalance
        );

        // 1. Transfer Token B from Taker to Maker
        let taker_to_maker_accounts = TransferChecked {
            from: ctx.accounts.taker_token_b.to_account_info(),
            mint: ctx.accounts.mint_b.to_account_info(),
            to: ctx.accounts.maker_token_b.to_account_info(),
            authority: ctx.accounts.taker.to_account_info(),
        };

        let taker_cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            taker_to_maker_accounts,
        );

        token_interface::transfer_checked(
            taker_cpi_ctx,
            expected_taker_amount,
            ctx.accounts.mint_b.decimals,
        )?;

        // 2. Transfer Token A from Vault to Taker using PDA signing seeds
        let maker_key = ctx.accounts.swap_state.maker;
        let swap_id_bytes = ctx.accounts.swap_state.swap_id.to_le_bytes();
        let bump = ctx.accounts.swap_state.bump;

        let signer_seeds: &[&[&[u8]]] = &[&[
            SWAP_SEED,
            maker_key.as_ref(),
            swap_id_bytes.as_ref(),
            &[bump],
        ]];

        let vault_to_taker_accounts = TransferChecked {
            from: ctx.accounts.vault_a.to_account_info(),
            mint: ctx.accounts.mint_a.to_account_info(),
            to: ctx.accounts.taker_token_a.to_account_info(),
            authority: ctx.accounts.swap_state.to_account_info(),
        };

        let pda_cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            vault_to_taker_accounts,
            signer_seeds,
        );

        token_interface::transfer_checked(
            pda_cpi_ctx,
            maker_amount,
            ctx.accounts.mint_a.decimals,
        )?;

        emit!(SwapExecutedEvent {
            swap_id: ctx.accounts.swap_state.swap_id,
            taker: ctx.accounts.taker.key(),
            maker: ctx.accounts.swap_state.maker,
        });

        // Close Vault and reclaim lamports to Maker via Anchor close constraint
        Ok(())
    }

    /// Reclaims locked assets if the swap has expired or if maker cancels prior to fill.
    pub fn cancel_swap(ctx: Context<CancelSwap>) -> Result<()> {
        let maker_amount = ctx.accounts.vault_a.amount;
        let maker_key = ctx.accounts.swap_state.maker;
        let swap_id_bytes = ctx.accounts.swap_state.swap_id.to_le_bytes();
        let bump = ctx.accounts.swap_state.bump;

        let signer_seeds: &[&[&[u8]]] = &[&[
            SWAP_SEED,
            maker_key.as_ref(),
            swap_id_bytes.as_ref(),
            &[bump],
        ]];

        let refund_accounts = TransferChecked {
            from: ctx.accounts.vault_a.to_account_info(),
            mint: ctx.accounts.mint_a.to_account_info(),
            to: ctx.accounts.maker_token_a.to_account_info(),
            authority: ctx.accounts.swap_state.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            refund_accounts,
            signer_seeds,
        );

        token_interface::transfer_checked(
            cpi_ctx,
            maker_amount,
            ctx.accounts.mint_a.decimals,
        )?;

        emit!(SwapCancelledEvent {
            swap_id: ctx.accounts.swap_state.swap_id,
            maker: maker_key,
        });

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(swap_id: u64)]
pub struct InitializeSwap<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    pub mint_a: InterfaceAccount<'info, Mint>,
    pub mint_b: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = maker_token_a.mint == mint_a.key() @ SwapError::MismatchedTokenAccount,
        constraint = maker_token_a.owner == maker.key() @ SwapError::UnauthorizedOwner
    )]
    pub maker_token_a: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = maker,
        space = 8 + SwapState::INIT_SPACE,
        seeds = [SWAP_SEED, maker.key().as_ref(), swap_id.to_le_bytes().as_ref()],
        bump
    )]
    pub swap_state: Account<'info, SwapState>,

    #[account(
        init,
        payer = maker,
        seeds = [VAULT_SEED, swap_state.key().as_ref()],
        bump,
        token::mint = mint_a,
        token::authority = swap_state,
        token::token_program = token_program
    )]
    pub vault_a: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ExecuteSwap<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    /// CHECK: Validated against swap_state.maker field
    #[account(
        mut,
        address = swap_state.maker @ SwapError::UnauthorizedMaker
    )]
    pub maker: AccountInfo<'info>,

    pub mint_a: InterfaceAccount<'info, Mint>,
    pub mint_b: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [SWAP_SEED, maker.key().as_ref(), swap_state.swap_id.to_le_bytes().as_ref()],
        bump = swap_state.bump,
        close = maker
    )]
    pub swap_state: Account<'info, SwapState>,

    #[account(
        mut,
        seeds = [VAULT_SEED, swap_state.key().as_ref()],
        bump = swap_state.vault_bump,
        token::mint = mint_a,
        token::authority = swap_state,
        token::token_program = token_program
    )]
    pub vault_a: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = taker_token_a.mint == mint_a.key() @ SwapError::MismatchedTokenAccount,
        constraint = taker_token_a.owner == taker.key() @ SwapError::UnauthorizedOwner
    )]
    pub taker_token_a: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = taker_token_b.mint == mint_b.key() @ SwapError::MismatchedTokenAccount,
        constraint = taker_token_b.owner == taker.key() @ SwapError::UnauthorizedOwner
    )]
    pub taker_token_b: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = maker_token_b.mint == mint_b.key() @ SwapError::MismatchedTokenAccount,
        constraint = maker_token_b.owner == maker.key() @ SwapError::UnauthorizedOwner
    )]
    pub maker_token_b: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelSwap<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    pub mint_a: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [SWAP_SEED, maker.key().as_ref(), swap_state.swap_id.to_le_bytes().as_ref()],
        bump = swap_state.bump,
        has_one = maker @ SwapError::UnauthorizedMaker,
        close = maker
    )]
    pub swap_state: Account<'info, SwapState>,

    #[account(
        mut,
        seeds = [VAULT_SEED, swap_state.key().as_ref()],
        bump = swap_state.vault_bump,
        token::mint = mint_a,
        token::authority = swap_state,
        token::token_program = token_program
    )]
    pub vault_a: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = maker_token_a.mint == mint_a.key() @ SwapError::MismatchedTokenAccount,
        constraint = maker_token_a.owner == maker.key() @ SwapError::UnauthorizedOwner
    )]
    pub maker_token_a: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[account]
#[derive(InitSpace)]
pub struct SwapState {
    pub maker: Pubkey,
    pub swap_id: u64,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub maker_amount: u64,
    pub taker_expected_amount: u64,
    pub expiry_timestamp: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[event]
pub struct SwapCreatedEvent {
    pub swap_id: u64,
    pub maker: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub maker_amount: u64,
    pub taker_expected_amount: u64,
    pub expiry_timestamp: i64,
}

#[event]
pub struct SwapExecutedEvent {
    pub swap_id: u64,
    pub taker: Pubkey,
    pub maker: Pubkey,
}

#[event]
pub struct SwapCancelledEvent {
    pub swap_id: u64,
    pub maker: Pubkey,
}

#[error_code]
pub enum SwapError {
    #[msg("Provided trade amount must be greater than zero.")]
    InvalidAmount,
    #[msg("Swap deadline must be in the future.")]
    InvalidExpiration,
    #[msg("Swap deadline has passed.")]
    SwapExpired,
    #[msg("Vault token balance does not meet order requirements.")]
    InsufficientVaultBalance,
    #[msg("Mismatched token account mint or authority.")]
    MismatchedTokenAccount,
    #[msg("Signer does not own the associated token account.")]
    UnauthorizedOwner,
    #[msg("Provided maker account does not match swap state.")]
    UnauthorizedMaker,
}