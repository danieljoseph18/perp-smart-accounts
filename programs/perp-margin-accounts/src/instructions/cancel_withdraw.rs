use crate::errors::MarginError;
use crate::state::{MarginAccount, MarginVault};
use anchor_lang::prelude::*;

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

pub fn handler(ctx: Context<CancelWithdrawal>) -> Result<()> {
    let margin_account = &mut ctx.accounts.margin_account;

    // Clear pending withdrawals
    margin_account.pending_sol_withdrawal = 0;
    margin_account.pending_usdc_withdrawal = 0;

    Ok(())
}
