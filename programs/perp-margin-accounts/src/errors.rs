use anchor_lang::prelude::*;

#[error_code]
pub enum MarginError {
    #[msg("Insufficient margin balance for withdrawal")]
    InsufficientMargin,

    #[msg("Invalid withdrawal amount")]
    InvalidWithdrawalAmount,

    #[msg("Withdrawal timelock not expired")]
    WithdrawalTimelockNotExpired,

    #[msg("No pending withdrawal request")]
    NoPendingWithdrawal,

    #[msg("Invalid authority")]
    InvalidAuthority,

    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,

    #[msg("Account already initialized")]
    AlreadyInitialized,

    #[msg("Negative PnL not large enough to wipe account")]
    InsufficientNegativePnl,

    #[msg("Invalid owner")]
    InvalidOwner,

    #[msg("Unauthorized liquidation")]
    UnauthorizedLiquidation,

    #[msg("Unauthorized account")]
    UnauthorizedAccount,

    #[msg("Existing withdrawal request")]
    ExistingWithdrawalRequest,

    #[msg("Unauthorized execution")]
    UnauthorizedExecution,

    #[msg("Insufficient withdrawable margin")]
    InsufficientWithdrawableMargin,
}
