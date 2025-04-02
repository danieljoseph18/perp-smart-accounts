use crate::{
    errors::VaultError, state::*, CHAINLINK_PROGRAM_ID, DEVNET_SOL_PRICE_FEED,
    MAINNET_SOL_PRICE_FEED, NATIVE_MINT,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct AdminWithdraw<'info> {
    // Allow any account (including a PDA) to be provided here.
    /// CHECK: Validated by its constraint.
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_state".as_ref()],
        bump
    )]
    pub pool_state: Account<'info, PoolState>,

    /// The vault token account from which WSOL is held.
    #[account(mut)]
    pub vault_account: Account<'info, TokenAccount>,

    // Token account (e.g., WSOL or USDC)
    #[account(
        mut,
        constraint = admin_token_account.mint == NATIVE_MINT.parse::<Pubkey>().unwrap() || admin_token_account.mint == pool_state.usdc_mint
    )]
    pub admin_token_account: Account<'info, TokenAccount>,

    /// CHECK: Validated by its constraint.
    #[account(address = CHAINLINK_PROGRAM_ID.parse::<Pubkey>().unwrap())]
    pub chainlink_program: AccountInfo<'info>,

    /// CHECK: Validated below.
    #[account(
        address = if cfg!(feature = "devnet") {
            DEVNET_SOL_PRICE_FEED
        } else {
            MAINNET_SOL_PRICE_FEED
        }
        .parse::<Pubkey>()
        .unwrap()
    )]
    pub chainlink_feed: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn admin_withdraw(ctx: Context<AdminWithdraw>, amount: u64) -> Result<()> {
    // Manual check: Ensure that either the admin or authority role is calling.
    if ctx.accounts.admin.key() != ctx.accounts.pool_state.admin
        && !ctx
            .accounts
            .pool_state
            .authorities
            .contains(&ctx.accounts.admin.key())
    {
        return err!(VaultError::Unauthorized);
    }

    // Get pool_state's AccountInfo for CPI.
    let pool_state_info = ctx.accounts.pool_state.to_account_info();

    // Create the CPI context for the token transfer.
    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault_account.to_account_info(),
            to: ctx.accounts.admin_token_account.to_account_info(),
            authority: pool_state_info,
        },
    );

    // Note: Use the bump value stored on pool_state so that the signer seeds match.
    token::transfer(
        cpi_ctx.with_signer(&[&[b"pool_state".as_ref(), &[ctx.bumps.pool_state]]]),
        amount,
    )?;

    // (Your existing code to decrement deposited amounts remains unchanged.)
    if ctx.accounts.vault_account.key() == ctx.accounts.pool_state.sol_vault {
        ctx.accounts.pool_state.sol_deposited = ctx
            .accounts
            .pool_state
            .sol_deposited
            .checked_sub(amount)
            .ok_or_else(|| error!(VaultError::MathError))?;
    } else if ctx.accounts.vault_account.key() == ctx.accounts.pool_state.usdc_vault {
        ctx.accounts.pool_state.usdc_deposited = ctx
            .accounts
            .pool_state
            .usdc_deposited
            .checked_sub(amount)
            .ok_or_else(|| error!(VaultError::MathError))?;
    } else {
        return err!(VaultError::InvalidTokenMint);
    }

    Ok(())
}
