use crate::{errors::VaultError, state::*};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_state".as_ref()],
        bump,
        constraint = pool_state.admin == admin.key() @ VaultError::Unauthorized
    )]
    pub pool_state: Account<'info, PoolState>,

    /// SOL vault to withdraw from
    #[account(
        mut,
        constraint = sol_vault.key() == pool_state.sol_vault
    )]
    pub sol_vault: Account<'info, TokenAccount>,

    /// USDC vault to withdraw from
    #[account(
        mut,
        constraint = usdc_vault.key() == pool_state.usdc_vault
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    /// Admin's SOL token account to receive fees
    #[account(
        mut,
        constraint = admin_sol_account.owner == admin.key()
    )]
    pub admin_sol_account: Account<'info, TokenAccount>,

    /// Admin's USDC token account to receive fees
    #[account(
        mut,
        constraint = admin_usdc_account.owner == admin.key()
    )]
    pub admin_usdc_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ClaimFees>) -> Result<()> {
    let pool_state = &mut ctx.accounts.pool_state;

    // Transfer accumulated SOL fees if any
    if pool_state.accumulated_sol_fees > 0 {
        let sol_amount = pool_state.accumulated_sol_fees;
        let cpi_ctx_sol = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.sol_vault.to_account_info(),
                to: ctx.accounts.admin_sol_account.to_account_info(),
                authority: pool_state.to_account_info(),
            },
        );
        token::transfer(
            cpi_ctx_sol.with_signer(&[&[b"pool_state".as_ref(), &[ctx.bumps.pool_state]]]),
            sol_amount,
        )?;

        // Reset accumulated SOL fees
        pool_state.accumulated_sol_fees = 0;
    }

    // Transfer accumulated USDC fees if any
    if pool_state.accumulated_usdc_fees > 0 {
        let usdc_amount = pool_state.accumulated_usdc_fees;

        let cpi_ctx_usdc = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.usdc_vault.to_account_info(),
                to: ctx.accounts.admin_usdc_account.to_account_info(),
                authority: pool_state.to_account_info(),
            },
        );
        token::transfer(
            cpi_ctx_usdc.with_signer(&[&[b"pool_state".as_ref(), &[ctx.bumps.pool_state]]]),
            usdc_amount,
        )?;

        // Reset accumulated USDC fees
        pool_state.accumulated_usdc_fees = 0;
    }

    Ok(())
}
