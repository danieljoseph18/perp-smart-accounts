use crate::{errors::VaultError, state::*};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct StartRewards<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_state".as_ref()],
        bump,
        constraint = pool_state.admin == admin.key() @ VaultError::Unauthorized
    )]
    pub pool_state: Account<'info, PoolState>,

    /// Admin's USDC token account
    #[account(mut)]
    pub admin_usdc_account: Account<'info, TokenAccount>,

    /// Program's USDC reward vault (PDA)
    #[account(
        mut,
        constraint = usdc_reward_vault.key() == pool_state.usdc_reward_vault @ VaultError::InvalidRewardVault
    )]
    pub usdc_reward_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<StartRewards>,
    usdc_amount: u64, // Total rewards for the period
) -> Result<()> {
    let pool_state = &mut ctx.accounts.pool_state;

    // Validate input USDC amount.
    if usdc_amount == 0 {
        return err!(VaultError::InvalidTokenAmount);
    }

    // Transfer USDC from admin to reward vault
    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.admin_usdc_account.to_account_info(),
            to: ctx.accounts.usdc_reward_vault.to_account_info(),
            authority: ctx.accounts.admin.to_account_info(),
        },
    );
    token::transfer(cpi_ctx, usdc_amount)?;

    // Calculate tokens per interval (per second)
    let tokens_per_interval = usdc_amount
        .checked_div(604800) // One week in seconds
        .ok_or(VaultError::MathError)?;

    // Update state
    pool_state.total_rewards_deposited = usdc_amount;
    pool_state.total_rewards_claimed = 0;
    pool_state.tokens_per_interval = tokens_per_interval;
    pool_state.last_distribution_time = Clock::get()?.unix_timestamp as u64;

    Ok(())
}
