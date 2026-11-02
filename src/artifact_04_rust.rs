use anchor_lang::prelude::*;

#[error_code]
pub enum SwapError {
    #[msg("Slippage Exceeded: The realized output tokens are below minimum threshold.")]
    SlippageExceeded,
    #[msg("Deadline Passed: The route transaction reached execution past its expiry timestamp.")]
    DeadlineExceeded,
    #[msg("Invalid Route Weight: Route percentages do not sum exactly to 10000 basis points.")]
    InvalidRouteSplit,
    #[msg("Zero Output Received: Route produced an empty balance delta.")]
    ZeroOutput,
    #[msg("Numerical Overflow: Arithmetic operation resulted in overflow.")]
    MathOverflow,
}