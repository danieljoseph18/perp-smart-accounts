use crate::{
    errors::VaultError, state::*, CHAINLINK_PROGRAM_ID, DEVNET_SOL_PRICE_FEED,
    MAINNET_SOL_PRICE_FEED, NATIVE_MINT,
};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use chainlink_solana as chainlink;

#[derive(Accounts)]
pub struct AdminWithdraw<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_state".as_ref()],
        bump,
        constraint = (pool_state.admin == admin.key() || pool_state.authority == admin.key()) @ VaultError::Unauthorized
    )]
    pub pool_state: Account<'info, PoolState>,

    /// The vault token account from which WSOL is held.
    #[account(mut)]
    pub vault_account: Account<'info, TokenAccount>,

    // For non-SOL transfers this is used, but when withdrawing SOL the admin must
    // provide a temporary WSOL token account that will be closed to return native SOL.
    #[account(mut)]
    pub admin_token_account: Option<Account<'info, TokenAccount>>,

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

pub fn handle_admin_withdraw(ctx: Context<AdminWithdraw>, amount: u64) -> Result<()> {
    // Determine if we are working with a SOL (WSOL) vault.
    let is_sol_vault = ctx.accounts.vault_account.mint == NATIVE_MINT.parse::<Pubkey>().unwrap();

    // For SOL vaults, update the price feed if this vault is designated as the SOL vault.
    if ctx.accounts.vault_account.key() == ctx.accounts.pool_state.sol_vault {
        let round = chainlink::latest_round_data(
            ctx.accounts.chainlink_program.to_account_info(),
            ctx.accounts.chainlink_feed.to_account_info(),
        )?;
        ctx.accounts.pool_state.sol_usd_price = round.answer;
    }

    //
    // If this is a SOL vault, we will do the following:
    //  1. Require an admin_token_account (a temporary WSOL account).
    //  2. Transfer WSOL from the vault to this temporary account, using the pool_state PDA to sign.
    //  3. Call close_account on the temporary account so that its lamports (i.e. the wrapped SOL)
    //     are unwrapped and sent to the admin.
    //
    if is_sol_vault {
        let admin_token_account = ctx
            .accounts
            .admin_token_account
            .as_ref()
            .ok_or(error!(VaultError::TokenAccountNotProvided))?;

        // Prepare the pool_state seeds for signing.
        let pool_seeds: &[&[u8]] = &[b"pool_state".as_ref(), &[ctx.bumps.pool_state]];
        let pool_state_key = ctx.accounts.pool_state.key();

        // Transfer `amount` WSOL from the vault into the admin's temporary WSOL token account.
        let transfer_ix = anchor_spl::token::spl_token::instruction::transfer(
            &ctx.accounts.token_program.key(),
            &ctx.accounts.vault_account.key(),
            &admin_token_account.key(),
            &pool_state_key,
            &[&pool_state_key],
            amount,
        )?;
        anchor_lang::solana_program::program::invoke_signed(
            &transfer_ix,
            &[
                ctx.accounts.vault_account.to_account_info(),
                admin_token_account.to_account_info(),
                ctx.accounts.pool_state.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            &[pool_seeds],
        )?;

        // Now "unwrap" the WSOL by closing the admin's temporary token account.
        // This transfers its lamports (the unwrapped SOL) directly to the admin.
        let close_ix = anchor_spl::token::spl_token::instruction::close_account(
            &ctx.accounts.token_program.key(),
            &admin_token_account.key(),
            &ctx.accounts.admin.key(),
            &ctx.accounts.admin.key(),
            &[&ctx.accounts.admin.key()],
        )?;
        anchor_lang::solana_program::program::invoke(
            &close_ix,
            &[
                admin_token_account.to_account_info(),
                ctx.accounts.admin.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
        )?;
    } else {
        // For non-SOL tokens, require admin_token_account and perform a regular SPL token transfer.
        let admin_token_account = ctx
            .accounts
            .admin_token_account
            .as_ref()
            .ok_or(error!(VaultError::TokenAccountNotProvided))?;

        // Get pool_state's AccountInfo for CPI
        let pool_state_info = ctx.accounts.pool_state.to_account_info();

        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_account.to_account_info(),
                to: admin_token_account.to_account_info(),
                authority: pool_state_info,
            },
        );
        token::transfer(
            cpi_ctx.with_signer(&[&[b"pool_state".as_ref(), &[ctx.bumps.pool_state]]]),
            amount,
        )?;
    }

    // Finally, decrement the deposited token amounts on pool_state.
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
