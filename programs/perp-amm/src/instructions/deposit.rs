use crate::{
    errors::VaultError, instructions::update_rewards::*, state::*, CHAINLINK_PROGRAM_ID,
    DEVNET_SOL_PRICE_FEED, MAINNET_SOL_PRICE_FEED, NATIVE_MINT,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};
use chainlink_solana as chainlink;

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [b"pool_state".as_ref()], bump)]
    pub pool_state: Account<'info, PoolState>,

    // Token account, e.g WSOL or USDC
    #[account(
        mut,
        constraint = user_token_account.mint == NATIVE_MINT.parse::<Pubkey>().unwrap() || user_token_account.mint == pool_state.usdc_mint
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = vault_account.key() == pool_state.sol_vault
            || vault_account.key() == pool_state.usdc_vault
    )]
    pub vault_account: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserState::LEN,
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

pub fn handle_deposit(ctx: Context<Deposit>, token_amount: u64) -> Result<()> {
    let pool_state = &mut ctx.accounts.pool_state;
    let user_state = &mut ctx.accounts.user_state;
    let clock = Clock::get()?;

    // Validate input token amount.
    if token_amount == 0 {
        return err!(VaultError::InvalidTokenAmount);
    }

    // 1. Update rewards for the user.
    update_rewards(pool_state, user_state, &ctx.accounts.lp_token_mint)?;

    // 2. Initialize last claim timestamp for new accounts.
    if user_state.lp_token_balance == 0 && user_state.previous_cumulated_reward_per_token == 0 {
        user_state.last_claim_timestamp = clock.unix_timestamp as u64;
    }

    // 3. Calculate deposit fee (0.1%) and net deposit.
    let fee_amount = token_amount
        .checked_div(1000)
        .ok_or(VaultError::MathError)?;
    let deposit_amount = token_amount
        .checked_sub(fee_amount)
        .ok_or(VaultError::MathError)?;

    // 4. Update price feeds and accumulated fees.
    if ctx.accounts.vault_account.key() == pool_state.sol_vault {
        let round = chainlink::latest_round_data(
            ctx.accounts.chainlink_program.to_account_info(),
            ctx.accounts.chainlink_feed.to_account_info(),
        )?;
        pool_state.sol_usd_price = round.answer;
        pool_state.accumulated_sol_fees = pool_state
            .accumulated_sol_fees
            .checked_add(fee_amount)
            .ok_or(VaultError::MathError)?;
    } else if ctx.accounts.vault_account.key() == pool_state.usdc_vault {
        pool_state.accumulated_usdc_fees = pool_state
            .accumulated_usdc_fees
            .checked_add(fee_amount)
            .ok_or(VaultError::MathError)?;
    }

    // 5. Transfer the deposit from user to vault.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.vault_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        token_amount,
    )?;

    // 6. Compute initial Assets Under Management (AUM).
    let total_sol_usd = get_sol_usd_value(pool_state.sol_deposited, pool_state.sol_usd_price)?;
    let initial_aum = total_sol_usd
        .checked_add(pool_state.usdc_deposited)
        .ok_or(VaultError::MathError)?;

    // 7. Update vault deposited amounts and compute the USD value of the deposit.
    let deposit_usd = if ctx.accounts.vault_account.key() == pool_state.sol_vault {
        pool_state.sol_deposited = pool_state
            .sol_deposited
            .checked_add(deposit_amount)
            .ok_or(VaultError::MathError)?;
        get_sol_usd_value(deposit_amount, pool_state.sol_usd_price)?
    } else if ctx.accounts.vault_account.key() == pool_state.usdc_vault {
        pool_state.usdc_deposited = pool_state
            .usdc_deposited
            .checked_add(deposit_amount)
            .ok_or(VaultError::MathError)?;
        deposit_amount
    } else {
        return err!(VaultError::InvalidTokenMint);
    };

    // 8. Calculate how many LP tokens to mint.
    let lp_supply = ctx.accounts.lp_token_mint.supply;
    let lp_to_mint = if lp_supply == 0 {
        deposit_usd
    } else {
        deposit_usd
            .checked_mul(lp_supply)
            .ok_or(VaultError::MathError)?
            .checked_div(initial_aum.max(1))
            .ok_or(VaultError::MathError)?
    };

    // 9. Mint LP tokens to the user.
    token::mint_to(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.lp_token_mint.to_account_info(),
                to: ctx.accounts.user_lp_token_account.to_account_info(),
                authority: ctx.accounts.pool_state.to_account_info(),
            },
        )
        .with_signer(&[&[b"pool_state".as_ref(), &[ctx.bumps.pool_state]]]),
        lp_to_mint,
    )?;

    // 10. Update the user's LP token balance.
    user_state.owner = ctx.accounts.user.key();
    user_state.lp_token_balance = user_state
        .lp_token_balance
        .checked_add(lp_to_mint)
        .ok_or(VaultError::MathError)?;

    Ok(())
}
