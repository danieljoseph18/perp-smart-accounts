use crate::errors::MarginError;
use crate::state::{MarginAccount, MarginVault};
use crate::util::fees::process_fees;
use crate::util::pnl::process_pnl_update;
use crate::util::validate::validate_balances;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use perp_amm::{program::PerpAmm, state::PoolState};

#[derive(Accounts)]
pub struct ExecuteWithdrawal<'info> {
    #[account(
        mut,
        seeds = [b"margin_account", margin_account.owner.as_ref()],
        bump = margin_account.bump,
        constraint = margin_account.pending_sol_withdrawal > 0 || margin_account.pending_usdc_withdrawal > 0 @ MarginError::NoPendingWithdrawal
    )]
    pub margin_account: Account<'info, MarginAccount>,

    #[account(
        seeds = [b"margin_vault"],
        bump = margin_vault.bump,
        constraint = authority.key() == margin_vault.authority @ MarginError::InvalidAuthority
    )]
    pub margin_vault: Account<'info, MarginVault>,

    #[account(
        mut,
        constraint = margin_sol_vault.key() == margin_vault.margin_sol_vault
    )]
    pub margin_sol_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = margin_usdc_vault.key() == margin_vault.margin_usdc_vault
    )]
    pub margin_usdc_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_sol_account.owner == margin_account.owner
    )]
    pub user_sol_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_usdc_account.owner == margin_account.owner
    )]
    pub user_usdc_account: Account<'info, TokenAccount>,

    /// The liquidity pool's state account
    #[account(
        mut,
        seeds = [b"pool_state".as_ref()],
        bump
    )]
    pub pool_state: Account<'info, PoolState>,

    /// The liquidity pool's vault account that matches the token being withdrawn
    #[account(
        mut,
        constraint = pool_vault_account.key() == pool_state.sol_vault || pool_vault_account.key() == pool_state.usdc_vault
    )]
    pub pool_vault_account: Account<'info, TokenAccount>,

    /// CHECK: Validated in constraint against stored value in margin vault
    #[account(address = margin_vault.chainlink_program)]
    pub chainlink_program: AccountInfo<'info>,

    /// CHECK: Validated in constraint against stored value in margin vault
    #[account(address = margin_vault.chainlink_feed)]
    pub chainlink_feed: AccountInfo<'info>,

    #[account(
        constraint = authority.key() == margin_vault.authority @ MarginError::UnauthorizedExecution
    )]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub liquidity_pool_program: Program<'info, PerpAmm>,
    pub system_program: Program<'info, System>,
}

// Split the function to reduce stack usage
pub fn handler(
    mut ctx: Context<ExecuteWithdrawal>,
    pnl_update: i64,
    locked_sol: u64,
    locked_usdc: u64,
    sol_fees_owed: u64,
    usdc_fees_owed: u64,
) -> Result<()> {
    // Process fees
    process_fees(
        &mut ctx.accounts.margin_account,
        &mut ctx.accounts.margin_vault,
        sol_fees_owed,
        usdc_fees_owed,
    )?;

    // Validate balances against locked amounts
    validate_balances(&ctx.accounts.margin_account, locked_sol, locked_usdc)?;

    // Process PnL updates if needed
    if pnl_update != 0 {
        process_pnl_update(&mut ctx, pnl_update)?;
    }

    // Process withdrawals
    process_withdrawals(&mut ctx)?;

    Ok(())
}

// Helper function to process withdrawals
fn process_withdrawals(ctx: &mut Context<ExecuteWithdrawal>) -> Result<()> {
    let margin_account = &mut ctx.accounts.margin_account;

    // Process SOL withdrawal if pending.
    if margin_account.pending_sol_withdrawal > 0 {
        let sol_amount = margin_account.pending_sol_withdrawal;
        margin_account.sol_balance = margin_account
            .sol_balance
            .checked_sub(sol_amount)
            .ok_or(MarginError::ArithmeticOverflow)?;

        let seeds = &[b"margin_vault".as_ref(), &[ctx.accounts.margin_vault.bump]];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.margin_sol_vault.to_account_info(),
            to: ctx.accounts.user_sol_account.to_account_info(),
            authority: ctx.accounts.margin_vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::transfer(cpi_ctx, sol_amount)?;
    }

    // Process USDC withdrawal if pending.
    if margin_account.pending_usdc_withdrawal > 0 {
        let usdc_amount = margin_account.pending_usdc_withdrawal;
        margin_account.usdc_balance = margin_account
            .usdc_balance
            .checked_sub(usdc_amount)
            .ok_or(MarginError::ArithmeticOverflow)?;

        let seeds = &[b"margin_vault".as_ref(), &[ctx.accounts.margin_vault.bump]];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.margin_usdc_vault.to_account_info(),
            to: ctx.accounts.user_usdc_account.to_account_info(),
            authority: ctx.accounts.margin_vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::transfer(cpi_ctx, usdc_amount)?;
    }

    // Clear pending withdrawals.
    margin_account.pending_sol_withdrawal = 0;
    margin_account.pending_usdc_withdrawal = 0;

    Ok(())
}
