use crate::state::PoolState;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// The PoolState (PDA) to store global info about the pool
    #[account(
        init,
        payer = admin,
        space = 8 + PoolState::INIT_SPACE,
        seeds = [b"pool_state".as_ref()],
        bump,
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        init,
        payer = admin,
        seeds = [b"sol_vault".as_ref(), pool_state.key().as_ref()],
        bump,
        token::mint = sol_mint, 
        token::authority = pool_state,
    )]
    pub sol_vault: Account<'info, TokenAccount>,

    /// USDC vault PDA - owned by pool_state
    #[account(
        init,
        payer = admin,
        seeds = [b"usdc_vault".as_ref(), pool_state.key().as_ref()],
        bump,
        token::mint = usdc_mint, 
        token::authority = pool_state,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    /// Reward vault PDA for USDC - owned by pool_state
    #[account(
        init,
        payer = admin,
        seeds = [b"usdc_reward_vault".as_ref(), pool_state.key().as_ref()],
        bump,
        token::mint = usdc_mint, 
        token::authority = pool_state,
    )]
    pub usdc_reward_vault: Account<'info, TokenAccount>,

    pub sol_mint: Box<Account<'info, Mint>>,

    pub usdc_mint: Box<Account<'info, Mint>>,

    /// LP token mint
    #[account(
        init_if_needed,
        payer = admin,
        mint::decimals = 9,
        mint::authority = pool_state,
        mint::freeze_authority = pool_state
    )]
    pub lp_token_mint: Account<'info, Mint>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<Initialize>) -> Result<()> {
    let pool_state = &mut ctx.accounts.pool_state;

    pool_state.admin = ctx.accounts.admin.key();
    
    // Initialize authorities with the provided authority
    let authorities = Vec::new();

    pool_state.authorities = authorities;
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
