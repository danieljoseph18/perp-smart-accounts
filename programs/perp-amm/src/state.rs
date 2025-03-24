use anchor_lang::prelude::*;

// -----------------------------------------------
// Context structs for Chainlink usage
// -----------------------------------------------

#[derive(Accounts)]
pub struct UpdateSolUsdPrice<'info> {
    #[account(mut)]
    pub pool_state: Account<'info, PoolState>,

    /// CHECK: This is the Chainlink program's address
    pub chainlink_program: AccountInfo<'info>,

    /// CHECK: This is the Chainlink feed account
    pub chainlink_feed: AccountInfo<'info>,
}

// -----------------------------------------------
// Data structures for the pool
// -----------------------------------------------

/// PoolState holds global info about the liquidity pool.
#[account]
pub struct PoolState {
    /// Admin authority who can withdraw funds and set rewards
    pub admin: Pubkey,

    /// Additional authority that can call admin_deposit and admin_withdraw (e.g. margin program)
    pub authority: Pubkey,

    /// SOL vault account (token account for wrapped SOL or special handling)
    pub sol_vault: Pubkey,

    /// USDC vault account (USDC uses 6 decimals, so 1 USDC = 1_000_000)
    /// Note: While USDC uses 6 decimals, USD values are handled with 8 decimals (1 USD = 100_000_000)
    pub usdc_vault: Pubkey,

    pub usdc_mint: Pubkey,

    /// LP token mint
    pub lp_token_mint: Pubkey,

    /// How many SOL tokens are currently deposited in total (9 decimals, 1 SOL = 1_000_000_000)
    pub sol_deposited: u64,

    /// How many USDC tokens are currently deposited in total (6 decimals, 1 USDC = 1_000_000)
    /// Note: USD values derived from USDC use 8 decimals (1 USD = 100_000_000)
    pub usdc_deposited: u64,

    /// USDC earned per second per LP token (6 decimals)
    /// Note: All USDC amounts use 6 decimals, even though USD values use 8 decimals
    pub tokens_per_interval: u64,

    /// Timestamp when current reward distribution started
    pub reward_start_time: u64,

    /// Timestamp when rewards stop accruing (start + 604800)
    pub reward_end_time: u64,

    /// Vault holding USDC rewards
    pub usdc_reward_vault: Pubkey,

    /// Current SOL/USD price from Chainlink (8 decimals from feed)
    pub sol_usd_price: i128,

    /// How many USDC tokens the admin deposited for this reward period (6 decimals)
    /// Note: These are raw USDC amounts, not USD values
    pub total_rewards_deposited: u64,

    /// How many USDC have actually been claimed by users so far (6 decimals)
    /// Note: These are raw USDC amounts, not USD values
    pub total_rewards_claimed: u64,

    pub cumulative_reward_per_token: u128, // Using u128 for precision

    pub last_distribution_time: u64,

    // -----------------------------------------------
    // Fee tracking fields
    // -----------------------------------------------
    /// Accumulated SOL fees from deposits/withdrawals (9 decimals)
    pub accumulated_sol_fees: u64,

    /// Accumulated USDC fees from deposits/withdrawals (6 decimals)
    /// Note: These are raw USDC amounts, not USD values (which use 8 decimals)
    pub accumulated_usdc_fees: u64,
}

impl PoolState {
    /// Adjust this if you add or remove fields
    pub const LEN: usize = 32  // admin
        + 32                  // authority
        + 32                  // sol_vault
        + 32                  // usdc_vault
        + 32                  // usdc_mint
        + 32                  // lp_token_mint
        + 8                   // sol_deposited
        + 8                   // usdc_deposited
        + 8                   // tokens_per_interval
        + 8                   // reward_start_time
        + 8                   // reward_end_time
        + 32                  // usdc_reward_vault
        + 16                  // sol_usd_price (i128)
        + 8                   // total_rewards_deposited
        + 8                   // total_rewards_claimed
        + 16                  // cumulative_reward_per_token
        + 8                   // last_distribution_time
        + 8                   // accumulated_sol_fees
        + 8; // accumulated_usdc_fees
}

/// UserState stores user-specific info (in practice often combined into a single PDA).
#[account]
pub struct UserState {
    /// User pubkey
    pub owner: Pubkey,

    /// User's LP token balance (tracked within the program, not minted supply)
    pub lp_token_balance: u64,

    /// Last time user claimed (or had rewards updated)
    pub last_claim_timestamp: u64,

    /// Accumulated USDC rewards that have not yet been claimed
    pub pending_rewards: u64,

    /// Previous cumulative reward per token
    pub previous_cumulated_reward_per_token: u128,
}

impl UserState {
    pub const LEN: usize = 32 // owner
        + 8  // lp_token_balance
        + 8  // last_claim_timestamp
        + 8  // pending_rewards
        + 16; // previous_cumulated_reward_per_token
}

// -----------------------------------------------
// Chainlink conversion helpers
// -----------------------------------------------

/// Helper function for SOL -> USD conversions using the `sol_usd_price` from Chainlink.
///
/// Input:
///   - sol_amount: Amount of SOL with 9 decimals (1 SOL = 1_000_000_000)
///   - sol_usd_price: Chainlink price with 8 decimals
/// Output:
///   - USD value with 8 decimals (1 USD = 100_000_000)
pub fn get_sol_usd_value(sol_amount: u64, sol_usd_price: i128) -> Result<u64> {
    // Convert SOL to USD with proper decimal handling:
    // 1. Multiply SOL (9 decimals) by price (8 decimals)
    // 2. Divide by 10^8 (Chainlink decimals) to get to raw USD
    // 3. Divide by 10 (9 - 8 = 1) to convert from 9 to 8 decimals
    let usd = (sol_amount as u128)
        .checked_mul(sol_usd_price as u128)
        .unwrap_or(0)
        .checked_div(100_000_000) // Remove Chainlink's 8 decimals
        .unwrap_or(0)
        .checked_div(10) // Convert from 9 to 8 decimals
        .unwrap_or(0);

    Ok(usd as u64)
}

/// Helper function for USD -> SOL conversions using the `sol_usd_price` from Chainlink.
///
/// Input:
///   - usd_value: USD amount with 8 decimals (1 USD = 100_000_000)
///   - sol_usd_price: Chainlink price with 8 decimals
/// Output:
///   - SOL amount with 9 decimals (1 SOL = 1_000_000_000)
pub fn get_sol_amount_from_usd(usd_value: u64, sol_usd_price: i128) -> Result<u64> {
    let sol = (usd_value as u128)
        .checked_mul(100_000_000) // Add Chainlink's 8 decimals
        .unwrap_or(0)
        .checked_mul(10) // Convert from 8 to 9 decimals
        .unwrap_or(0)
        .checked_div(sol_usd_price as u128)
        .unwrap_or(0);

    Ok(sol as u64)
}
