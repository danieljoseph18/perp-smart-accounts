use crate::{
    errors::VaultError, instructions::update_rewards::*, state::*, CHAINLINK_PROGRAM_ID,
    DEVNET_SOL_PRICE_FEED, MAINNET_SOL_PRICE_FEED,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};
use chainlink_solana as chainlink;

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [b"pool-state".as_ref()], bump)]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserState::LEN,
        seeds = [b"user-state".as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_state: Account<'info, UserState>,

    #[account(mut, constraint = lp_token_mint.key() == pool_state.lp_token_mint)]
    pub lp_token_mint: Account<'info, Mint>,

    #[account(mut, constraint = user_lp_token_account.owner == user.key(), constraint = user_lp_token_account.mint == lp_token_mint.key())]
    pub user_lp_token_account: Account<'info, TokenAccount>,

    #[account(mut, constraint = vault_account.key() == pool_state.sol_vault || vault_account.key() == pool_state.usdc_vault)]
    pub vault_account: Account<'info, TokenAccount>,

    #[account(mut, constraint = user_token_account.owner == user.key(), constraint = user_token_account.mint == vault_account.mint)]
    pub user_token_account: Account<'info, TokenAccount>,

    /// CHECK: Validated in constraint
    #[account(address = CHAINLINK_PROGRAM_ID.parse::<Pubkey>().unwrap())]
    pub chainlink_program: AccountInfo<'info>,

    /// CHECK: Validated in constraint
    #[account(address = if cfg!(feature = "devnet") { DEVNET_SOL_PRICE_FEED } else { MAINNET_SOL_PRICE_FEED }.parse::<Pubkey>().unwrap())]
    pub chainlink_feed: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,

    pub system_program: Program<'info, System>,
}

pub fn handle_withdraw(ctx: Context<Withdraw>, lp_token_amount: u64) -> Result<()> {
    let pool_state = &mut ctx.accounts.pool_state;
    let user_state = &mut ctx.accounts.user_state;

    // 1. Check LP balance
    if user_state.lp_token_balance < lp_token_amount {
        return err!(VaultError::InsufficientLpBalance);
    }

    // 2. Update rewards
    update_rewards(pool_state, user_state, &ctx.accounts.lp_token_mint)?;

    // 3. Burn LP tokens
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

    // 4. Adjust user LP balance
    user_state.lp_token_balance = user_state
        .lp_token_balance
        .checked_sub(lp_token_amount)
        .ok_or(VaultError::MathError)?;

    // 5. Compute AUM
    if ctx.accounts.vault_account.key() == pool_state.sol_vault {
        let round = chainlink::latest_round_data(
            ctx.accounts.chainlink_program.to_account_info(),
            ctx.accounts.chainlink_feed.to_account_info(),
        )?;
        pool_state.sol_usd_price = round.answer;
    }
    let total_sol_usd = get_sol_usd_value(pool_state.sol_deposited, pool_state.sol_usd_price)?;
    let current_aum = total_sol_usd
        .checked_add(pool_state.usdc_deposited)
        .ok_or(VaultError::MathError)?;

    // 6. Calculate withdrawal USD value
    let lp_supply = ctx.accounts.lp_token_mint.supply.max(1);
    let withdrawal_usd_value = lp_token_amount
        .checked_mul(current_aum)
        .ok_or(VaultError::MathError)?
        .checked_div(lp_supply)
        .ok_or(VaultError::MathError)?;

    // 7. Convert to token amount and apply fee
    let token_amount = if ctx.accounts.vault_account.key() == pool_state.sol_vault {
        get_sol_amount_from_usd(withdrawal_usd_value, pool_state.sol_usd_price)?
    } else if ctx.accounts.vault_account.key() == pool_state.usdc_vault {
        withdrawal_usd_value
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

    // 8. Update fees
    if ctx.accounts.vault_account.key() == pool_state.sol_vault {
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

    // 9. Transfer tokens
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_account.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: pool_state.to_account_info(),
            },
        )
        .with_signer(&[&[b"pool-state".as_ref(), &[ctx.bumps.pool_state]]]),
        withdrawal_amount,
    )?;

    // 10. Update pool deposited amounts
    if ctx.accounts.vault_account.key() == pool_state.sol_vault {
        pool_state.sol_deposited = pool_state
            .sol_deposited
            .checked_sub(token_amount)
            .ok_or(VaultError::MathError)?;
    } else if ctx.accounts.vault_account.key() == pool_state.usdc_vault {
        pool_state.usdc_deposited = pool_state
            .usdc_deposited
            .checked_sub(token_amount)
            .ok_or(VaultError::MathError)?;
    }

    Ok(())
}
