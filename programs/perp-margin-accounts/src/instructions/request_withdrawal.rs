use crate::errors::MarginError;
use crate::state::{MarginAccount, MarginVault};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RequestWithdrawal<'info> {
    #[account(
        mut,
        seeds = [b"margin_account", owner.key().as_ref()],
        bump = margin_account.bump,
        constraint = margin_account.owner == owner.key() @ MarginError::UnauthorizedAccount,
        constraint = margin_account.pending_sol_withdrawal == 0 && margin_account.pending_usdc_withdrawal == 0 @ MarginError::ExistingWithdrawalRequest
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
pub fn request_withdrawal(
    ctx: Context<RequestWithdrawal>,
    amount: u64,
    is_sol: bool,
) -> Result<()> {
    let margin_account = &mut ctx.accounts.margin_account;
    let clock = Clock::get()?;

    // First: if a withdrawal is already pending, reject immediately.
    if margin_account.pending_sol_withdrawal > 0 || margin_account.pending_usdc_withdrawal > 0 {
        return Err(MarginError::ExistingWithdrawalRequest.into());
    }

    // Then, if a previous request was made (and subsequently executed or cancelled) you
    // might require that a new request may only be made after the timelock has passed.
    require!(
        clock.unix_timestamp
            >= margin_account.last_withdrawal_request
                + ctx.accounts.margin_vault.withdrawal_timelock,
        MarginError::WithdrawalTimelockNotExpired
    );

    if is_sol {
        margin_account.pending_sol_withdrawal = amount;
        margin_account.pending_usdc_withdrawal = 0;
    } else {
        margin_account.pending_sol_withdrawal = 0;
        margin_account.pending_usdc_withdrawal = amount;
    }

    margin_account.last_withdrawal_request = clock.unix_timestamp;

    Ok(())
}
