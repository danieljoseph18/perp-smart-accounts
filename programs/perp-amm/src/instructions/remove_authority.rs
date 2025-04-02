use crate::errors::ErrorCode;
use crate::state::PoolState;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RemoveAuthority<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut)]
    pub pool_state: Account<'info, PoolState>,
}

pub fn remove_authority(ctx: Context<RemoveAuthority>, authority_to_remove: Pubkey) -> Result<()> {
    let pool_state = &mut ctx.accounts.pool_state;

    // Ensure only the admin can remove authorities
    require_keys_eq!(
        pool_state.admin,
        ctx.accounts.admin.key(),
        ErrorCode::Unauthorized
    );

    // Cannot remove the last authority
    require!(
        pool_state.authorities.len() > 1,
        ErrorCode::CannotRemoveLastAuthority
    );

    // Find and remove the authority
    let initial_len = pool_state.authorities.len();
    pool_state.authorities.retain(|&a| a != authority_to_remove);

    // Check if authority was found and removed
    require!(
        pool_state.authorities.len() < initial_len,
        ErrorCode::AuthorityNotFound
    );

    msg!("Removed authority: {}", authority_to_remove);
    Ok(())
}
