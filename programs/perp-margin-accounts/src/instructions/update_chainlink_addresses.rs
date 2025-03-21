use crate::errors::MarginError;
use crate::state::MarginVault;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct UpdateChainlinkAddresses<'info> {
    #[account(
        mut,
        seeds = [b"margin_vault"],
        bump = margin_vault.bump,
        constraint = authority.key() == margin_vault.authority @ MarginError::InvalidAuthority
    )]
    pub margin_vault: Account<'info, MarginVault>,

    #[account(
        constraint = authority.key() == margin_vault.authority @ MarginError::InvalidAuthority
    )]
    pub authority: Signer<'info>,
}

pub fn handler(
    ctx: Context<UpdateChainlinkAddresses>,
    chainlink_program: Pubkey,
    chainlink_feed: Pubkey,
) -> Result<()> {
    let margin_vault = &mut ctx.accounts.margin_vault;

    // Update the chainlink addresses
    margin_vault.chainlink_program = chainlink_program;
    margin_vault.chainlink_feed = chainlink_feed;

    msg!("Chainlink addresses updated successfully");
    Ok(())
}
