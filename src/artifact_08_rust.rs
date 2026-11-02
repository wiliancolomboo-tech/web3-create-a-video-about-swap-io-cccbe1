use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
use instructions::swap::SwapRouteParams;

declare_id!("Swp1oRouter1111111111111111111111111111111111");

#[program]
pub mod swap_io_router {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, fee_basis_points: u16) -> Result<()> {
        instructions::initialize::handler(ctx, fee_basis_points)
    }

    pub fn execute_swap(ctx: Context<ExecuteSwap>, params: SwapRouteParams) -> Result<()> {
        instructions::swap::handler(ctx, params)
    }
}