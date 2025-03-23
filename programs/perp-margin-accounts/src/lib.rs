use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;
pub mod util;

use instructions::*;

declare_id!("BLywAsuyCkiC2gja3bRf8x3xxC2RPf4DDGwNauT8idZ5");

#[program]
pub mod perp_margin_accounts {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        withdrawal_timelock: i64,
        chainlink_program: Pubkey,
        chainlink_feed: Pubkey,
    ) -> Result<()> {
        instructions::initialize::handler(
            ctx,
            withdrawal_timelock,
            chainlink_program,
            chainlink_feed,
        )
    }

    pub fn deposit_margin(ctx: Context<DepositMargin>, amount: u64) -> Result<()> {
        instructions::deposit::handler(ctx, amount)
    }

    pub fn request_withdrawal(
        ctx: Context<RequestWithdrawal>,
        sol_amount: u64,
        usdc_amount: u64,
    ) -> Result<()> {
        instructions::request_withdraw::handler(ctx, sol_amount, usdc_amount)
    }

    pub fn execute_withdrawal(
        ctx: Context<ExecuteWithdrawal>,
        pnl_update: i64,
        locked_sol: u64,
        locked_usdc: u64,
        sol_fees_owed: u64,
        usdc_fees_owed: u64,
    ) -> Result<()> {
        instructions::execute_withdraw::handler(
            ctx,
            pnl_update,
            locked_sol,
            locked_usdc,
            sol_fees_owed,
            usdc_fees_owed,
        )
    }

    pub fn liquidate_margin_account(ctx: Context<LiquidateMarginAccount>) -> Result<()> {
        instructions::liquidate::handler(ctx)
    }

    pub fn cancel_withdrawal(ctx: Context<CancelWithdrawal>) -> Result<()> {
        instructions::cancel_withdraw::handler(ctx)
    }

    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        instructions::claim_fees::handler(ctx)
    }
}
