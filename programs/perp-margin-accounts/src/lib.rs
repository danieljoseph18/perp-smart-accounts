use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("brrFTzk9JScspG4H1sqthrQHnJoBBg9BA8v31Bn8V3R");

#[program]
pub mod perp_margin_accounts {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>, 
        withdrawal_timelock: i64,
        chainlink_program: Pubkey,
        chainlink_feed: Pubkey,
    ) -> Result<()> {
        instructions::initialize::handle_initialize(
            ctx, 
            withdrawal_timelock, 
            chainlink_program, 
            chainlink_feed
        )
    }

    pub fn deposit_margin(ctx: Context<DepositMargin>, amount: u64) -> Result<()> {
        instructions::deposit::handle_deposit_margin(ctx, amount)
    }

    pub fn request_withdrawal(
        ctx: Context<RequestWithdrawal>,
        sol_amount: u64,
        usdc_amount: u64,
    ) -> Result<()> {
        instructions::withdraw::request_withdrawal(ctx, sol_amount, usdc_amount)
    }

    pub fn execute_withdrawal(
        ctx: Context<ExecuteWithdrawal>,
        pnl_update: i64,
        locked_sol: u64,
        locked_usdc: u64,
        sol_fees_owed: u64,
        usdc_fees_owed: u64,
    ) -> Result<()> {
        instructions::withdraw::execute_withdrawal(
            ctx,
            pnl_update,
            locked_sol,
            locked_usdc,
            sol_fees_owed,
            usdc_fees_owed,
        )
    }

    pub fn liquidate_margin_account(ctx: Context<LiquidateMarginAccount>) -> Result<()> {
        instructions::liquidate::handle_liquidate_margin_account(ctx)
    }

    pub fn cancel_withdrawal(ctx: Context<CancelWithdrawal>) -> Result<()> {
        instructions::withdraw::cancel_withdrawal(ctx)
    }

    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        instructions::claim_fees::handle_claim_fees(ctx)
    }

    pub fn update_chainlink_addresses(
        ctx: Context<UpdateChainlinkAddresses>,
        chainlink_program: Pubkey,
        chainlink_feed: Pubkey,
    ) -> Result<()> {
        instructions::update_chainlink_addresses::handle_update_chainlink_addresses(
            ctx,
            chainlink_program,
            chainlink_feed
        )
    }
}
