import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpAmm } from "../../target/types/perp_amm";
import { PerpMarginAccounts } from "../../target/types/perp_margin_accounts";
import { ChainlinkMock } from "../../target/types/chainlink_mock";
import {
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  Account,
  getMint,
} from "@solana/spl-token";
import { initializeMarginProgram } from "./init-margin-program";
import BN from "bn.js";

// Initialize AMM program for testing
export async function setupAmmProgram(
  provider: anchor.AnchorProvider,
  program: Program<PerpAmm>,
  marginProgram: Program<PerpMarginAccounts>,
  chainlinkMockProgram: Program<ChainlinkMock>,
  admin: Keypair,
  user1: Keypair,
  user2: Keypair
) {
  console.log("=== Starting AMM program setup ===");

  // Derive PDA for pool state
  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")],
    program.programId
  );

  console.log("Pool State PDA:", poolState.toString());

  // Set up token mints and vaults
  let usdcMint: PublicKey;
  let solVault: Account;
  let usdcVault: Account;
  let lpTokenMint: PublicKey;
  let solMint: PublicKey;
  let lpTokenMintKeypair: Keypair;
  
  // Set up token accounts
  let adminUsdcAccount: PublicKey;
  let adminSolAccount: PublicKey;
  let user1UsdcAccount: PublicKey;
  let user2UsdcAccount: PublicKey;
  
  // Set up Chainlink mock
  let mockChainlinkFeed: PublicKey;
  let mockChainlinkFeedKeypair: Keypair;
  
  // Check if pool state exists
  const poolStateInfo = await provider.connection.getAccountInfo(poolState);

  if (poolStateInfo) {
    console.log("✓ Found existing pool state, using existing configuration");

    // Fetch the pool state to get all the configuration
    const poolStateAccount = await program.account.poolState.fetch(poolState);

    // Set all the configuration from the pool state
    mockChainlinkFeed = poolStateAccount.chainlinkPriceFeed;
    lpTokenMint = poolStateAccount.lpTokenMint;
    solMint = new PublicKey("So11111111111111111111111111111111111111112"); // Wrapped SOL is always this address

    // Use the vaults from the pool state
    const solVaultInfo = await getAccount(
      provider.connection,
      poolStateAccount.solVault
    );
    solVault = solVaultInfo;

    const usdcVaultInfo = await getAccount(
      provider.connection,
      poolStateAccount.usdcVault
    );
    usdcVault = usdcVaultInfo;

    // Get USDC mint from the USDC vault
    usdcMint = usdcVaultInfo.mint;

    console.log("Using existing configuration:");
    console.log("- Chainlink feed:", mockChainlinkFeed.toString());
    console.log("- LP Token mint:", lpTokenMint.toString());
    console.log("- SOL vault:", solVault.address.toString());
    console.log("- USDC vault:", usdcVault.address.toString());
    console.log("- USDC mint:", usdcMint.toString());

    // Create or get token accounts for testing
    await setupUserAccounts();
  } else {
    console.log(
      "No existing pool state found, will create new configuration"
    );

    // Create Chainlink feed if it doesn't exist
    mockChainlinkFeedKeypair = Keypair.generate();
    mockChainlinkFeed = mockChainlinkFeedKeypair.publicKey;

    // Fund the feed account so it exists on chain
    const mockFeedTx = await provider.connection.requestAirdrop(
      mockChainlinkFeed,
      LAMPORTS_PER_SOL / 100
    );
    await provider.connection.confirmTransaction(mockFeedTx);

    // Initialize the mock Chainlink feed with an initial price
    await chainlinkMockProgram.methods
      .initialize(new BN(100_000_000)) // $100.00
      .accountsStrict({
        feed: mockChainlinkFeed,
        owner: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin, mockChainlinkFeedKeypair])
      .rpc();

    console.log("Created new Chainlink feed:", mockChainlinkFeed.toString());

    // Set up all accounts and configurations
    await setupInitialConfiguration();
  }

  // Helper function to setup user accounts for testing
  async function setupUserAccounts() {
    console.log("Setting up user accounts for testing...");

    // Airdrop SOL to admin and users for transaction fees
    await ensureMinimumBalance(admin.publicKey, 5 * LAMPORTS_PER_SOL);
    await ensureMinimumBalance(user1.publicKey, 2 * LAMPORTS_PER_SOL);
    await ensureMinimumBalance(user2.publicKey, 2 * LAMPORTS_PER_SOL);

    // Get or create token accounts for all users
    const adminUsdcAccountInfo = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      admin.publicKey
    );
    adminUsdcAccount = adminUsdcAccountInfo.address;

    const user1UsdcAccountInfo = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      user1.publicKey
    );
    user1UsdcAccount = user1UsdcAccountInfo.address;

    const user2UsdcAccountInfo = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      user2.publicKey
    );
    user2UsdcAccount = user2UsdcAccountInfo.address;

    // Get or create SOL token account for admin
    const adminSolAccountInfo = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      solMint,
      admin.publicKey
    );
    adminSolAccount = adminSolAccountInfo.address;

    // Mint some USDC to accounts if they have low balance
    const adminUsdcBalance = (
      await getAccount(provider.connection, adminUsdcAccount)
    ).amount;
    if (
      adminUsdcBalance.toString() === "0" ||
      BigInt(adminUsdcBalance.toString()) < BigInt(10_000_000_000)
    ) {
      // Only mint more if we have permission (admin is the mint authority)
      try {
        const mintInfo = await getMint(provider.connection, usdcMint);
        if (mintInfo.mintAuthority?.toString() === admin.publicKey.toString()) {
          console.log("Minting additional USDC to admin account");
          await mintTo(
            provider.connection,
            admin,
            usdcMint,
            adminUsdcAccount,
            admin.publicKey,
            1_000_000_000_000 // 1,000,000 USDC
          );

          // Mint to user accounts if needed
          const user1UsdcBalance = (
            await getAccount(provider.connection, user1UsdcAccount)
          ).amount;
          if (user1UsdcBalance.toString() === "0") {
            await mintTo(
              provider.connection,
              admin,
              usdcMint,
              user1UsdcAccount,
              admin.publicKey,
              1_000_000_000 // 1,000 USDC
            );
          }

          const user2UsdcBalance = (
            await getAccount(provider.connection, user2UsdcAccount)
          ).amount;
          if (user2UsdcBalance.toString() === "0") {
            await mintTo(
              provider.connection,
              admin,
              usdcMint,
              user2UsdcAccount,
              admin.publicKey,
              1_000_000_000 // 1,000 USDC
            );
          }
        } else {
          console.log("Admin is not the mint authority, cannot mint more USDC");
        }
      } catch (error) {
        console.error("Error minting USDC:", error);
      }
    }

    // Ensure admin has wrapped SOL for testing
    const adminSolBalance = (
      await getAccount(provider.connection, adminSolAccount)
    ).amount;
    if (adminSolBalance.toString() === "0") {
      console.log("Wrapping SOL for admin...");
      // Wrap native SOL to get wrapped SOL tokens
      const wrapAmount = 10 * LAMPORTS_PER_SOL; // 10 SOL
      const wrapIx = SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: adminSolAccount,
        lamports: wrapAmount,
      });

      const wrapTx = new anchor.web3.Transaction().add(wrapIx);
      await provider.sendAndConfirm(wrapTx, [admin]);
    }
  }

  // Helper function to ensure an account has minimum SOL balance
  async function ensureMinimumBalance(address: PublicKey, minBalance: number) {
    const balance = await provider.connection.getBalance(address);
    if (balance < minBalance) {
      console.log(`Airdropping SOL to ${address.toString()}...`);
      const airdropTx = await provider.connection.requestAirdrop(
        address,
        minBalance - balance
      );
      await provider.connection.confirmTransaction(airdropTx);
    }
  }

  // Set up initial configuration (only called on first run)
  async function setupInitialConfiguration() {
    console.log("Setting up initial configuration...");

    // Airdrop SOL to admin and users
    await ensureMinimumBalance(admin.publicKey, 100 * LAMPORTS_PER_SOL);
    await ensureMinimumBalance(user1.publicKey, 10 * LAMPORTS_PER_SOL);
    await ensureMinimumBalance(user2.publicKey, 10 * LAMPORTS_PER_SOL);

    console.log("Creating USDC mint...");

    // Create USDC mint
    usdcMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    console.log("USDC mint created:", usdcMint.toString());

    // Create token accounts for all users
    const adminUsdcAccountInfo = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      admin.publicKey
    );
    adminUsdcAccount = adminUsdcAccountInfo.address;

    const user1UsdcAccountInfo = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      user1.publicKey
    );
    user1UsdcAccount = user1UsdcAccountInfo.address;

    const user2UsdcAccountInfo = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      user2.publicKey
    );
    user2UsdcAccount = user2UsdcAccountInfo.address;

    // Mint initial USDC to accounts
    await mintTo(
      provider.connection,
      admin,
      usdcMint,
      adminUsdcAccount,
      admin.publicKey,
      1_000_000_000_000 // 1,000,000 USDC
    );

    await mintTo(
      provider.connection,
      admin,
      usdcMint,
      user1UsdcAccount,
      admin.publicKey,
      1_000_000_000 // 1,000 USDC
    );

    await mintTo(
      provider.connection,
      admin,
      usdcMint,
      user2UsdcAccount,
      admin.publicKey,
      1_000_000_000 // 1,000 USDC
    );

    // Use wrapped SOL
    solMint = new PublicKey("So11111111111111111111111111111111111111112");

    // Create token accounts for admin's wrapped SOL
    const adminSolAccountInfo = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      solMint,
      admin.publicKey
    );
    adminSolAccount = adminSolAccountInfo.address;

    // Wrap native SOL to get wrapped SOL tokens
    const wrapAmount = 50 * LAMPORTS_PER_SOL; // 50 SOL
    const wrapIx = SystemProgram.transfer({
      fromPubkey: admin.publicKey,
      toPubkey: adminSolAccount,
      lamports: wrapAmount,
    });

    const wrapTx = new anchor.web3.Transaction().add(wrapIx);
    await provider.sendAndConfirm(wrapTx, [admin]);

    // Derive margin vault PDA
    const [marginVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("margin_vault")],
      marginProgram.programId
    );

    // Create vault accounts with margin vault PDA as owner
    solVault = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      solMint,
      marginVault,
      true
    );

    usdcVault = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      marginVault,
      true
    );

    console.log("SOL vault:", solVault.address.toString());
    console.log("USDC vault:", usdcVault.address.toString());

    // Initialize margin program
    await initializeMarginProgram(
      provider,
      marginProgram,
      solVault.address,
      usdcVault.address,
      chainlinkMockProgram.programId,
      mockChainlinkFeed
    );

    // Create a keypair for the LP token mint
    lpTokenMintKeypair = Keypair.generate();
    lpTokenMint = lpTokenMintKeypair.publicKey;

    // Initialize Perp AMM program
    await program.methods
      .initialize()
      .accountsStrict({
        admin: admin.publicKey,
        authority: marginProgram.programId,
        poolState,
        solVault: solVault.address,
        usdcVault: usdcVault.address,
        usdcRewardVault: usdcVault.address, // Using same vault for simplicity
        lpTokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        chainlinkProgramId: chainlinkMockProgram.programId,
        chainlinkPriceFeed: mockChainlinkFeed,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin, lpTokenMintKeypair])
      .rpc();

    console.log("✓ Perp AMM program initialized successfully!");
    console.log("LP token mint:", lpTokenMint.toString());
  }

  return {
    poolState,
    solMint,
    usdcMint,
    lpTokenMint,
    solVault: solVault.address,
    usdcVault: usdcVault.address,
    mockChainlinkFeed,
    adminSolAccount,
    adminUsdcAccount,
    user1UsdcAccount,
    user2UsdcAccount
  };
}