import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpAmm } from "../target/types/perp_amm";
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
import { assert } from "chai";
import BN from "bn.js";
import * as dotenv from "dotenv";
import { PerpMarginAccounts } from "../target/types/perp_margin_accounts";
import { initializeMarginProgram } from "./helpers/init-margin-program";
import { wrapSol } from "./helpers/wrap-sol";

dotenv.config();

describe("perp-amm (with configuration persistence)", () => {
  // Configure the client to use the local cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PerpAmm as Program<PerpAmm>;

  // Required for initialization
  const marginProgram = anchor.workspace
    .PerpMarginAccounts as Program<PerpMarginAccounts>;

  // Get the deployed chainlink_mock program
  const chainlinkProgram = new PublicKey(
    "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny"
  );

  // Devnet SOL/USD Price Feed
  const chainlinkFeed = new PublicKey(
    "99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR"
  );

  // Use a fixed keypair for admin
  const admin = Keypair.fromSeed(Uint8Array.from(Array(32).fill(1)));
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();

  // Set up token mints and vaults
  let usdcMint: PublicKey;
  let solVault: Account;
  let usdcVault: Account;
  let lpTokenMint: PublicKey;
  let solMint: PublicKey;

  // Set up pool state
  let poolState: PublicKey;

  let lpTokenMintKeypair: Keypair;

  // Set up token accounts
  let adminUsdcAccount: PublicKey;
  let adminSolAccount: PublicKey;
  let user1UsdcAccount: PublicKey;
  let user2UsdcAccount: PublicKey;

  // Flag to indicate if this is the first run
  let isFirstRun = false;

  // Global configuration state
  let configInitialized = false;

  before(async () => {
    console.log("=== Starting test setup ===");

    // Derive PDA for pool state
    [poolState] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_state")],
      program.programId
    );

    console.log("Pool State PDA:", poolState.toString());

    // Check if pool state exists
    const poolStateInfo = await provider.connection.getAccountInfo(poolState);

    if (poolStateInfo) {
      console.log("✓ Found existing pool state, using existing configuration");

      // Fetch the pool state to get all the configuration
      const poolStateAccount = await program.account.poolState.fetch(poolState);

      // Set all the configuration from the pool state
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
      console.log("- Chainlink feed:", chainlinkFeed.toString());
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
      isFirstRun = true;

      // Set up all accounts and configurations
      await setupInitialConfiguration();
    }

    configInitialized = true;
  });

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
      solMint,
      usdcMint,
      chainlinkProgram,
      chainlinkFeed,
      admin
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
        usdcMint: usdcMint,
        usdcRewardVault: usdcVault.address, // Using same vault for simplicity
        lpTokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin, lpTokenMintKeypair])
      .rpc();

    console.log("✓ Perp AMM program initialized successfully!");
    console.log("LP token mint:", lpTokenMint.toString());
  }

  // Use beforeEach to ensure all accounts are ready for each test
  beforeEach(async () => {
    // Ensure configuration is initialized before running tests
    if (!configInitialized) {
      throw new Error("Configuration not initialized");
    }
  });

  describe("admin_deposit", () => {
    it("should allow admin to deposit WSOL to the SOL vault", async () => {
      // Get the current pool state to ensure we're using the correct values
      const poolStateAccount = await program.account.poolState.fetch(poolState);

      // First, wrap some SOL for the admin
      await wrapSol(
        admin.publicKey,
        adminSolAccount,
        2 * LAMPORTS_PER_SOL,
        provider,
        admin
      );

      // Get SOL vault balance before deposit
      const solVaultBefore = await getAccount(
        provider.connection,
        poolStateAccount.solVault
      );
      // Check admin's WSOL balance before deposit
      const adminSolBefore = await getAccount(
        provider.connection,
        adminSolAccount
      );

      console.log(
        "Admin WSOL balance before deposit:",
        adminSolBefore.amount.toString()
      );

      const depositAmount = new BN(1_000_000_000); // 1 SOL
      await program.methods
        .adminDeposit(depositAmount)
        .accountsStrict({
          admin: admin.publicKey,
          poolState,
          adminTokenAccount: adminSolAccount,
          vaultAccount: poolStateAccount.solVault,
          chainlinkProgram: chainlinkProgram,
          chainlinkFeed: chainlinkFeed,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      // Get vault balance after admin deposit for verification
      const solVaultAfter = await getAccount(
        provider.connection,
        poolStateAccount.solVault
      );
      // Check admin's WSOL balance after deposit
      const adminSolAfter = await getAccount(
        provider.connection,
        adminSolAccount
      );

      // Verify that the vault balance increased by the deposit amount.
      assert.equal(
        new BN(solVaultAfter.amount.toString())
          .sub(new BN(solVaultBefore.amount.toString()))
          .toString(),
        depositAmount.toString(),
        "SOL vault balance should increase by deposit amount"
      );

      // Verify that the admin's WSOL balance decreased by the deposit amount
      assert.equal(
        new BN(adminSolBefore.amount.toString())
          .sub(new BN(adminSolAfter.amount.toString()))
          .toString(),
        depositAmount.toString(),
        "Admin WSOL balance should decrease by the deposit amount"
      );
    });

    it("should allow admin to deposit USDC", async () => {
      // Get the current pool state to ensure we're using the correct values
      const poolStateAccount = await program.account.poolState.fetch(poolState);

      // Get balances before admin deposit
      const usdcVaultBefore = await getAccount(
        provider.connection,
        poolStateAccount.usdcVault
      );
      const adminUsdcBefore = await getAccount(
        provider.connection,
        adminUsdcAccount
      );

      console.log(
        "Admin USDC balance before deposit:",
        adminUsdcBefore.amount.toString()
      );
      console.log(
        "USDC vault before deposit:",
        usdcVaultBefore.amount.toString()
      );

      const depositAmount = new BN(100_000_000); // 100 USDC

      // Admin deposit USDC
      await program.methods
        .adminDeposit(depositAmount)
        .accountsStrict({
          admin: admin.publicKey,
          poolState,
          adminTokenAccount: adminUsdcAccount,
          vaultAccount: poolStateAccount.usdcVault,
          chainlinkProgram: chainlinkProgram,
          chainlinkFeed: chainlinkFeed,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      // Get balances after admin deposit
      const usdcVaultAfter = await getAccount(
        provider.connection,
        poolStateAccount.usdcVault
      );
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const adminUsdcAfter = await getAccount(
        provider.connection,
        adminUsdcAccount
      );

      // Verify state changes
      assert.equal(
        new BN(usdcVaultAfter.amount.toString())
          .sub(new BN(usdcVaultBefore.amount.toString()))
          .toString(),
        depositAmount.toString(),
        "USDC vault balance should increase by deposit amount"
      );

      assert.equal(
        new BN(adminUsdcBefore.amount.toString())
          .sub(new BN(adminUsdcAfter.amount.toString()))
          .toString(),
        depositAmount.toString(),
        "Admin USDC balance should decrease by deposit amount"
      );

      assert.equal(
        poolStateAfter.usdcDeposited.toString(),
        poolStateAccount.usdcDeposited.add(depositAmount).toString(),
        "Pool USDC deposited should increase by deposit amount"
      );
    });

    it("should fail if non-admin tries to deposit", async () => {
      // Get the current pool state to ensure we're using the correct values
      const poolStateAccount = await program.account.poolState.fetch(poolState);

      try {
        // Create a token account for user1 to hold SOL tokens
        const user1SolAccount = await getOrCreateAssociatedTokenAccount(
          provider.connection,
          admin, // Fund with admin since user1 doesn't have enough SOL
          solMint,
          user1.publicKey
        );

        // Wrap some SOL for user1
        const wrapAmount = 1 * LAMPORTS_PER_SOL; // 1 SOL
        const wrapIx = SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: user1SolAccount.address,
          lamports: wrapAmount,
        });

        const wrapTx = new anchor.web3.Transaction().add(wrapIx);
        await provider.sendAndConfirm(wrapTx, [admin]);

        await program.methods
          .adminDeposit(new BN(LAMPORTS_PER_SOL))
          .accountsStrict({
            admin: user1.publicKey,
            poolState,
            adminTokenAccount: user1SolAccount.address,
            vaultAccount: poolStateAccount.solVault,
            chainlinkProgram: chainlinkProgram,
            chainlinkFeed: chainlinkFeed,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();

        assert.fail("Expected transaction to fail with unauthorized admin");
      } catch (error: any) {
        // We expect this to fail due to unauthorized access
        assert.include(
          error.message,
          "Unauthorized",
          "Expected error message about unauthorized admin"
        );
      }
    });
  });
});
