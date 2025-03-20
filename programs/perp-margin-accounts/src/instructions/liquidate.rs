use crate::errors::MarginError;
use crate::state::{MarginAccount, MarginVault};
use anchor_lang::prelude::*;
use anchor_spl::token::{ Token, TokenAccount};
use perp_amm::{
    state::PoolState,
    cpi::admin_deposit,
    program::PerpAmm,
};

#[derive(Accounts)]
pub struct LiquidateMarginAccount<'info> {
    #[account(
        mut,
        seeds = [b"margin_account", margin_account.owner.as_ref()],
        bump = margin_account.bump
    )]
    pub margin_account: Account<'info, MarginAccount>,

    #[account(
        seeds = [b"margin_vault"],
        bump = margin_vault.bump,
        has_one = authority @ MarginError::InvalidAuthority
    )]
    pub margin_vault: Account<'info, MarginVault>,

    #[account(
        mut,
        constraint = margin_vault_token_account.key() == margin_vault.sol_vault || 
                    margin_vault_token_account.key() == margin_vault.usdc_vault
    )]
    pub margin_vault_token_account: Account<'info, TokenAccount>,

    /// The liquidity pool's state account
    #[account(
        mut,
        seeds = [b"pool_state".as_ref()],
        bump
    )]
    pub pool_state: Account<'info, PoolState>,

    /// The liquidity pool's vault account that matches the token being withdrawn
    #[account(
        mut,
        constraint = pool_vault_account.key() == pool_state.sol_vault || 
                    pool_vault_account.key() == pool_state.usdc_vault
    )]
    pub pool_vault_account: Account<'info, TokenAccount>,

    /// CHECK: Validated in constraint against stored value in margin vault
    #[account(address = margin_vault.chainlink_program)]
    pub chainlink_program: AccountInfo<'info>,

    /// CHECK: Validated in constraint against stored value in margin vault
    #[account(address = margin_vault.chainlink_feed)]
    pub chainlink_feed: AccountInfo<'info>,

    #[account(
        constraint = authority.key() == margin_vault.authority @ MarginError::UnauthorizedLiquidation
    )]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub liquidity_pool_program: Program<'info, PerpAmm>,
    pub system_program: Program<'info, System>,
}

// No safety checks, so constrain caller.
pub fn handle_liquidate_margin_account(
    ctx: Context<LiquidateMarginAccount>,
) -> Result<()> {
    let margin_account = &mut ctx.accounts.margin_account;

    // Get current balance
    let current_balance = if ctx.accounts.margin_vault_token_account.key() == ctx.accounts.margin_vault.sol_vault {
        margin_account.sol_balance
    } else {
        margin_account.usdc_balance
    };

    // Only process if there's a balance to wipe
    if current_balance > 0 {
        // Set balance to 0
        if ctx.accounts.margin_vault_token_account.key() == ctx.accounts.margin_vault.sol_vault {
            margin_account.sol_balance = 0;
        } else {
            margin_account.usdc_balance = 0;
        }

        // Transfer entire balance to liquidity pool
        let cpi_program = ctx.accounts.liquidity_pool_program.to_account_info();
        let cpi_accounts = perp_amm::cpi::accounts::AdminDeposit {
            admin: ctx.accounts.authority.to_account_info(),
            pool_state: ctx.accounts.pool_state.to_account_info(),
            admin_token_account: ctx.accounts.margin_vault_token_account.to_account_info(),
            vault_account: ctx.accounts.pool_vault_account.to_account_info(),
            chainlink_program: ctx.accounts.chainlink_program.to_account_info(),
            chainlink_feed: ctx.accounts.chainlink_feed.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        admin_deposit(cpi_ctx, current_balance)?;
    }

    Ok(())
}
