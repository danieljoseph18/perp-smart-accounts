import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpMarginAccounts } from "../target/types/perp_margin_accounts";
import {
  PublicKey,
  SystemProgram,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";
import BN from "bn.js";
import * as dotenv from "dotenv";
import { initializeMarginProgram } from "./helpers/init-margin-program";
import { wrapSol } from "./helpers/wrap-sol";

dotenv.config();

// Get the deployed chainlink_mock program
const chainlinkProgram = new PublicKey(
  "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny"
);

// Devnet SOL/USD Price Feed
const chainlinkFeed = new PublicKey(
  "99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR"
);

describe("perp-margin-accounts", () => {
  // Configure the client to use the local cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .PerpMarginAccounts as Program<PerpMarginAccounts>;

  // Use a fixed keypair for admin (for consistent testing)
  const admin = Keypair.fromSeed(Uint8Array.from(Array(32).fill(1)));
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();

  // Set up token mints and vaults
  let usdcMint: PublicKey;
  let solMint: PublicKey;
  let marginVault: PublicKey;
  let solVault: PublicKey;
  let usdcVault: PublicKey;

  // Set up token accounts
  let adminSolAccount: PublicKey;
  let adminUsdcAccount: PublicKey;
  let user1SolAccount: PublicKey;
  let user1UsdcAccount: PublicKey;
  let user2SolAccount: PublicKey;
  let user2UsdcAccount: PublicKey;

  // User margin accounts
  let user1MarginAccount: PublicKey;
  let user2MarginAccount: PublicKey;

  // Test parameters
  const solDepositAmount = new BN(LAMPORTS_PER_SOL); // 1 SOL
  const usdcDepositAmount = new BN(10_000_000); // 10 USDC (with 6 decimals)

  // Global configuration state
  let configInitialized = false;

  before(async () => {
    console.log("=== Starting test setup ===");

    // Set up the Margin program; this helper creates mints, vaults,
    // marginVault, and admin token accounts.
    const setup = await initializeMarginProgram(
      provider,
      program,
      NATIVE_MINT, // Use WSOL
      null, // Let the helper create the USDC mint
      chainlinkProgram,
      chainlinkFeed
    );

    // Retrieve configuration values from the setup helper.
    marginVault = setup.marginVault;
    solMint = NATIVE_MINT;
    solVault = setup.solVault;
    usdcVault = setup.usdcVault;

    // Create USDC mint since it's not returned by setup
    usdcMint = (await getAccount(provider.connection, usdcVault)).mint;

    // Create token accounts for all users
    adminSolAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        solMint,
        admin.publicKey
      )
    ).address;

    adminUsdcAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        usdcMint,
        admin.publicKey
      )
    ).address;

    user1SolAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        solMint,
        user1.publicKey
      )
    ).address;

    user1UsdcAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        usdcMint,
        user1.publicKey
      )
    ).address;

    user2SolAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        solMint,
        user2.publicKey
      )
    ).address;

    user2UsdcAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        usdcMint,
        user2.publicKey
      )
    ).address;

    // Mint USDC to user accounts
    await mintTo(
      provider.connection,
      admin,
      usdcMint,
      user1UsdcAccount,
      admin.publicKey,
      100_000_000 // 100 USDC
    );

    await mintTo(
      provider.connection,
      admin,
      usdcMint,
      user2UsdcAccount,
      admin.publicKey,
      100_000_000 // 100 USDC
    );

    // Wrap SOL for users
    await wrapSol(
      admin.publicKey,
      user1SolAccount,
      5 * LAMPORTS_PER_SOL,
      provider,
      admin
    );

    await wrapSol(
      admin.publicKey,
      user2SolAccount,
      5 * LAMPORTS_PER_SOL,
      provider,
      admin
    );

    // Derive user margin accounts
    [user1MarginAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("margin_account"), user1.publicKey.toBuffer()],
      program.programId
    );

    [user2MarginAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("margin_account"), user2.publicKey.toBuffer()],
      program.programId
    );

    configInitialized = true;
  });

  // Ensure configuration is initialized before each test.
  beforeEach(async () => {
    if (!configInitialized) {
      throw new Error("Configuration not initialized");
    }
  });

  describe("deposit_margin", () => {
    it("should initialize and deposit SOL to a new margin account", async () => {
      // Get initial balances
      const solVaultBefore = await getAccount(provider.connection, solVault);
      const user1SolBefore = await getAccount(
        provider.connection,
        user1SolAccount
      );

      // Initialize user1 margin account with a zero deposit
      await program.methods
        .depositMargin(new BN(0))
        .accountsStrict({
          marginAccount: user1MarginAccount,
          marginVault: marginVault,
          vaultTokenAccount: solVault,
          userTokenAccount: user1SolAccount,
          owner: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();

      // Get the margin account state after initialization
      const marginAccountInitialized =
        await program.account.marginAccount.fetch(user1MarginAccount);

      // Verify the margin account is initialized correctly
      assert.equal(
        marginAccountInitialized.owner.toString(),
        user1.publicKey.toString(),
        "Margin account owner should be user1"
      );
      assert.equal(
        marginAccountInitialized.solBalance.toString(),
        "0",
        "Initial SOL balance should be zero"
      );
      assert.equal(
        marginAccountInitialized.usdcBalance.toString(),
        "0",
        "Initial USDC balance should be zero"
      );

      // Deposit SOL
      await program.methods
        .depositMargin(solDepositAmount)
        .accountsStrict({
          marginAccount: user1MarginAccount,
          marginVault: marginVault,
          vaultTokenAccount: solVault,
          userTokenAccount: user1SolAccount,
          owner: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();

      // Get balances after deposit
      const solVaultAfter = await getAccount(provider.connection, solVault);
      const user1SolAfter = await getAccount(
        provider.connection,
        user1SolAccount
      );
      const marginAccountAfter = await program.account.marginAccount.fetch(
        user1MarginAccount
      );

      // Verify state changes
      assert.equal(
        new BN(solVaultAfter.amount.toString())
          .sub(new BN(solVaultBefore.amount.toString()))
          .toString(),
        solDepositAmount.toString(),
        "SOL vault balance should increase by deposit amount"
      );

      assert.equal(
        new BN(user1SolBefore.amount.toString())
          .sub(new BN(user1SolAfter.amount.toString()))
          .toString(),
        solDepositAmount.toString(),
        "User SOL balance should decrease by deposit amount"
      );

      assert.equal(
        marginAccountAfter.solBalance.toString(),
        solDepositAmount.toString(),
        "Margin account SOL balance should equal deposit amount"
      );
    });

    it("should initialize and deposit USDC to a new margin account", async () => {
      // Get initial balances
      const usdcVaultBefore = await getAccount(provider.connection, usdcVault);
      const user2UsdcBefore = await getAccount(
        provider.connection,
        user2UsdcAccount
      );

      // Initialize user2 margin account with a zero deposit
      await program.methods
        .depositMargin(new BN(0))
        .accountsStrict({
          marginAccount: user2MarginAccount,
          marginVault: marginVault,
          vaultTokenAccount: usdcVault,
          userTokenAccount: user2UsdcAccount,
          owner: user2.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user2])
        .rpc();

      // Deposit USDC
      await program.methods
        .depositMargin(usdcDepositAmount)
        .accountsStrict({
          marginAccount: user2MarginAccount,
          marginVault: marginVault,
          vaultTokenAccount: usdcVault,
          userTokenAccount: user2UsdcAccount,
          owner: user2.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user2])
        .rpc();

      // Get balances after deposit
      const usdcVaultAfter = await getAccount(provider.connection, usdcVault);
      const user2UsdcAfter = await getAccount(
        provider.connection,
        user2UsdcAccount
      );
      const marginAccountAfter = await program.account.marginAccount.fetch(
        user2MarginAccount
      );

      // Verify state changes
      assert.equal(
        new BN(usdcVaultAfter.amount.toString())
          .sub(new BN(usdcVaultBefore.amount.toString()))
          .toString(),
        usdcDepositAmount.toString(),
        "USDC vault balance should increase by deposit amount"
      );

      assert.equal(
        new BN(user2UsdcBefore.amount.toString())
          .sub(new BN(user2UsdcAfter.amount.toString()))
          .toString(),
        usdcDepositAmount.toString(),
        "User USDC balance should decrease by deposit amount"
      );

      assert.equal(
        marginAccountAfter.usdcBalance.toString(),
        usdcDepositAmount.toString(),
        "Margin account USDC balance should equal deposit amount"
      );
    });

    it("should deposit additional SOL to an existing margin account", async () => {
      // Get initial balances
      const solVaultBefore = await getAccount(provider.connection, solVault);
      const user1SolBefore = await getAccount(
        provider.connection,
        user1SolAccount
      );
      const marginAccountBefore = await program.account.marginAccount.fetch(
        user1MarginAccount
      );

      // Deposit more SOL
      const additionalSolDeposit = new BN(LAMPORTS_PER_SOL / 2); // 0.5 SOL
      await program.methods
        .depositMargin(additionalSolDeposit)
        .accountsStrict({
          marginAccount: user1MarginAccount,
          marginVault: marginVault,
          vaultTokenAccount: solVault,
          userTokenAccount: user1SolAccount,
          owner: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();

      // Get balances after deposit
      const solVaultAfter = await getAccount(provider.connection, solVault);
      const user1SolAfter = await getAccount(
        provider.connection,
        user1SolAccount
      );
      const marginAccountAfter = await program.account.marginAccount.fetch(
        user1MarginAccount
      );

      // Verify state changes
      assert.equal(
        new BN(solVaultAfter.amount.toString())
          .sub(new BN(solVaultBefore.amount.toString()))
          .toString(),
        additionalSolDeposit.toString(),
        "SOL vault balance should increase by additional deposit amount"
      );

      assert.equal(
        new BN(user1SolBefore.amount.toString())
          .sub(new BN(user1SolAfter.amount.toString()))
          .toString(),
        additionalSolDeposit.toString(),
        "User SOL balance should decrease by additional deposit amount"
      );

      assert.equal(
        marginAccountAfter.solBalance.toString(),
        new BN(marginAccountBefore.solBalance.toString())
          .add(additionalSolDeposit)
          .toString(),
        "Margin account SOL balance should increase by additional deposit amount"
      );
    });

    it("should deposit additional USDC to an existing margin account", async () => {
      // Get initial balances
      const usdcVaultBefore = await getAccount(provider.connection, usdcVault);
      const user2UsdcBefore = await getAccount(
        provider.connection,
        user2UsdcAccount
      );
      const marginAccountBefore = await program.account.marginAccount.fetch(
        user2MarginAccount
      );

      // Deposit more USDC
      const additionalUsdcDeposit = new BN(5_000_000); // 5 USDC
      await program.methods
        .depositMargin(additionalUsdcDeposit)
        .accountsStrict({
          marginAccount: user2MarginAccount,
          marginVault: marginVault,
          vaultTokenAccount: usdcVault,
          userTokenAccount: user2UsdcAccount,
          owner: user2.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user2])
        .rpc();

      // Get balances after deposit
      const usdcVaultAfter = await getAccount(provider.connection, usdcVault);
      const user2UsdcAfter = await getAccount(
        provider.connection,
        user2UsdcAccount
      );
      const marginAccountAfter = await program.account.marginAccount.fetch(
        user2MarginAccount
      );

      // Verify state changes
      assert.equal(
        new BN(usdcVaultAfter.amount.toString())
          .sub(new BN(usdcVaultBefore.amount.toString()))
          .toString(),
        additionalUsdcDeposit.toString(),
        "USDC vault balance should increase by additional deposit amount"
      );

      assert.equal(
        new BN(user2UsdcBefore.amount.toString())
          .sub(new BN(user2UsdcAfter.amount.toString()))
          .toString(),
        additionalUsdcDeposit.toString(),
        "User USDC balance should decrease by additional deposit amount"
      );

      assert.equal(
        marginAccountAfter.usdcBalance.toString(),
        new BN(marginAccountBefore.usdcBalance.toString())
          .add(additionalUsdcDeposit)
          .toString(),
        "Margin account USDC balance should increase by additional deposit amount"
      );
    });

    it("should fail to deposit if amount is zero", async () => {
      try {
        await program.methods
          .depositMargin(new BN(0))
          .accountsStrict({
            marginAccount: user1MarginAccount,
            marginVault: marginVault,
            vaultTokenAccount: solVault,
            userTokenAccount: user1SolAccount,
            owner: user1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();

        assert.fail("Expected transaction to fail with zero amount");
      } catch (error) {
        assert.include(
          error.message,
          "Error",
          "Expected error message about invalid token amount"
        );
      }
    });

    it("should fail to deposit if unauthorized user tries to deposit", async () => {
      try {
        // Try to deposit to user2's account using user1's signature
        await program.methods
          .depositMargin(new BN(1_000_000))
          .accountsStrict({
            marginAccount: user2MarginAccount,
            marginVault: marginVault,
            vaultTokenAccount: usdcVault,
            userTokenAccount: user1UsdcAccount,
            owner: user1.publicKey, // This should be user2
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();

        assert.fail("Expected transaction to fail with unauthorized user");
      } catch (error) {
        assert.include(
          error.message,
          "Error",
          "Expected error message about unauthorized user"
        );
      }
    });

    it("should fail to deposit if amount exceeds balance", async () => {
      const userSolBalance = await getAccount(
        provider.connection,
        user1SolAccount
      );
      const excessAmount = new BN(userSolBalance.amount.toString()).addn(1); // Balance + 1

      try {
        await program.methods
          .depositMargin(excessAmount)
          .accountsStrict({
            marginAccount: user1MarginAccount,
            marginVault: marginVault,
            vaultTokenAccount: solVault,
            userTokenAccount: user1SolAccount,
            owner: user1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();

        assert.fail("Expected transaction to fail with insufficient funds");
      } catch (error) {
        assert.include(
          error.message,
          "insufficient funds",
          "Expected error message about insufficient funds"
        );
      }
    });
  });
});
