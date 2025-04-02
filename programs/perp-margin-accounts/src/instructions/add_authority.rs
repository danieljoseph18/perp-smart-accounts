use crate::errors::ErrorCode;
use crate::state::MarginVault;
use crate::state::MAX_AUTHORITIES;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct AddAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub margin_vault: Account<'info, MarginVault>,
}

pub fn add_authority(ctx: Context<AddAuthority>, new_authority: Pubkey) -> Result<()> {
    let margin_vault = &mut ctx.accounts.margin_vault;

    // Ensure only an existing authority can add new authorities
    require!(
        margin_vault.is_authority(&ctx.accounts.authority.key()),
        ErrorCode::Unauthorized
    );

    // Check if the authority already exists in the list
    if margin_vault.authorities.iter().any(|a| *a == new_authority) {
        return Err(ErrorCode::AuthorityAlreadyExists.into());
    }

    // Check if we've reached the maximum number of authorities
    require!(
        margin_vault.authorities.len() < MAX_AUTHORITIES,
        ErrorCode::MaxAuthoritiesReached
    );

    // Add the new authority
    margin_vault.authorities.push(new_authority);

    msg!("Added new authority: {}", new_authority);
    Ok(())
}
