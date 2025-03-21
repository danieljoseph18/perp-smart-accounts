use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{MarginAccount, MarginVault};
use crate::errors::MarginError;
use perp_amm::{
    state::PoolState,
    cpi::{admin_withdraw, admin_deposit},
    program::PerpAmm,
};

#[derive(Accounts)]
pub struct RequestWithdrawal<'info> {
    #[account(
        mut,
        seeds = [b"margin_account", owner.key().as_ref()],
        bump = margin_account.bump,
        constraint = margin_account.owner == owner.key() @ MarginError::UnauthorizedAccount,
        constraint = margin_account.pending_sol_withdrawal == 0 && 
                    margin_account.pending_usdc_withdrawal == 0 @ MarginError::ExistingWithdrawalRequest
    )]
    pub margin_account: Account<'info, MarginAccount>,

    #[account(
        seeds = [b"margin_vault"],
        bump = margin_vault.bump,
    )]
    pub margin_vault: Account<'info, MarginVault>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteWithdrawal<'info> {
    #[account(
        mut,
        seeds = [b"margin_account", margin_account.owner.as_ref()],
        bump = margin_account.bump,
        constraint = margin_account.pending_sol_withdrawal > 0 || 
                    margin_account.pending_usdc_withdrawal > 0 @ MarginError::NoPendingWithdrawal
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
        constraint = pool_vault_account.key() == pool_state.sol_vault || 
                    pool_vault_account.key() == pool_state.usdc_vault
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

#[derive(Accounts)]
pub struct CancelWithdrawal<'info> {
    #[account(
        mut,
        seeds = [b"margin_account", margin_account.owner.as_ref()],
        bump = margin_account.bump,
        constraint = margin_account.pending_sol_withdrawal > 0 || 
                    margin_account.pending_usdc_withdrawal > 0 @ MarginError::NoPendingWithdrawal
    )]
    pub margin_account: Account<'info, MarginAccount>,

    #[account(
        seeds = [b"margin_vault"],
        bump = margin_vault.bump,
        constraint = authority.key() == margin_vault.authority @ MarginError::InvalidAuthority
    )]
    pub margin_vault: Account<'info, MarginVault>,

    #[account(
        constraint = authority.key() == margin_vault.authority @ MarginError::UnauthorizedExecution
    )]
    pub authority: Signer<'info>,
}

// No check for margin amount, as positive PNL may increase this.
// Margin amount is checked in execute_withdrawal.
pub fn request_withdrawal(
    ctx: Context<RequestWithdrawal>,
    sol_amount: u64,
    usdc_amount: u64,
) -> Result<()> {
    let margin_account = &mut ctx.accounts.margin_account;
    let clock = Clock::get()?;

    // Verify timelock has passed since last withdrawal request
    require!(
        clock.unix_timestamp >= margin_account.last_withdrawal_request + 
            ctx.accounts.margin_vault.withdrawal_timelock,
        MarginError::WithdrawalTimelockNotExpired
    );

    margin_account.pending_sol_withdrawal = sol_amount;
    margin_account.pending_usdc_withdrawal = usdc_amount;
    margin_account.last_withdrawal_request = clock.unix_timestamp;

    Ok(())
}

// Split the function to reduce stack usage
pub fn execute_withdrawal(
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
        usdc_fees_owed
    )?;
    
    // Validate balances against locked amounts
    validate_balances(
        &ctx.accounts.margin_account,
        locked_sol,
        locked_usdc
    )?;
    
    // Process PnL updates if needed
    if pnl_update != 0 {
        process_pnl_update(
            &mut ctx,
            pnl_update
        )?;
    }
    
    // Process withdrawals
    process_withdrawals(&mut ctx)?;
    
    Ok(())
}

// Helper function to process fees
fn process_fees(
    margin_account: &mut MarginAccount,
    margin_vault: &mut MarginVault,
    sol_fees_owed: u64,
    usdc_fees_owed: u64
) -> Result<()> {
    // Deduct SOL fees
    if sol_fees_owed > 0 {
        require!(
            margin_account.sol_balance >= sol_fees_owed,
            MarginError::InsufficientMargin 
        );
        margin_account.sol_balance = margin_account.sol_balance
            .checked_sub(sol_fees_owed)
            .ok_or(MarginError::ArithmeticOverflow)?;
        margin_vault.sol_fees_accumulated = margin_vault.sol_fees_accumulated
            .checked_add(sol_fees_owed)
            .ok_or(MarginError::ArithmeticOverflow)?;
    }
    
    // Deduct USDC fees
    if usdc_fees_owed > 0 {
        require!(
            margin_account.usdc_balance >= usdc_fees_owed,
            MarginError::InsufficientMargin
        );
        margin_account.usdc_balance = margin_account.usdc_balance
            .checked_sub(usdc_fees_owed)
            .ok_or(MarginError::ArithmeticOverflow)?;
        margin_vault.usdc_fees_accumulated = margin_vault.usdc_fees_accumulated
            .checked_add(usdc_fees_owed)
            .ok_or(MarginError::ArithmeticOverflow)?;
    }
    
    Ok(())
}

