use crate::errors::ErrorCode;
use crate::state::MarginVault;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RemoveAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub margin_vault: Account<'info, MarginVault>,
}

pub fn remove_authority(ctx: Context<RemoveAuthority>, authority_to_remove: Pubkey) -> Result<()> {
    let margin_vault = &mut ctx.accounts.margin_vault;

    // Ensure only an existing authority can remove authorities
    require!(
        margin_vault.is_authority(&ctx.accounts.authority.key()),
        ErrorCode::Unauthorized
    );

    // Cannot remove the last authority
    require!(
        margin_vault.authorities.len() > 1,
        ErrorCode::CannotRemoveLastAuthority
    );

    // Cannot remove self if it would be the last authority
    if ctx.accounts.authority.key() == authority_to_remove && margin_vault.authorities.len() <= 1 {
        return Err(ErrorCode::CannotRemoveLastAuthority.into());
    }

    // Find and remove the authority
    let initial_len = margin_vault.authorities.len();
    margin_vault
        .authorities
        .retain(|&a| a != authority_to_remove);

    // Check if authority was found and removed
    require!(
        margin_vault.authorities.len() < initial_len,
        ErrorCode::AuthorityNotFound
    );

    msg!("Removed authority: {}", authority_to_remove);
    Ok(())
}
