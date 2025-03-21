use crate::errors::MarginError;
use crate::instructions::ExecuteWithdrawal;
use anchor_lang::prelude::*;
use chainlink_solana as chainlink;
use perp_amm::cpi::{admin_deposit, admin_withdraw};

/**
 * @dev Helper function to process PnL updates.
 * Essentially calculates the available margin in USD, then allocates the PnL proportionally
 * between SOL and USDC.
 * FIXME: What if pool has no USDC, only SOL? --> maybe better to choose a currency to settle pnl in.
 * FIXME: Uses SOL / USD price, but we're not actually updating the price feed.
 */
pub fn process_pnl_update(ctx: &mut Context<ExecuteWithdrawal>, pnl_update: i64) -> Result<()> {
    let pool_state = &mut ctx.accounts.pool_state;

    // Update SOL/USD price from Chainlink before using it
    let round = chainlink::latest_round_data(
        ctx.accounts.chainlink_program.to_account_info(),
        ctx.accounts.chainlink_feed.to_account_info(),
    )?;
    pool_state.sol_usd_price = round.answer;

    // Determine which asset to use for settlement based on the provided pool_vault_account
    let use_sol_for_settlement = ctx.accounts.pool_vault_account.key() == pool_state.sol_vault;

    // Skip processing if PnL is zero
    if pnl_update == 0 {
        return Ok(());
    }

    // Convert pnl_update to a u128 and upscale from 6 to 8 decimals
    let pnl_total_usd = pnl_update.unsigned_abs() as u128;
    let pnl_total_adj = pnl_total_usd
        .checked_mul(100)
        .ok_or(MarginError::ArithmeticOverflow)?;

    if pnl_update > 0 {
        process_positive_pnl(ctx, pnl_total_adj, use_sol_for_settlement)?;
    } else {
        process_negative_pnl(ctx, pnl_total_adj, use_sol_for_settlement)?;
    }

    Ok(())
}

// Helper function to process positive PnL
fn process_positive_pnl(
    ctx: &mut Context<ExecuteWithdrawal>,
    pnl_total_usd: u128,
    use_sol_for_settlement: bool,
) -> Result<()> {
    let margin_account = &mut ctx.accounts.margin_account;
    let pool_state = &ctx.accounts.pool_state;

    if use_sol_for_settlement {
        // Convert PnL from USD (8 decimals) to SOL (9 decimals)
        let pnl_sol_native = pnl_total_usd
            .checked_mul(1_000_000_000)
            .ok_or(MarginError::ArithmeticOverflow)?
            .checked_div(pool_state.sol_usd_price as u128)
            .ok_or(MarginError::ArithmeticOverflow)? as u64;

        if pnl_sol_native > 0 {
            let cpi_program = ctx.accounts.liquidity_pool_program.to_account_info();

            let cpi_accounts = perp_amm::cpi::accounts::AdminWithdraw {
                admin: ctx.accounts.authority.to_account_info(),
                pool_state: ctx.accounts.pool_state.to_account_info(),
                vault_account: ctx.accounts.pool_vault_account.to_account_info(),
                admin_token_account: ctx.accounts.margin_sol_vault.to_account_info(),
                chainlink_program: ctx.accounts.chainlink_program.to_account_info(),
                chainlink_feed: ctx.accounts.chainlink_feed.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            };

            let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

            admin_withdraw(cpi_ctx, pnl_sol_native)?;

            margin_account.sol_balance = margin_account
                .sol_balance
                .checked_add(pnl_sol_native)
                .ok_or(MarginError::ArithmeticOverflow)?;
        }
    } else {
        // Using USDC for settlement
        // Convert PnL from USD (8 decimals) to USDC (6 decimals)
        let pnl_usdc_native = (pnl_total_usd
            .checked_div(100)
            .ok_or(MarginError::ArithmeticOverflow)?) as u64;

        if pnl_usdc_native > 0 {
            let cpi_program = ctx.accounts.liquidity_pool_program.to_account_info();
            let cpi_accounts = perp_amm::cpi::accounts::AdminWithdraw {
                admin: ctx.accounts.authority.to_account_info(),
                pool_state: ctx.accounts.pool_state.to_account_info(),
                vault_account: ctx.accounts.pool_vault_account.to_account_info(),
                admin_token_account: ctx.accounts.margin_usdc_vault.to_account_info(),
                chainlink_program: ctx.accounts.chainlink_program.to_account_info(),
                chainlink_feed: ctx.accounts.chainlink_feed.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            };

            let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

            admin_withdraw(cpi_ctx, pnl_usdc_native)?;

            margin_account.usdc_balance = margin_account
                .usdc_balance
                .checked_add(pnl_usdc_native)
                .ok_or(MarginError::ArithmeticOverflow)?;
        }
    }

    Ok(())
}

