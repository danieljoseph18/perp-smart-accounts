use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct MarginAccount {
    /// The owner of this margin account
    pub owner: Pubkey,
    /// The amount of SOL margin deposited
    pub sol_balance: u64,
    /// The amount of USDC margin deposited
    pub usdc_balance: u64,
    /// Pending withdrawal amount in SOL
    pub pending_sol_withdrawal: u64,
    /// Pending withdrawal amount in USDC
    pub pending_usdc_withdrawal: u64,
    /// Timestamp of the last withdrawal request
    pub last_withdrawal_request: i64,
    /// Bump seed for PDA derivation
    pub bump: u8,
}

// Maximum number of authorities allowed
pub const MAX_AUTHORITIES: usize = 10;

#[account]
pub struct MarginVault {
    /// The token account holding SOL margin deposits
    pub margin_sol_vault: Pubkey,
    /// The token account holding USDC margin deposits
    pub margin_usdc_vault: Pubkey,
    /// Authorities that can perform admin operations
    pub authorities: Vec<Pubkey>,
    /// Minimum time required between withdrawal request and execution (in seconds)
    pub withdrawal_timelock: i64,
    /// Bump seed for PDA derivation
    pub bump: u8,
    /// Accumulated SOL fees
    pub sol_fees_accumulated: u64,
    /// Accumulated USDC fees
    pub usdc_fees_accumulated: u64,
    /// Chainlink program ID
    pub chainlink_program: Pubkey,
    /// Chainlink SOL/USD price feed
    pub chainlink_feed: Pubkey,
}

impl MarginAccount {
    pub const LEN: usize = 8 + // discriminator
        32 + // owner
        8 + // sol_balance
        8 + // usdc_balance
        8 + // pending_sol_withdrawal
        8 + // pending_usdc_withdrawal
        8 + // last_withdrawal_request
        1; // bump
}

impl MarginVault {
    // Base size not including variable length authorities
    pub const BASE_LEN: usize = 8 + // discriminator
        32 + // sol_vault
        32 + // usdc_vault
        8 + // withdrawal_timelock
        1 + // bump
        8 + // sol_fees_accumulated
        8 + // usdc_fees_accumulated
        32 + // chainlink_program
        32; // chainlink_feed
        
    // Maximum size with max authorities allocation
    pub const MAX_LEN: usize = Self::BASE_LEN + 
        4 + // vec discriminator
        (32 * MAX_AUTHORITIES); // pubkeys in authorities vec
}

impl MarginVault {
    /// Check if a public key is an authorized authority
    pub fn is_authority(&self, key: &Pubkey) -> bool {
        self.authorities.iter().any(|auth| auth == key)
    }
}
