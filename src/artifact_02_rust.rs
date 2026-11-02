use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("Swap1o1111111111111111111111111111111111111");

pub const ESCROW_SEED: &[u8] = b"swap_escrow";
pub const VAULT_AUTH_SEED: &[u8] = b"vault_authority";

#[program]
pub mod swap_io_core {
    use super::*;

    /// Initializes an atomic swap escrow, depositing token_a into program custody.
    pub fn initialize_swap(
        ctx: Context<InitializeSwap>,
        seed: u64,
        maker_amount_in: u64,
        taker_expected_amount_out: u64,
        expiry_slot: u64,
    ) -> Result<()> {
        require_gt!(maker_amount_in, 0, SwapError::InvalidAmount);
        require_gt!(taker_expected_amount_out, 0, SwapError::InvalidAmount);
        
        let current_slot = Clock::get()?.slot;
        require_gt!(expiry_slot, current_slot, SwapError::InvalidExpiry);

        let escrow = &mut ctx.accounts.escrow_state;
        escrow.maker = ctx.accounts.maker.key();
        escrow.maker_token_a_mint = ctx.accounts.token_a_mint.key();
        escrow.taker_token_b_mint = ctx.accounts.token_b_mint.key();
        escrow.maker_amount_in = maker_amount_in;
        escrow.taker_expected_amount_out = taker_expected_amount_out;
        escrow.expiry_slot = expiry_slot;
        escrow.seed = seed;
        escrow.bump = ctx.bumps.escrow_state;
        escrow.vault_auth_bump = ctx.bumps.vault_authority;

        // Perform checked transfer from Maker to PDA Vault
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program_a.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.maker_token_a.to_account_info(),
                    mint: ctx.accounts.token_a_mint.to_account_info(),
                    to: ctx.accounts.vault_token_a.to_account_info(),
                    authority: ctx.accounts.maker.to_account_info(),
                },
            ),
            maker_amount_in,
            ctx.accounts.token_a_mint.decimals,
        )?;

        emit!(SwapInitialized {
            maker: escrow.maker,
            escrow: escrow.key(),
            amount_in: maker_amount_in,
            expected_out: taker_expected_amount_out,
            expiry_slot,
        });

        Ok(())
    }

    /// Fulfills the swap: Taker pays Token B to Maker, Vault releases Token A to Taker.
    pub fn execute_swap(ctx: Context<ExecuteSwap>) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        require!(
            current_slot <= ctx.accounts.escrow_state.expiry_slot,
            SwapError::SwapExpired
        );

        let amount_b = ctx.accounts.escrow_state.taker_expected_amount_out;
        let amount_a = ctx.accounts.escrow_state.maker_amount_in;

        // 1. Taker transfers Token B to Maker
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program_b.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.taker_token_b.to_account_info(),
                    mint: ctx.accounts.token_b_mint.to_account_info(),
                    to: ctx.accounts.maker_token_b.to_account_info(),
                    authority: ctx.accounts.taker.to_account_info(),
                },
            ),
            amount_b,
            ctx.accounts.token_b_mint.decimals,
        )?;

        // 2. Vault transfers Token A to Taker using Vault Authority PDA seeds
        let escrow_key = ctx.accounts.escrow_state.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            VAULT_AUTH_SEED,
            escrow_key.as_ref(),
            &[ctx.accounts.escrow_state.vault_auth_bump],
        ]];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program_a.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token_a.to_account_info(),
                    mint: ctx.accounts.token_a_mint.to_account_info(),
                    to: ctx.accounts.taker_token_a.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount_a,
            ctx.accounts.token_a_mint.decimals,
        )?;

        // 3. Close Vault Token Account and refund rent to Maker
        token_interface::close_account(
            CpiContext::new_with_signer(
                ctx.accounts.token_program_a.to_account_info(),
                token_interface::CloseAccount {
                    account: ctx.accounts.vault_token_a.to_account_info(),
                    destination: ctx.accounts.maker.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
        )?;

        emit!(SwapExecuted {
            escrow: ctx.accounts.escrow_state.key(),
            maker: ctx.accounts.maker.key(),
            taker: ctx.accounts.taker.key(),
            amount_in: amount_a,
            amount_out: amount_b,
        });

        Ok(())
    }

    /// Allows Maker to cancel the swap and retrieve tokens if expired or unfulfilled.
    pub fn cancel_swap(ctx: Context<CancelSwap>) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        require!(
            current_slot > ctx.accounts.escrow_state.expiry_slot,
            SwapError::SwapNotExpired
        );

        let amount_a = ctx.accounts.escrow_state.maker_amount_in;
        let escrow_key = ctx.accounts.escrow_state.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            VAULT_AUTH_SEED,
            escrow_key.as_ref(),
            &[ctx.accounts.escrow_state.vault_auth_bump],
        ]];

        // Return Token A to Maker
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program_a.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token_a.to_account_info(),
                    mint: ctx.accounts.token_a_mint.to_account_info(),
                    to: ctx.accounts.maker_token_a.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount_a,
            ctx.accounts.token_a_mint.decimals,
        )?;

        // Close Vault Token Account
        token_interface::close_account(
            CpiContext::new_with_signer(
                ctx.accounts.token_program_a.to_account_info(),
                token_interface::CloseAccount {
                    account: ctx.accounts.vault_token_a.to_account_info(),
                    destination: ctx.accounts.maker.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
        )?;

        emit!(SwapCancelled {
            escrow: ctx.accounts.escrow_state.key(),
            maker: ctx.accounts.maker.key(),
            refunded_amount: amount_a,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct InitializeSwap<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    pub token_a_mint: InterfaceAccount<'info, Mint>,
    pub token_b_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = token_a_mint,
        associated_token::authority = maker,
        associated_token::token_program = token_program_a,
    )]
    pub maker_token_a: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = maker,
        space = 8 + EscrowState::INIT_SPACE,
        seeds = [ESCROW_SEED, maker.key().as_ref(), seed.to_le_bytes().as_ref()],
        bump
    )]
    pub escrow_state: Account<'info, EscrowState>,

    /// CHECK: PDA delegate authority for vault token actions.
    #[account(
        seeds = [VAULT_AUTH_SEED, escrow_state.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = maker,
        token::mint = token_a_mint,
        token::authority = vault_authority,
        token::token_program = token_program_a,
    )]
    pub vault_token_a: InterfaceAccount<'info, TokenAccount>,

    pub token_program_a: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ExecuteSwap<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    /// CHECK: Validated against escrow_state.maker. Receives rent rebate on escrow closure.
    #[account(mut, address = escrow_state.maker @ SwapError::UnauthorizedMaker)]
    pub maker: UncheckedAccount<'info>,

    pub token_a_mint: InterfaceAccount<'info, Mint>,
    pub token_b_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, maker.key().as_ref(), escrow_state.seed.to_le_bytes().as_ref()],
        bump = escrow_state.bump,
        close = maker
    )]
    pub escrow_state: Account<'info, EscrowState>,

    /// CHECK: Validated PDA authority.
    #[account(
        seeds = [VAULT_AUTH_SEED, escrow_state.key().as_ref()],
        bump = escrow_state.vault_auth_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = token_a_mint,
        token::authority = vault_authority,
        token::token_program = token_program_a,
    )]
    pub vault_token_a: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = token_a_mint,
        associated_token::authority = taker,
        associated_token::token_program = token_program_a,
    )]
    pub taker_token_a: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = token_b_mint,
        associated_token::authority = taker,
        associated_token::token_program = token_program_b,
    )]
    pub taker_token_b: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = token_b_mint,
        associated_token::authority = maker,
        associated_token::token_program = token_program_b,
    )]
    pub maker_token_b: InterfaceAccount<'info, TokenAccount>,

    pub token_program_a: Interface<'info, TokenInterface>,
    pub token_program_b: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelSwap<'info> {
    #[account(mut, address = escrow_state.maker @ SwapError::UnauthorizedMaker)]
    pub maker: Signer<'info>,

    pub token_a_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, maker.key().as_ref(), escrow_state.seed.to_le_bytes().as_ref()],
        bump = escrow_state.bump,
        close = maker
    )]
    pub escrow_state: Account<'info, EscrowState>,

    /// CHECK: PDA delegate authority.
    #[account(
        seeds = [VAULT_AUTH_SEED, escrow_state.key().as_ref()],
        bump = escrow_state.vault_auth_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = token_a_mint,
        token::authority = vault_authority,
        token::token_program = token_program_a,
    )]
    pub vault_token_a: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = token_a_mint,
        associated_token::authority = maker,
        associated_token::token_program = token_program_a,
    )]
    pub maker_token_a: InterfaceAccount<'info, TokenAccount>,

    pub token_program_a: Interface<'info, TokenInterface>,
}

