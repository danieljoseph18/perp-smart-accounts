use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
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

    #[msg("Position is liquidatable")]
    LiquidatablePosition,

    #[msg("Zero deposit amount")]
    ZeroDepositAmount,
    
    #[msg("Unauthorized operation")]
    Unauthorized,
    
    #[msg("Authority already exists")]
    AuthorityAlreadyExists,
    
    #[msg("Maximum number of authorities reached")]
    MaxAuthoritiesReached,
    
    #[msg("Cannot remove the last authority")]
    CannotRemoveLastAuthority,
    
    #[msg("Authority not found")]
    AuthorityNotFound,
}

// For backward compatibility with existing code
pub type MarginError = ErrorCode;
