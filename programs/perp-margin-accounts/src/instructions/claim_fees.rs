use crate::errors::MarginError;
use crate::state::MarginVault;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    #[account(
        mut,
        seeds = [b"margin_vault"],
        bump = margin_vault.bump,
        constraint = margin_vault.authorities.contains(&authority.key()) @ MarginError::UnauthorizedExecution,
    )]
    pub margin_vault: Account<'info, MarginVault>,

    #[account(
        mut,
        constraint = margin_sol_vault.key() == margin_vault.margin_sol_vault,
    )]
    pub margin_sol_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = margin_usdc_vault.key() == margin_vault.margin_usdc_vault,
    )]
    pub margin_usdc_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = admin_sol_account.owner == authority.key(),
    )]
    pub admin_sol_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = admin_usdc_account.owner == authority.key(),
    )]
    pub admin_usdc_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
    let margin_vault = &mut ctx.accounts.margin_vault;

    // Claim accumulated SOL fees if any
    if margin_vault.sol_fees_accumulated > 0 {
        let sol_fees = margin_vault.sol_fees_accumulated;
        let cpi_accounts = Transfer {
            from: ctx.accounts.margin_sol_vault.to_account_info(),
            to: ctx.accounts.admin_sol_account.to_account_info(),
            authority: margin_vault.to_account_info(),
        };

        let seeds: &[&[u8]] = &[b"margin_vault".as_ref(), &[margin_vault.bump]];
        let signer = &[seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::transfer(cpi_ctx, sol_fees)?;
        margin_vault.sol_fees_accumulated = 0;
    }

    // Claim accumulated USDC fees if any
    if margin_vault.usdc_fees_accumulated > 0 {
        let usdc_fees = margin_vault.usdc_fees_accumulated;
        let cpi_accounts = Transfer {
            from: ctx.accounts.margin_usdc_vault.to_account_info(),
            to: ctx.accounts.admin_usdc_account.to_account_info(),
            authority: margin_vault.to_account_info(),
        };

        let seeds: &[&[u8]] = &[b"margin_vault".as_ref(), &[margin_vault.bump]];
        let signer = &[seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::transfer(cpi_ctx, usdc_fees)?;
        margin_vault.usdc_fees_accumulated = 0;
    }
    Ok(())
}
