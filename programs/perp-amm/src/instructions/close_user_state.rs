use crate::{errors::VaultError, state::*};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CloseUserState<'info> {
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_state".as_ref()],
        bump,
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        mut,
        seeds = [b"user_state".as_ref(), user.key().as_ref()],
        bump,
        constraint = (user_state.owner == user.key() || pool_state.admin == user.key()) @ VaultError::Unauthorized,
        close = user
    )]
    pub user_state: Account<'info, UserState>,

    pub system_program: Program<'info, System>,
}

pub fn handler(_ctx: Context<CloseUserState>) -> Result<()> {
    Ok(())
}
