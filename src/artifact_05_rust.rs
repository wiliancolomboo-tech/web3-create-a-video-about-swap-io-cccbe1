use anchor_lang::prelude::*;

pub const ROUTER_CONFIG_SEED: &[u8] = b"router_config";
pub const ROUTER_VAULT_SEED: &[u8] = b"vault";

#[account]
#[derive(Default)]
pub struct RouterConfig {
    pub admin: Pubkey,
    pub fee_recipient: Pubkey,
    pub fee_basis_points: u16, // e.g. 5 = 0.05%
    pub bump: u8,
    pub total_swaps_routed: u64,
}

impl RouterConfig {
    pub const LEN: usize = 8 + // discriminator
        32 + // admin
        32 + // fee_recipient
        2 +  // fee_basis_points
        1 +  // bump
        8;   // total_swaps_routed
}