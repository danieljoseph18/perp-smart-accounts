use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;
pub mod util;

use instructions::*;

declare_id!("2z7zR7pYghoDAUQ2rVZHxvxJuXV2HeTpzofaGispVxMZ");

#[program]
pub mod perp_margin_accounts {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        withdrawal_timelock: i64,
        chainlink_program: Pubkey,
        chainlink_feed: Pubkey,
    ) -> Result<()> {
        instructions::initialize::initialize(
            ctx,
            withdrawal_timelock,
            chainlink_program,
            chainlink_feed,
        )
    }

    pub fn deposit_margin(ctx: Context<DepositMargin>, amount: u64) -> Result<()> {
        instructions::deposit::deposit_margin(ctx, amount)
    }

    pub fn request_withdrawal(
        ctx: Context<RequestWithdrawal>,
        amount: u64,
        is_sol: bool,
    ) -> Result<()> {
        instructions::request_withdrawal::request_withdrawal(ctx, amount, is_sol)
    }

    pub fn execute_withdrawal(
        ctx: Context<ExecuteWithdrawal>,
        pnl_update: i64,
        locked_sol: u64,
        locked_usdc: u64,
        sol_fees_owed: u64,
        usdc_fees_owed: u64,
    ) -> Result<()> {
        instructions::execute_withdrawal::execute_withdrawal(
            ctx,
            pnl_update,
            locked_sol,
            locked_usdc,
            sol_fees_owed,
            usdc_fees_owed,
        )
    }

    pub fn liquidate_margin_account(ctx: Context<LiquidateMarginAccount>) -> Result<()> {
        instructions::liquidate::liquidate_margin_account(ctx)
    }

    pub fn cancel_withdrawal(ctx: Context<CancelWithdrawal>) -> Result<()> {
        instructions::cancel_withdrawal::cancel_withdrawal(ctx)
    }

    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        instructions::claim_fees::claim_fees(ctx)
    }

    pub fn add_authority(ctx: Context<AddAuthority>, new_authority: Pubkey) -> Result<()> {
        instructions::add_authority::add_authority(ctx, new_authority)
    }

    pub fn remove_authority(
        ctx: Context<RemoveAuthority>,
        authority_to_remove: Pubkey,
    ) -> Result<()> {
        instructions::remove_authority::remove_authority(ctx, authority_to_remove)
    }
}
