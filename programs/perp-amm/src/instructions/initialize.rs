use crate::state::PoolState;
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, Mint, TokenAccount};

/// First instruction - initialize just the pool state
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// The PoolState (PDA) to store global info about the pool
    #[account(
        init,
        payer = admin,
        space = 8 + PoolState::INIT_SPACE,
        seeds = [b"pool_state".as_ref()],
        bump,
    )]
    pub pool_state: Box<Account<'info, PoolState>>,

    /// CHECK: Will be initialized in a separate instruction to avoid stack usage
    pub sol_vault: UncheckedAccount<'info>,
    /// CHECK: Will be initialized in a separate instruction to avoid stack usage
    pub usdc_vault: UncheckedAccount<'info>,
    /// CHECK: Will be initialized in a separate instruction to avoid stack usage
    pub usdc_reward_vault: UncheckedAccount<'info>,
    /// CHECK: Used as mint for SOL token vault
    pub sol_mint: UncheckedAccount<'info>,
    /// CHECK: Used as mint for USDC token vault
    pub usdc_mint: UncheckedAccount<'info>,
    /// CHECK: Will be initialized in a separate instruction to avoid stack usage
    pub lp_token_mint: UncheckedAccount<'info>,
    
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Initialize a vault token account in a separate instruction to avoid stack usage
#[derive(Accounts)]
#[instruction(seed: Vec<u8>)]
pub struct InitializeTokenVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    
    /// Pool state (PDA)
    pub pool_state: Account<'info, PoolState>,
    
    /// The vault token account to initialize
    #[account(
        init,
        payer = admin,
        seeds = [seed.as_ref(), pool_state.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool_state,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    
    /// The mint for this token account
    pub mint: Box<Account<'info, Mint>>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Initialize LP token mint in a separate instruction to avoid stack usage
#[derive(Accounts)]
pub struct InitializeLpMint<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    
    /// Pool state that will be the mint authority
    pub pool_state: Account<'info, PoolState>,
    
    /// The LP token mint to initialize
    #[account(
        init,
        payer = admin,
        mint::decimals = 9,
        mint::authority = pool_state,
        mint::freeze_authority = pool_state,
    )]
    pub lp_token_mint: Box<Account<'info, Mint>>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

// Initialize the pool state with minimal stack usage
pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
    // Save account keys to avoid multiple borrows
    let admin_key = ctx.accounts.admin.key();
    let sol_vault_key = ctx.accounts.sol_vault.key();
    let usdc_vault_key = ctx.accounts.usdc_vault.key();
    let usdc_mint_key = ctx.accounts.usdc_mint.key();
    let lp_token_mint_key = ctx.accounts.lp_token_mint.key();
    let usdc_reward_vault_key = ctx.accounts.usdc_reward_vault.key();
    
    // Set the pool state fields
    let pool_state = &mut ctx.accounts.pool_state;
    
    // Set admin and initialize empty authorities list
    pool_state.admin = admin_key;
    pool_state.authorities = Vec::new();
    
    // Set vault and mint addresses
    pool_state.sol_vault = sol_vault_key;
    pool_state.usdc_vault = usdc_vault_key;
    pool_state.usdc_mint = usdc_mint_key;
    pool_state.lp_token_mint = lp_token_mint_key;
    pool_state.usdc_reward_vault = usdc_reward_vault_key;
    
    // Initialize numeric fields to 0
    pool_state.sol_deposited = 0;
    pool_state.usdc_deposited = 0;
    pool_state.tokens_per_interval = 0;
    pool_state.reward_start_time = 0;
    pool_state.reward_end_time = 0;
    pool_state.total_rewards_deposited = 0;
    pool_state.total_rewards_claimed = 0;
    pool_state.cumulative_reward_per_token = 0;
    pool_state.last_distribution_time = 0;
    pool_state.accumulated_sol_fees = 0;
    pool_state.accumulated_usdc_fees = 0;

    Ok(())
}

// Handler function to initialize a token vault
// All PDA creation and validation is handled by Anchor constraints
pub fn initialize_token_vault(ctx: Context<InitializeTokenVault>, _seed: &[u8]) -> Result<()> {
    // Log the vault we just created
    msg!("Initialized token vault: {}", ctx.accounts.vault.key());
    
    // Return success - Anchor has handled all the initialization
    Ok(())
}

// Handler function to initialize the LP token mint
// All initialization is handled by Anchor constraints
pub fn initialize_lp_mint(ctx: Context<InitializeLpMint>) -> Result<()> {
    msg!("Initialized LP token mint: {}", ctx.accounts.lp_token_mint.key());
    Ok(())
}
