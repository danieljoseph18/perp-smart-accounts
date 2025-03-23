use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// The authority that can call admin functions (e.g. margin program)
    /// CHECK: This is just a pubkey
    pub authority: AccountInfo<'info>,

    /// The PoolState (PDA) to store global info about the pool
    #[account(
        init,
        payer = admin,
        space = 8 + PoolState::LEN,
        seeds = [b"pool_state".as_ref()],
        bump
    )]
    pub pool_state: Account<'info, PoolState>,

    /// SOL vault account (if using wrapped SOL, this would be a token account)
    /// Here, assume you've already created the vault outside or are about to
    #[account(mut)]
    pub sol_vault: Account<'info, TokenAccount>,

    /// USDC vault account
    #[account(mut)]
    pub usdc_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    /// CHECK: This is not dangerous if you're verifying usage in your logic
    pub usdc_mint: AccountInfo<'info>,

    /// Reward vault for USDC
    #[account(mut)]
    pub usdc_reward_vault: Account<'info, TokenAccount>,

    /// LP token mint
    #[account(
        init_if_needed,
        payer = admin,
        mint::decimals = 6,
        mint::authority = pool_state,
        mint::freeze_authority = pool_state
    )]
    pub lp_token_mint: Account<'info, Mint>,

    #[account(address = anchor_spl::token::ID)]
    pub token_program: Program<'info, Token>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<Initialize>) -> Result<()> {
    let pool_state = &mut ctx.accounts.pool_state;

    pool_state.admin = ctx.accounts.admin.key();
    pool_state.authority = ctx.accounts.authority.key();
    pool_state.sol_vault = ctx.accounts.sol_vault.key();
    pool_state.usdc_vault = ctx.accounts.usdc_vault.key();
    pool_state.usdc_mint = ctx.accounts.usdc_mint.key();
    pool_state.lp_token_mint = ctx.accounts.lp_token_mint.key();
    pool_state.sol_deposited = 0;
    pool_state.usdc_deposited = 0;
    pool_state.tokens_per_interval = 0;
    pool_state.reward_start_time = 0;
    pool_state.reward_end_time = 0;
    pool_state.usdc_reward_vault = ctx.accounts.usdc_reward_vault.key();
    pool_state.accumulated_sol_fees = 0;
    pool_state.accumulated_usdc_fees = 0;

    Ok(())
}
