use anchor_lang::prelude::*;

use instructions::*;

pub mod errors;
pub mod instructions;
pub mod state;

// Single program ID for this entire program
declare_id!("brriXKXk4fveoRhSSVPdxJPjNoSEEjRyR7i5mGbFD1D");

pub const NATIVE_MINT: &str = "So11111111111111111111111111111111111111112";

// Chainlink Program ID (same on all networks)
pub const CHAINLINK_PROGRAM_ID: &str = "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny";

// SOL/USD Price Feed Addresses
pub const MAINNET_SOL_PRICE_FEED: &str = "CH31Xns5z3M1cTAbKW34jcxPPciazARpijcHj9rxtemt";
pub const DEVNET_SOL_PRICE_FEED: &str = "99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR";

#[event]
pub struct RewardsClaimed {
    pub user: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
    pub total_claimed: u64,
}

/// The main vault program.
/// It includes instructions for initialize, deposit, withdraw, admin deposit/withdraw, etc.
#[program]
pub mod perp_amm {
    use super::*;

    /// Initialize the liquidity pool
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::handle_initialize(ctx)
    }

    /// Close the pool (admin only)
    pub fn close_pool(ctx: Context<ClosePool>) -> Result<()> {
        instructions::close_pool::handle_close_pool(ctx)
    }

    /// Close the user state (user only)
    pub fn close_user_state(ctx: Context<CloseUserState>) -> Result<()> {
        instructions::close_user_state::handle_close_user_state(ctx)
    }

    /// Deposit SOL or USDC into the pool
    pub fn deposit(ctx: Context<Deposit>, token_amount: u64) -> Result<()> {
        instructions::deposit::handle_deposit(ctx, token_amount)
    }

    /// Withdraw tokens from the pool
    pub fn withdraw(ctx: Context<Withdraw>, lp_token_amount: u64) -> Result<()> {
        instructions::withdraw::handle_withdraw(ctx, lp_token_amount)
    }

    /// Admin function to withdraw tokens (market making losses)
    pub fn admin_withdraw(ctx: Context<AdminWithdraw>, amount: u64) -> Result<()> {
        instructions::admin_withdraw::handle_admin_withdraw(ctx, amount)
    }

    /// Admin function to deposit tokens (market making profits)
    pub fn admin_deposit(ctx: Context<AdminDeposit>, amount: u64) -> Result<()> {
        instructions::admin_deposit::handle_admin_deposit(ctx, amount)
    }

    /// Admin function to start new reward distribution
    pub fn start_rewards(ctx: Context<StartRewards>, usdc_amount: u64) -> Result<()> {
        instructions::start_rewards::handle_start_rewards(ctx, usdc_amount)
    }

    /// Claim user rewards
    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        instructions::claim_rewards::handle_claim_rewards(ctx)
    }

    pub fn force_close_user_state(ctx: Context<ForceCloseUserState>) -> Result<()> {
        instructions::force_close_user_state::handle_force_close_user_state(ctx)
    }

    /// Admin function to claim accumulated fees
    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        instructions::claim_fees::handle_claim_fees(ctx)
    }
}
