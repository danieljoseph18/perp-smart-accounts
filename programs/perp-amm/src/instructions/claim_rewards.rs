use crate::state::*;
use crate::{errors::VaultError, util::*, RewardsClaimed};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_state".as_ref()],
        bump
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        mut,
        seeds = [b"user_state".as_ref(), user.key().as_ref()],
        bump,
        constraint = user_state.owner == user.key()
    )]
    pub user_state: Account<'info, UserState>,

    #[account(
        mut,
        constraint = usdc_reward_vault.key() == pool_state.usdc_reward_vault @ VaultError::InvalidRewardVault
    )]
    pub usdc_reward_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_usdc_account.owner == user.key(),
        constraint = user_usdc_account.mint == usdc_reward_vault.mint
    )]
    pub user_usdc_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,

    #[account(
        constraint = lp_token_mint.key() == pool_state.lp_token_mint @ VaultError::InvalidTokenMint
    )]
    pub lp_token_mint: Account<'info, Mint>,
}

pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
    // Store validation values up front
    let now = Clock::get()?.unix_timestamp as u64;
    let reward_start_time = ctx.accounts.pool_state.reward_start_time;
    let total_rewards_deposited = ctx.accounts.pool_state.total_rewards_deposited;
    let total_rewards_claimed = ctx.accounts.pool_state.total_rewards_claimed;
    let vault_amount = ctx.accounts.usdc_reward_vault.amount;
    let pool_state_bump = ctx.bumps.pool_state;
    let user_key = ctx.accounts.user.key();

    // Do validation checks with stored values
    require!(now >= reward_start_time, VaultError::RewardsNotStarted);

    require!(
        ctx.accounts.user_state.lp_token_balance > 0,
        VaultError::NoLPTokens
    );

    let available = total_rewards_deposited.saturating_sub(total_rewards_claimed);

    require!(
        vault_amount >= available,
        VaultError::InsufficientRewardBalance
    );

    // First update rewards and calculate how much to claim
    let amount_to_claim: u64;
    let new_total_claimed: u64;

    {
        // Use a block to limit the scope of mutable borrows
        let pool_state = &mut ctx.accounts.pool_state;
        let user_state = &mut ctx.accounts.user_state;

        // 1) Update user's accrual to get an up-to-date `pending_rewards`
        update_rewards(pool_state, user_state, &ctx.accounts.lp_token_mint)?;

        // 2) The user now has some "pending" amount stored locally
        let pending = user_state.pending_rewards;
        if pending == 0 {
            // No rewards to claim
            return Ok(());
        }

        // 3) Check how much is still available in the reward pool
        let available = pool_state
            .total_rewards_deposited
            .saturating_sub(pool_state.total_rewards_claimed);

        // Add vault balance check
        let vault_balance = ctx.accounts.usdc_reward_vault.amount;
        require!(
            vault_balance >= available,
            VaultError::InsufficientRewardBalance
        );

        // Clamp the user's claim if not enough remains in the reward pool
        let to_claim = pending.min(available as u128);
        if to_claim == 0 {
            return Ok(());
        }

        // Store the amount to claim for later use
        amount_to_claim = to_claim as u64;

        // 5) Update global and user-level state
        pool_state.total_rewards_claimed = pool_state
            .total_rewards_claimed
            .checked_add(amount_to_claim)
            .ok_or_else(|| error!(VaultError::MathError))?;

        new_total_claimed = pool_state.total_rewards_claimed;

        user_state.pending_rewards = user_state
            .pending_rewards
            .checked_sub(to_claim)
            .ok_or_else(|| error!(VaultError::MathError))?;
    }

    // Now perform the token transfer with the pool_state as authority
    let seeds = &[b"pool_state".as_ref(), &[pool_state_bump]];
    let signer = &[&seeds[..]];

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.usdc_reward_vault.to_account_info(),
            to: ctx.accounts.user_usdc_account.to_account_info(),
            authority: ctx.accounts.pool_state.to_account_info(),
        },
        signer,
    );
    token::transfer(cpi_ctx, amount_to_claim)?;

    // Emit event for subgraph indexing
    emit!(RewardsClaimed {
        user: user_key,
        amount: amount_to_claim,
        timestamp: Clock::get()?.unix_timestamp,
        total_claimed: new_total_claimed,
    });

    Ok(())
}
