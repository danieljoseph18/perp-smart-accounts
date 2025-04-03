use crate::{
    errors::VaultError, state::*, util::*, CHAINLINK_PROGRAM_ID, DEVNET_SOL_PRICE_FEED,
    MAINNET_SOL_PRICE_FEED, NATIVE_MINT,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};
use chainlink_solana as chainlink;

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [b"pool_state".as_ref()], bump)]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserState::INIT_SPACE,
        seeds = [b"user_state".as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_state: Account<'info, UserState>,

    #[account(mut, constraint = lp_token_mint.key() == pool_state.lp_token_mint)]
    pub lp_token_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_lp_token_account.owner == user.key(),
        constraint = user_lp_token_account.mint == lp_token_mint.key()
    )]
    pub user_lp_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = vault_account.key() == pool_state.sol_vault || vault_account.key() == pool_state.usdc_vault
    )]
    pub vault_account: Account<'info, TokenAccount>,

    // For SOL withdrawals, require this account; it is a temporary WSOL account
    // that will be closed (unwrapped) returning native SOL to the user.
    #[account(mut, constraint = user_token_account.mint == NATIVE_MINT.parse::<Pubkey>().unwrap() || user_token_account.mint == pool_state.usdc_mint)]
    pub user_token_account: Account<'info, TokenAccount>,

    /// CHECK: Validated in constraint
    #[account(address = CHAINLINK_PROGRAM_ID.parse::<Pubkey>().unwrap())]
    pub chainlink_program: AccountInfo<'info>,

    /// CHECK: Validated in constraint
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

pub fn withdraw(ctx: Context<Withdraw>, lp_token_amount: u64) -> Result<()> {
    // --- Pre-burn & reward update logic remains unchanged ---
    let pool_state_info = ctx.accounts.pool_state.to_account_info();
    let pool_state_bump = ctx.bumps.pool_state;
    let pool_state = &mut ctx.accounts.pool_state;
    let user_state = &mut ctx.accounts.user_state;

    // Validate input token amount.
    if lp_token_amount == 0 {
        return err!(VaultError::InvalidTokenAmount);
    }

    if user_state.lp_token_balance < lp_token_amount as u128 {
        return err!(VaultError::InsufficientLpBalance);
    }

    update_rewards(pool_state, user_state, &ctx.accounts.lp_token_mint)?;

    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.lp_token_mint.to_account_info(),
                from: ctx.accounts.user_lp_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        lp_token_amount,
    )?;

    user_state.lp_token_balance = user_state
        .lp_token_balance
        .checked_sub(lp_token_amount as u128)
        .ok_or(VaultError::MathError)?;

    let sol_vault = pool_state.sol_vault;
    let usdc_vault = pool_state.usdc_vault;

    let round = chainlink::latest_round_data(
        ctx.accounts.chainlink_program.to_account_info(),
        ctx.accounts.chainlink_feed.to_account_info(),
    )?;

    let sol_usd_price = round.answer;

    let total_sol_usd = get_sol_usd_value(pool_state.sol_deposited, sol_usd_price)?;

    let current_aum = total_sol_usd
        .checked_add(
            pool_state
                .usdc_deposited
                .checked_mul(100)
                .ok_or(VaultError::MathError)?,
        )
        .ok_or(VaultError::MathError)?;

    let lp_supply = ctx.accounts.lp_token_mint.supply.max(1);
    let withdrawal_usd_value: u128 = (lp_token_amount as u128)
        .checked_mul(current_aum as u128)
        .ok_or(VaultError::MathError)?
        .checked_div(lp_supply as u128)
        .ok_or(VaultError::MathError)?;

    let token_amount = if ctx.accounts.vault_account.key() == sol_vault {
        get_sol_amount_from_usd(withdrawal_usd_value as u64, sol_usd_price)?
    } else if ctx.accounts.vault_account.key() == usdc_vault {
        // Convert USD (8 decimals) to USDC (6 decimals)
        (withdrawal_usd_value
            .checked_div(100)
            .ok_or(VaultError::MathError)?) as u64
    } else {
        return err!(VaultError::InvalidTokenMint);
    };

    let fee_amount = token_amount
        .checked_mul(1)
        .ok_or(VaultError::MathError)?
        .checked_div(1000)
        .ok_or(VaultError::MathError)?;
    let withdrawal_amount = token_amount
        .checked_sub(fee_amount)
        .ok_or(VaultError::MathError)?;

    // --- Fee update logic remains unchanged ---
    if ctx.accounts.vault_account.key() == sol_vault {
        pool_state.accumulated_sol_fees = pool_state
            .accumulated_sol_fees
            .checked_add(fee_amount)
            .ok_or(VaultError::MathError)?;
    } else {
        pool_state.accumulated_usdc_fees = pool_state
            .accumulated_usdc_fees
            .checked_add(fee_amount)
            .ok_or(VaultError::MathError)?;
    }

    // Create pool seeds for signing
    let pool_seeds = &[b"pool_state".as_ref(), &[pool_state_bump]];

    // Transfer tokens from vault to user's token account
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_account.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: pool_state_info,
            },
        )
        .with_signer(&[pool_seeds]),
        withdrawal_amount,
    )?;

    // --- Update pool deposit totals ---
    if ctx.accounts.vault_account.key() == sol_vault {
        pool_state.sol_deposited = pool_state
            .sol_deposited
            .checked_sub(token_amount)
            .ok_or(VaultError::MathError)?;
    } else if ctx.accounts.vault_account.key() == usdc_vault {
        pool_state.usdc_deposited = pool_state
            .usdc_deposited
            .checked_sub(token_amount)
            .ok_or(VaultError::MathError)?;
    }

    Ok(())
}