// Helper function to validate balances
fn validate_balances(
    margin_account: &MarginAccount,
    locked_sol: u64,
    locked_usdc: u64
) -> Result<()> {
    // Calculate available balances
    let available_sol = margin_account.sol_balance
        .checked_sub(locked_sol)
        .ok_or(MarginError::ArithmeticOverflow)?;
    let available_usdc = margin_account.usdc_balance
        .checked_sub(locked_usdc)
        .ok_or(MarginError::ArithmeticOverflow)?;

    // Check that pending withdrawals are <= available balances
    if margin_account.pending_sol_withdrawal > 0 {
        require!(
            available_sol >= margin_account.pending_sol_withdrawal,
            MarginError::InsufficientWithdrawableMargin
        );
    }
    if margin_account.pending_usdc_withdrawal > 0 {
        require!(
            available_usdc >= margin_account.pending_usdc_withdrawal,
            MarginError::InsufficientWithdrawableMargin
        );
    }
    
    Ok(())
}

// Helper function to process PnL updates
fn process_pnl_update(ctx: &mut Context<ExecuteWithdrawal>, pnl_update: i64) -> Result<()> {
    let margin_account = &mut ctx.accounts.margin_account;
    
    // Convert pnl_update to a u128 and upscale from 6 to 8 decimals.
    let pnl_total_usd = pnl_update.unsigned_abs() as u128;
    let pnl_total_adj = pnl_total_usd
        .checked_mul(100)
        .ok_or(MarginError::ArithmeticOverflow)?;
    
    // Get the SOL margin's USD value.
    // margin_account.sol_balance is in lamports (9 decimals) and pool_state.sol_usd_price is in 8 decimals.
    // The conversion below yields a value with 8 decimals.
    let sol_margin_usd = (margin_account.sol_balance as u128)
        .checked_mul(ctx.accounts.pool_state.sol_usd_price as u128)
        .ok_or(MarginError::ArithmeticOverflow)?
        .checked_div(1_000_000_000)
        .ok_or(MarginError::ArithmeticOverflow)?;
    
    // USDC is already 1:1 with USD (6 decimals); convert to 8 decimals by multiplying by 100.
    let usdc_margin_usd = (margin_account.usdc_balance as u128)
        .checked_mul(100)
        .ok_or(MarginError::ArithmeticOverflow)?;
    
    let total_margin_usd = sol_margin_usd
        .checked_add(usdc_margin_usd)
        .ok_or(MarginError::ArithmeticOverflow)?;
    if total_margin_usd == 0 {
        return Err(MarginError::InsufficientMargin.into());
    }
    
    // Allocate the pnl proportionally
    let allocated_sol_usd = pnl_total_adj
        .checked_mul(sol_margin_usd)
        .ok_or(MarginError::ArithmeticOverflow)?
        .checked_div(total_margin_usd)
        .ok_or(MarginError::ArithmeticOverflow)?;
    let allocated_usdc_usd = pnl_total_adj
        .checked_sub(allocated_sol_usd)
        .ok_or(MarginError::ArithmeticOverflow)?;
    
    if pnl_update > 0 {
        process_positive_pnl(ctx, allocated_sol_usd, allocated_usdc_usd)?;
    } else {
        process_negative_pnl(ctx, allocated_sol_usd, allocated_usdc_usd)?;
    }
    
    Ok(())
}

