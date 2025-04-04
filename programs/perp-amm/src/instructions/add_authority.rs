use crate::errors::ErrorCode;
use crate::state::PoolState;
use crate::state::MAX_AUTHORITIES;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct AddAuthority<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut)]
    pub pool_state: Account<'info, PoolState>,
}

pub fn add_authority(ctx: Context<AddAuthority>, new_authority: Pubkey) -> Result<()> {
    let pool_state = &mut ctx.accounts.pool_state;

    // Ensure only the admin can add new authorities
    require_keys_eq!(
        pool_state.admin,
        ctx.accounts.admin.key(),
        ErrorCode::Unauthorized
    );

    // Check if the authority already exists in the list
    if pool_state.authorities.iter().any(|a| *a == new_authority) {
        return Err(ErrorCode::AuthorityAlreadyExists.into());
    }

    // Check if we've reached the maximum number of authorities
    require!(
        pool_state.authorities.len() < MAX_AUTHORITIES,
        ErrorCode::MaxAuthoritiesReached
    );

    // Add the new authority
    pool_state.authorities.push(new_authority);

    msg!("Added new authority: {}", new_authority);
    Ok(())
}
