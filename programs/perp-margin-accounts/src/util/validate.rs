use crate::errors::MarginError;
use crate::state::MarginAccount;
use anchor_lang::prelude::*;

// Helper function to validate balances
pub fn validate_balances(
    margin_account: &MarginAccount,
    locked_sol: u64,
    locked_usdc: u64,
) -> Result<()> {
    // Calculate available balances (balance - locked amount)
    let available_sol = margin_account
        .sol_balance
        .checked_sub(locked_sol)
        .ok_or(MarginError::ArithmeticOverflow)?;

    let available_usdc = margin_account
        .usdc_balance
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
