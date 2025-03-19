use anchor_lang::prelude::*;
use anchor_lang::solana_program::account_info::AccountInfo;

declare_id!("H2C4RzQ7FfKF2W8MKigHorSx3enRiVzaWWLXKDfJQjt9");

#[program]
pub mod chainlink_mock {
    use super::*;

    // Initialize a price feed
    pub fn initialize(ctx: Context<Initialize>, initial_price: i128) -> Result<()> {
        let feed = &mut ctx.accounts.feed;
        feed.owner = *ctx.accounts.owner.key;
        feed.latest_answer = initial_price;
        feed.latest_round = 1;
        feed.started_at = Clock::get()?.unix_timestamp;
        feed.updated_at = Clock::get()?.unix_timestamp;
        feed.answered_in_round = 1;

        Ok(())
    }

    // Update the price in a feed
    pub fn update_price(ctx: Context<UpdatePrice>, price: i128) -> Result<()> {
        let feed = &mut ctx.accounts.feed;
        require!(
            feed.owner == *ctx.accounts.owner.key,
            FeedError::Unauthorized
        );

        feed.latest_answer = price;
        feed.latest_round += 1;
        feed.updated_at = Clock::get()?.unix_timestamp;
        feed.answered_in_round = feed.latest_round;

        Ok(())
    }

    // This instruction won't be directly called by the chainlink_solana crate
    pub fn latest_round_data(ctx: Context<ReadFeed>) -> Result<Round> {
        let feed = &ctx.accounts.feed;

        Ok(Round {
            round_id: feed.latest_round,
            answer: feed.latest_answer,
            started_at: feed.started_at,
            updated_at: feed.updated_at,
            answered_in_round: feed.answered_in_round,
        })
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + PriceFeed::LEN
    )]
    pub feed: Account<'info, PriceFeed>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePrice<'info> {
    #[account(mut)]
    pub feed: Account<'info, PriceFeed>,

    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct ReadFeed<'info> {
    pub feed: Account<'info, PriceFeed>,
}

#[account]
#[derive(Default)]
pub struct PriceFeed {
    pub owner: Pubkey,           // 32 bytes
    pub latest_answer: i128,     // 16 bytes
    pub latest_round: u128,      // 16 bytes
    pub started_at: i64,         // 8 bytes
    pub updated_at: i64,         // 8 bytes
    pub answered_in_round: u128, // 16 bytes
}

impl PriceFeed {
    pub const LEN: usize = 32 + 16 + 16 + 8 + 8 + 16; // 96 bytes
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct Round {
    pub round_id: u128,
    pub answer: i128,
    pub started_at: i64,
    pub updated_at: i64,
    pub answered_in_round: u128,
}

#[error_code]
pub enum FeedError {
    #[msg("You are not authorized to perform this action")]
    Unauthorized,

    #[msg("Invalid account data")]
    InvalidAccountData,
}