// Helper function to process negative PnL
fn process_negative_pnl(
    ctx: &mut Context<ExecuteWithdrawal>,
    pnl_total_usd: u128,
    use_sol_for_settlement: bool,
) -> Result<()> {
    let margin_account = &mut ctx.accounts.margin_account;
    let pool_state = &ctx.accounts.pool_state;

    if use_sol_for_settlement {
        // Convert PnL from USD (8 decimals) to SOL (9 decimals)
        let pnl_sol_native = pnl_total_usd
            .checked_mul(1_000_000_000)
            .ok_or(MarginError::ArithmeticOverflow)?
            .checked_div(pool_state.sol_usd_price as u128)
            .ok_or(MarginError::ArithmeticOverflow)? as u64;

        // Limit deduction to available balance
        let deduct_sol = std::cmp::min(pnl_sol_native, margin_account.sol_balance);

        if deduct_sol > 0 {
            margin_account.sol_balance = margin_account.sol_balance.saturating_sub(deduct_sol);

            let cpi_program = ctx.accounts.liquidity_pool_program.to_account_info();
            let cpi_accounts = perp_amm::cpi::accounts::AdminDeposit {
                admin: ctx.accounts.authority.to_account_info(),
                pool_state: ctx.accounts.pool_state.to_account_info(),
                admin_token_account: ctx.accounts.margin_sol_vault.to_account_info(),
                vault_account: ctx.accounts.pool_vault_account.to_account_info(),
                chainlink_program: ctx.accounts.chainlink_program.to_account_info(),
                chainlink_feed: ctx.accounts.chainlink_feed.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            };
            let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
            admin_deposit(cpi_ctx, deduct_sol)?;
        }
    } else {
        // Using USDC for settlement
        // Convert PnL from USD (8 decimals) to USDC (6 decimals)
        let pnl_usdc_native = (pnl_total_usd
            .checked_div(100)
            .ok_or(MarginError::ArithmeticOverflow)?) as u64;

        // Limit deduction to available balance
        let deduct_usdc = std::cmp::min(pnl_usdc_native, margin_account.usdc_balance);

        if deduct_usdc > 0 {
            margin_account.usdc_balance = margin_account.usdc_balance.saturating_sub(deduct_usdc);

            let cpi_program = ctx.accounts.liquidity_pool_program.to_account_info();
            let cpi_accounts = perp_amm::cpi::accounts::AdminDeposit {
                admin: ctx.accounts.authority.to_account_info(),
                pool_state: ctx.accounts.pool_state.to_account_info(),
                admin_token_account: ctx.accounts.margin_usdc_vault.to_account_info(),
                vault_account: ctx.accounts.pool_vault_account.to_account_info(),
                chainlink_program: ctx.accounts.chainlink_program.to_account_info(),
                chainlink_feed: ctx.accounts.chainlink_feed.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            };
            let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
            admin_deposit(cpi_ctx, deduct_usdc)?;
        }
    }

    Ok(())
}
