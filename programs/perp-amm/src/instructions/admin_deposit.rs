use crate::{
    errors::VaultError, state::*, CHAINLINK_PROGRAM_ID, DEVNET_SOL_PRICE_FEED,
    MAINNET_SOL_PRICE_FEED, NATIVE_MINT,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use chainlink_solana as chainlink;

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

    // This will now be optional since we might be dealing with native SOL
    #[account(mut)]
    pub admin_token_account: Option<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub vault_account: Account<'info, TokenAccount>,

    /// CHECK: Validated in constraint
    #[account(address = CHAINLINK_PROGRAM_ID.parse::<Pubkey>().unwrap())]
    pub chainlink_program: AccountInfo<'info>,

    /// CHECK: Validated in constraint
    #[account(
        address = if cfg!(feature = "devnet") {
            DEVNET_SOL_PRICE_FEED
        } else {
            MAINNET_SOL_PRICE_FEED
        }.parse::<Pubkey>().unwrap()
    )]
    pub chainlink_feed: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,

    // Add system program for SOL transfers
    pub system_program: Program<'info, System>,
}

pub fn handle_admin_deposit(ctx: Context<AdminDeposit>, amount: u64) -> Result<()> {
    let pool_state = &mut ctx.accounts.pool_state;

    // If depositing SOL, fetch/update the current SOL/USD price
    if ctx.accounts.vault_account.mint == NATIVE_MINT.parse::<Pubkey>().unwrap() {
        let round = chainlink::latest_round_data(
            ctx.accounts.chainlink_program.to_account_info(),
            ctx.accounts.chainlink_feed.to_account_info(),
        )?;
        pool_state.sol_usd_price = round.answer;

        // Handle direct SOL transfer and wrapping
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            ctx.accounts.admin.key,
            &ctx.accounts.vault_account.key(),
            amount,
        );

        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.admin.to_account_info(),
                ctx.accounts.vault_account.to_account_info(),
            ],
        )?;

        // Sync the native account after transfer (turns SOL into WSOL)
        let sync_native_ix = anchor_spl::token::spl_token::instruction::sync_native(
            &ctx.accounts.token_program.key(),
            &ctx.accounts.vault_account.key(),
        )?;

        anchor_lang::solana_program::program::invoke(
            &sync_native_ix,
            &[
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.vault_account.to_account_info(),
            ],
        )?;

        // Update SOL deposited amount
        pool_state.sol_deposited = pool_state
            .sol_deposited
            .checked_add(amount)
            .ok_or_else(|| error!(VaultError::MathError))?;
    } else {
        // Handle regular SPL token transfer
        // Make sure admin_token_account is provided when not dealing with native SOL
        let admin_token_account = ctx
            .accounts
            .admin_token_account
            .as_ref()
            .ok_or(error!(VaultError::TokenAccountNotProvided))?;

        let transfer_cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: admin_token_account.to_account_info(),
                to: ctx.accounts.vault_account.to_account_info(),
                authority: ctx.accounts.admin.to_account_info(),
            },
        );
        token::transfer(transfer_cpi_ctx, amount)?;

        // Update the pool's record of how many USDC tokens are deposited
        if ctx.accounts.vault_account.key() == pool_state.usdc_vault {
            pool_state.usdc_deposited = pool_state
                .usdc_deposited
                .checked_add(amount)
                .ok_or_else(|| error!(VaultError::MathError))?;
        } else {
            return err!(VaultError::InvalidTokenMint);
        }
    }

    Ok(())
}
