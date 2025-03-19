use crate::{
    errors::VaultError, state::*, CHAINLINK_PROGRAM_ID, DEVNET_SOL_PRICE_FEED,
    MAINNET_SOL_PRICE_FEED, NATIVE_MINT,
};
use anchor_lang::prelude::*;
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

    #[account(mut)]
    pub vault_account: Account<'info, TokenAccount>,

    // This will now be optional since we might be sending native SOL directly
    #[account(mut)]
    pub admin_token_account: Option<Account<'info, TokenAccount>>,

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

pub fn handle_admin_withdraw(ctx: Context<AdminWithdraw>, amount: u64) -> Result<()> {
    // 1) First, get an immutable reference to the pool_state's AccountInfo
    //    for use as the "authority" in our CPI.
    let pool_state_info = ctx.accounts.pool_state.to_account_info();

    // 2) Now borrow the pool_state data *mutably* in a separate binding.
    //    We do this after we've already taken the AccountInfo above.
    let pool_state = &mut ctx.accounts.pool_state;

    // Check admin authority
    require!(
        ctx.accounts.admin.key() == pool_state.admin
            || ctx.accounts.admin.key() == pool_state.authority,
        VaultError::Unauthorized
    );

    // Check if this is a SOL vault (WSOL)
    let is_sol_vault = ctx.accounts.vault_account.mint == NATIVE_MINT.parse::<Pubkey>().unwrap();

    // If withdrawing SOL, fetch/update the current SOL/USD price
    if ctx.accounts.vault_account.key() == pool_state.sol_vault {
        let round = chainlink::latest_round_data(
            ctx.accounts.chainlink_program.to_account_info(),
            ctx.accounts.chainlink_feed.to_account_info(),
        )?;
        pool_state.sol_usd_price = round.answer;
    }

    // Handle SOL withdrawal differently - unwrap WSOL and send SOL directly
    if is_sol_vault {
        // First, close the account and get the SOL (unwrap WSOL)
        let close_ix = anchor_spl::token::spl_token::instruction::close_account(
            &ctx.accounts.token_program.key(),
            &ctx.accounts.vault_account.key(),
            &ctx.accounts.admin.key(),
            &pool_state_info.key(),
            &[&pool_state_info.key()],
        )?;

        // Execute the instruction with the pool state PDA as signer
        anchor_lang::solana_program::program::invoke_signed(
            &close_ix,
            &[
                ctx.accounts.vault_account.to_account_info(),
                ctx.accounts.admin.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            &[&[b"pool_state".as_ref(), &[ctx.bumps.pool_state]]],
        )?;
    } else {
        // Handle regular SPL token transfer
        // Make sure admin_token_account is provided when not dealing with native SOL
        let admin_token_account = ctx
            .accounts
            .admin_token_account
            .as_ref()
            .ok_or(error!(VaultError::TokenAccountNotProvided))?;

        // Transfer from the vault to the admin.
        // Notice we're using `pool_state_info` (immutable AccountInfo)
        // as the authority for the vault's PDA.
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

    // Decrement deposited tokens
    if ctx.accounts.vault_account.key() == pool_state.sol_vault {
        pool_state.sol_deposited = pool_state
            .sol_deposited
            .checked_sub(amount)
            .ok_or_else(|| error!(VaultError::MathError))?;
    } else if ctx.accounts.vault_account.key() == pool_state.usdc_vault {
        pool_state.usdc_deposited = pool_state
            .usdc_deposited
            .checked_sub(amount)
            .ok_or_else(|| error!(VaultError::MathError))?;
    } else {
        return err!(VaultError::InvalidTokenMint);
    }

    Ok(())
}
