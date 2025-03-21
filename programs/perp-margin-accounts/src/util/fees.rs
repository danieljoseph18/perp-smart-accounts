use crate::errors::MarginError;
use crate::state::{MarginAccount, MarginVault};
use anchor_lang::prelude::*;

// Helper function to process fees
pub fn process_fees(
    margin_account: &mut MarginAccount,
    margin_vault: &mut MarginVault,
    sol_fees_owed: u64,
    usdc_fees_owed: u64,
) -> Result<()> {
    // Deduct SOL fees
    if sol_fees_owed > 0 {
        // Make sure fees don't exceed margin value
        require!(
            margin_account.sol_balance >= sol_fees_owed,
            MarginError::LiquidatablePosition
        );

        // Deduct fees from margin account
        margin_account.sol_balance = margin_account
            .sol_balance
            .checked_sub(sol_fees_owed)
            .ok_or(MarginError::ArithmeticOverflow)?;

        // Increase global accumulated fees
        margin_vault.sol_fees_accumulated = margin_vault
            .sol_fees_accumulated
            .checked_add(sol_fees_owed)
            .ok_or(MarginError::ArithmeticOverflow)?;
    }

    // Deduct USDC fees
    if usdc_fees_owed > 0 {
        // Make sure fees don't exceed margin value
        require!(
            margin_account.usdc_balance >= usdc_fees_owed,
            MarginError::LiquidatablePosition
        );

        // Deduct fees from margin account
        margin_account.usdc_balance = margin_account
            .usdc_balance
            .checked_sub(usdc_fees_owed)
            .ok_or(MarginError::ArithmeticOverflow)?;

        // Increase global accumulated fees
        margin_vault.usdc_fees_accumulated = margin_vault
            .usdc_fees_accumulated
            .checked_add(usdc_fees_owed)
            .ok_or(MarginError::ArithmeticOverflow)?;
    }

    Ok(())
}
