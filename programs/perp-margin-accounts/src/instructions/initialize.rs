use crate::state::MarginVault;
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = MarginVault::LEN,
        seeds = [b"margin_vault"],
        bump
    )]
    pub margin_vault: Account<'info, MarginVault>,

    #[account(
        constraint = margin_sol_vault.owner == margin_vault.key()
    )]
    pub margin_sol_vault: Account<'info, TokenAccount>,

    #[account(
        constraint = margin_usdc_vault.owner == margin_vault.key()
    )]
    pub margin_usdc_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handle_initialize(
    ctx: Context<Initialize>,
    withdrawal_timelock: i64,
    chainlink_program: Pubkey,
    chainlink_feed: Pubkey,
) -> Result<()> {
    let margin_vault = &mut ctx.accounts.margin_vault;

    margin_vault.margin_sol_vault = ctx.accounts.margin_sol_vault.key();
    margin_vault.margin_usdc_vault = ctx.accounts.margin_usdc_vault.key();
    margin_vault.authority = ctx.accounts.authority.key();
    margin_vault.withdrawal_timelock = withdrawal_timelock;
    margin_vault.bump = ctx.bumps.margin_vault;
    margin_vault.chainlink_program = chainlink_program;
    margin_vault.chainlink_feed = chainlink_feed;

    Ok(())
}