// -----------------------------------------------------------------------------
// STATE & EVENTS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct EscrowState {
    pub maker: Pubkey,                  // 32
    pub maker_token_a_mint: Pubkey,     // 32
    pub taker_token_b_mint: Pubkey,     // 32
    pub maker_amount_in: u64,           // 8
    pub taker_expected_amount_out: u64, // 8
    pub expiry_slot: u64,               // 8
    pub seed: u64,                      // 8
    pub bump: u8,                       // 1
    pub vault_auth_bump: u8,            // 1
}

#[event]
pub struct SwapInitialized {
    pub maker: Pubkey,
    pub escrow: Pubkey,
    pub amount_in: u64,
    pub expected_out: u64,
    pub expiry_slot: u64,
}

#[event]
pub struct SwapExecuted {
    pub escrow: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
}

#[event]
pub struct SwapCancelled {
    pub escrow: Pubkey,
    pub maker: Pubkey,
    pub refunded_amount: u64,
}

#[error_code]
pub enum SwapError {
    #[msg("Transfer amount must be strictly greater than zero.")]
    InvalidAmount,
    #[msg("Expiry slot must be ahead of the current cluster slot.")]
    InvalidExpiry,
    #[msg("Swap deadline has already passed.")]
    SwapExpired,
    #[msg("Swap has not expired yet; maker cannot cancel.")]
    SwapNotExpired,
    #[msg("Unauthorized: Signer does not match the original escrow maker.")]
    UnauthorizedMaker,
}