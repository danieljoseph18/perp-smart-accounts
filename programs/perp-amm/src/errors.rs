use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("User has insufficient LP token balance.")]
    InsufficientLpBalance,
    #[msg("Only admin can call this function.")]
    Unauthorized,
    #[msg("Overflow or math error.")]
    MathError,
    #[msg("Rewards have ended.")]
    RewardsEnded,
    #[msg("Invalid token mint provided.")]
    InvalidTokenMint,
    #[msg("Invalid owner.")]
    InvalidOwner,
    #[msg("Rewards have not started yet.")]
    RewardsNotStarted,
    #[msg("No LP tokens found.")]
    NoLPTokens,
    #[msg("Insufficient reward balance.")]
    InsufficientRewardBalance,
    #[msg("Token account not provided when required")]
    TokenAccountNotProvided,
    #[msg("Invalid token account provided")]
    InvalidTokenAccount,
    #[msg("Insufficient funds to withdraw")]
    InsufficientFunds,
    #[msg("Invalid token amount provided")]
    InvalidTokenAmount,
    #[msg("Previous period has not ended.")]
    PreviousPeriodNotEnded,
    #[msg("Invalid reward vault provided.")]
    InvalidRewardVault,
    #[msg("Authority already exists")]
    AuthorityAlreadyExists,
    #[msg("Maximum number of authorities reached")]
    MaxAuthoritiesReached,
    #[msg("Cannot remove the last authority")]
    CannotRemoveLastAuthority,
    #[msg("Authority not found")]
    AuthorityNotFound,
    #[msg("Invalid PDA address")]
    InvalidPdaAddress,
}

// For backward compatibility with existing code
pub type VaultError = ErrorCode;