// Helper function to process positive PnL
fn process_positive_pnl(
    ctx: &mut Context<ExecuteWithdrawal>, 
    allocated_sol_usd: u128, 
    allocated_usdc_usd: u128
) -> Result<()> {
    let margin_account = &mut ctx.accounts.margin_account;
    
    // Convert allocated SOL pnl (in USD 8 decimals) into SOL native amount.
    let pnl_sol_native = allocated_sol_usd
        .checked_mul(1_000_000_000)
        .ok_or(MarginError::ArithmeticOverflow)?
        .checked_div(ctx.accounts.pool_state.sol_usd_price as u128)
        .ok_or(MarginError::ArithmeticOverflow)? as u64;
    
    if pnl_sol_native > 0 {
        let cpi_program = ctx.accounts.liquidity_pool_program.to_account_info();
        let cpi_accounts = perp_amm::cpi::accounts::AdminWithdraw {
            admin: ctx.accounts.authority.to_account_info(),
            pool_state: ctx.accounts.pool_state.to_account_info(),
            vault_account: ctx.accounts.margin_sol_vault.to_account_info(),
            admin_token_account: ctx.accounts.margin_sol_vault.to_account_info(),
            chainlink_program: ctx.accounts.chainlink_program.to_account_info(),
            chainlink_feed: ctx.accounts.chainlink_feed.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        admin_withdraw(cpi_ctx, pnl_sol_native)?;
        margin_account.sol_balance = margin_account.sol_balance
            .checked_add(pnl_sol_native)
            .ok_or(MarginError::ArithmeticOverflow)?;
    }
    
    // For USDC: convert the allocated pnl from 8 decimals to native (6 decimals) by dividing by 100.
    let pnl_usdc_native = (allocated_usdc_usd
        .checked_div(100)
        .ok_or(MarginError::ArithmeticOverflow)?) as u64;
    
    if pnl_usdc_native > 0 {
        let cpi_program = ctx.accounts.liquidity_pool_program.to_account_info();
        let cpi_accounts = perp_amm::cpi::accounts::AdminWithdraw {
            admin: ctx.accounts.authority.to_account_info(),
            pool_state: ctx.accounts.pool_state.to_account_info(),
            vault_account: ctx.accounts.margin_usdc_vault.to_account_info(),
            admin_token_account: ctx.accounts.margin_usdc_vault.to_account_info(),
            chainlink_program: ctx.accounts.chainlink_program.to_account_info(),
            chainlink_feed: ctx.accounts.chainlink_feed.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        admin_withdraw(cpi_ctx, pnl_usdc_native)?;
        margin_account.usdc_balance = margin_account.usdc_balance
            .checked_add(pnl_usdc_native)
            .ok_or(MarginError::ArithmeticOverflow)?;
    }
    
    Ok(())
}

// Helper function to process negative PnL
fn process_negative_pnl(
    ctx: &mut Context<ExecuteWithdrawal>, 
    allocated_sol_usd: u128, 
    allocated_usdc_usd: u128
) -> Result<()> {
    let margin_account = &mut ctx.accounts.margin_account;
    
    // Convert allocated SOL pnl (in USD 8 decimals) into SOL native amount.
    let pnl_sol_native = allocated_sol_usd
        .checked_mul(1_000_000_000)
        .ok_or(MarginError::ArithmeticOverflow)?
        .checked_div(ctx.accounts.pool_state.sol_usd_price as u128)
        .ok_or(MarginError::ArithmeticOverflow)? as u64;
    
    // Convert allocated USDC pnl from 8 decimals to 6 decimals
    let pnl_usdc_native = (allocated_usdc_usd
        .checked_div(100)
        .ok_or(MarginError::ArithmeticOverflow)?) as u64;
    
    // Limit deductions to available balances
    let deduct_sol = std::cmp::min(pnl_sol_native, margin_account.sol_balance);
    let deduct_usdc = std::cmp::min(pnl_usdc_native, margin_account.usdc_balance);
    
    if deduct_sol > 0 {
        margin_account.sol_balance = margin_account.sol_balance.saturating_sub(deduct_sol);
        let cpi_program = ctx.accounts.liquidity_pool_program.to_account_info();
        let cpi_accounts = perp_amm::cpi::accounts::AdminDeposit {
            admin: ctx.accounts.authority.to_account_info(),
            pool_state: ctx.accounts.pool_state.to_account_info(),
            admin_token_account: ctx.accounts.margin_sol_vault.to_account_info(),
            vault_account: ctx.accounts.margin_sol_vault.to_account_info(),
            chainlink_program: ctx.accounts.chainlink_program.to_account_info(),
            chainlink_feed: ctx.accounts.chainlink_feed.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        admin_deposit(cpi_ctx, deduct_sol)?;
    }
    
    if deduct_usdc > 0 {
        margin_account.usdc_balance = margin_account.usdc_balance.saturating_sub(deduct_usdc);
        let cpi_program = ctx.accounts.liquidity_pool_program.to_account_info();
        let cpi_accounts = perp_amm::cpi::accounts::AdminDeposit {
            admin: ctx.accounts.authority.to_account_info(),
            pool_state: ctx.accounts.pool_state.to_account_info(),
            admin_token_account: ctx.accounts.margin_usdc_vault.to_account_info(),
            vault_account: ctx.accounts.margin_usdc_vault.to_account_info(),
            chainlink_program: ctx.accounts.chainlink_program.to_account_info(),
            chainlink_feed: ctx.accounts.chainlink_feed.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        admin_deposit(cpi_ctx, deduct_usdc)?;
    }
    
    Ok(())
}

// Helper function to process withdrawals
fn process_withdrawals(ctx: &mut Context<ExecuteWithdrawal>) -> Result<()> {
    let margin_account = &mut ctx.accounts.margin_account;
    
    // Process SOL withdrawal if pending.
    if margin_account.pending_sol_withdrawal > 0 {
        let sol_amount = margin_account.pending_sol_withdrawal;
        margin_account.sol_balance = margin_account.sol_balance
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
        margin_account.usdc_balance = margin_account.usdc_balance
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

pub fn cancel_withdrawal(ctx: Context<CancelWithdrawal>) -> Result<()> {
    let margin_account = &mut ctx.accounts.margin_account;
    
    // Clear pending withdrawals
    margin_account.pending_sol_withdrawal = 0;
    margin_account.pending_usdc_withdrawal = 0;

    Ok(())
}