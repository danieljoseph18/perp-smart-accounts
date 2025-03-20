use crate::{
    errors::VaultError, state::*, CHAINLINK_PROGRAM_ID, DEVNET_SOL_PRICE_FEED,
    MAINNET_SOL_PRICE_FEED, NATIVE_MINT,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct AdminDeposit<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_state".as_ref()],
        bump,
        constraint = (pool_state.admin == admin.key() || pool_state.authority == admin.key()) @ VaultError::Unauthorized
    )]
    pub pool_state: Account<'info, PoolState>,

    // Token account, e.g WSOL or USDC
    #[account(
        mut,
        constraint = admin_token_account.mint == NATIVE_MINT.parse::<Pubkey>().unwrap() || 
                    admin_token_account.mint == pool_state.usdc_mint
    )]
    pub admin_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub vault_account: Account<'info, TokenAccount>,

    /// CHECK: Validated in constraint.
    #[account(address = CHAINLINK_PROGRAM_ID.parse::<Pubkey>().unwrap())]
    pub chainlink_program: AccountInfo<'info>,

    /// CHECK: Validated in constraint.
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

pub fn handle_admin_deposit(ctx: Context<AdminDeposit>, amount: u64) -> Result<()> {
    let pool_state = &mut ctx.accounts.pool_state;

    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.admin_token_account.to_account_info(),
            to: ctx.accounts.vault_account.to_account_info(),
            authority: ctx.accounts.admin.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, amount)?;

    // Validate and update the non-SOL deposit record (e.g., USDC deposit).
    if ctx.accounts.vault_account.key() == pool_state.usdc_vault {
        pool_state.usdc_deposited = pool_state
            .usdc_deposited
            .checked_add(amount)
            .ok_or_else(|| error!(VaultError::MathError))?;
    } else if ctx.accounts.vault_account.key() == pool_state.sol_vault {
        // Update the pool's record of SOL deposited.
        pool_state.sol_deposited = pool_state
            .sol_deposited
            .checked_add(amount)
            .ok_or_else(|| error!(VaultError::MathError))?;
    } else {
        return err!(VaultError::InvalidTokenMint);
    }

    Ok(())
}
