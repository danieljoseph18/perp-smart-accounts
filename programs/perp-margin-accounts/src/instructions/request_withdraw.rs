use anchor_lang::prelude::*;
use crate::errors::MarginError;
use crate::state::{MarginAccount, MarginVault};


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

// No check for margin amount, as positive PNL may increase this.
// Margin amount is checked in execute_withdrawal.
pub fn handler(
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