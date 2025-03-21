use crate::errors::MarginError;
use crate::state::{MarginAccount, MarginVault};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct DepositMargin<'info> {
    #[account(
        init_if_needed,
        payer = owner,
        space = MarginAccount::LEN,
        seeds = [b"margin_account", owner.key().as_ref()],
        bump,
        constraint = margin_account.owner == owner.key() || margin_account.owner == Pubkey::default()
    )]
    pub margin_account: Account<'info, MarginAccount>,

    #[account(
        seeds = [b"margin_vault"],
        bump = margin_vault.bump
    )]
    pub margin_vault: Account<'info, MarginVault>,

    #[account(
        mut,
        constraint = vault_token_account.key() == margin_vault.margin_sol_vault || 
                    vault_token_account.key() == margin_vault.margin_usdc_vault
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_account.owner == owner.key()
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DepositMargin>, amount: u64) -> Result<()> {
    let margin_account = &mut ctx.accounts.margin_account;

    if amount == 0 {
        return Err(MarginError::ZeroDepositAmount.into());
    }

    // Initialize margin account if new
    if margin_account.owner == Pubkey::default() {
        margin_account.owner = ctx.accounts.owner.key();
        margin_account.bump = ctx.bumps.margin_account;
    }

    // Transfer tokens to vault
    let cpi_accounts = Transfer {
        from: ctx.accounts.user_token_account.to_account_info(),
        to: ctx.accounts.vault_token_account.to_account_info(),
        authority: ctx.accounts.owner.to_account_info(),
    };

    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

    token::transfer(cpi_ctx, amount)?;

    // Update margin account balance
    if ctx.accounts.vault_token_account.key() == ctx.accounts.margin_vault.margin_sol_vault {
        margin_account.sol_balance = margin_account
            .sol_balance
            .checked_add(amount)
            .ok_or(MarginError::ArithmeticOverflow)?;
    } else {
        margin_account.usdc_balance = margin_account
            .usdc_balance
            .checked_add(amount)
            .ok_or(MarginError::ArithmeticOverflow)?;
    }

    Ok(())
}
