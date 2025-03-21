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
import { setupAmmProgram } from "./helpers/init-amm-program";
import { PerpAmm } from "../target/types/perp_amm";

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

  const ammProgram = anchor.workspace.PerpAmm as Program<PerpAmm>;

  const marginProgram = anchor.workspace
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
  let lpTokenMint: PublicKey;

  // Set up pool state
  let poolState: PublicKey;

  // Set up token accounts
  let adminSolAccount: PublicKey;
  let adminUsdcAccount: PublicKey;
  let user1SolAccount: PublicKey;
  let user1UsdcAccount: PublicKey;
  let user2SolAccount: PublicKey;
  let user2UsdcAccount: PublicKey;

  // User states
  let user1State: PublicKey;
  let user2State: PublicKey;

  // User LP token accounts
  let user1LpTokenAccount: PublicKey;
  let user2LpTokenAccount: PublicKey;

  // User margin accounts
  let user1MarginAccount: PublicKey;
  let user2MarginAccount: PublicKey;

  let marginSolVault: PublicKey;
  let marginUsdcVault: PublicKey;

  // Test parameters
  const solDepositAmount = new BN(LAMPORTS_PER_SOL); // 1 SOL
  const usdcDepositAmount = new BN(10_000_000); // 10 USDC (with 6 decimals)

  // Global configuration state
  let configInitialized = false;

  before(async () => {
    console.log("=== Starting test setup ===");

    // Set up the AMM program; this helper creates mints, vaults,
    // poolState, and admin/user token accounts.
    const setup = await setupAmmProgram(
      provider,
      ammProgram,
      marginProgram,
      chainlinkProgram,
      chainlinkFeed,
      admin,
      user1,
      user2
    );

    console.log("Setup complete, retrieving configuration values...");

    // Retrieve configuration values from the setup helper.
    poolState = setup.poolState;
    solMint = setup.solMint;
    usdcMint = setup.usdcMint;
    lpTokenMint = setup.lpTokenMint;
    solVault = setup.solVault;
    usdcVault = setup.usdcVault;
    adminSolAccount = setup.adminSolAccount;
    adminUsdcAccount = setup.adminUsdcAccount;
    user1UsdcAccount = setup.user1UsdcAccount;
    user2UsdcAccount = setup.user2UsdcAccount;
    marginVault = setup.marginVault;
    marginSolVault = setup.marginSolVault;
    marginUsdcVault = setup.marginUsdcVault;

    console.log("Margin vault:", marginVault.toString());

    // Create LP token accounts for users
    user1LpTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        lpTokenMint,
        user1.publicKey
      )
    ).address;

    user2LpTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        lpTokenMint,
        user2.publicKey
      )
    ).address;

    // Derive user states
    [user1State] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_state"), user1.publicKey.toBuffer()],
      marginProgram.programId
    );

    [user2State] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_state"), user2.publicKey.toBuffer()],
      marginProgram.programId
    );

    // Derive user margin accounts
    [user1MarginAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("margin_account"), user1.publicKey.toBuffer()],
      marginProgram.programId
    );

    [user2MarginAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("margin_account"), user2.publicKey.toBuffer()],
      marginProgram.programId
    );

    configInitialized = true;

    // Get user token accounts

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

    console.log("User token accounts created");

    configInitialized = true;
  });
  // Ensure configuration is initialized before each test.
  beforeEach(async () => {
    if (!configInitialized) {
      throw new Error("Configuration not initialized");
    }
  });

  describe("deposit_margin", () => {
    it("should initialize and deposit WSOL to a new margin account", async () => {
      // Wrap SOL first to get WSOL tokens
      await wrapSol(
        user1.publicKey,
        user1SolAccount,
        solDepositAmount.toNumber(),
        provider,
        user1
      );

      // Get initial balances after wrapping SOL
      const marginSolVaultBefore = await getAccount(
        provider.connection,
        marginSolVault
      );
      const user1WsolBefore = await getAccount(
        provider.connection,
        user1SolAccount
      );

      // Deposit WSOL
      await marginProgram.methods
        .depositMargin(solDepositAmount)
        .accountsStrict({
          marginAccount: user1MarginAccount,
          marginVault: marginVault,
          vaultTokenAccount: marginSolVault,
          userTokenAccount: user1SolAccount,
          owner: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();

      // Get balances after deposit
      const marginSolVaultAfter = await getAccount(
        provider.connection,
        marginSolVault
      );
      const user1WsolAfter = await getAccount(
        provider.connection,
        user1SolAccount
      );
      const marginAccountAfter =
        await marginProgram.account.marginAccount.fetch(user1MarginAccount);

      // Verify state changes
      assert.equal(
        new BN(marginSolVaultAfter.amount.toString())
          .sub(new BN(marginSolVaultBefore.amount.toString()))
          .toString(),
        solDepositAmount.toString(),
        "WSOL vault balance should increase by deposit amount"
      );

      assert.equal(
        new BN(user1WsolBefore.amount.toString())
          .sub(new BN(user1WsolAfter.amount.toString()))
          .toString(),
        solDepositAmount.toString(),
        "User WSOL balance should decrease by deposit amount"
      );

      assert.equal(
        marginAccountAfter.solBalance.toString(),
        solDepositAmount.toString(),
        "Margin account SOL balance should equal deposit amount"
      );
    });

    it("should initialize and deposit USDC to a new margin account", async () => {
      // Get initial balances
      const marginUsdcVaultBefore = await getAccount(
        provider.connection,
        marginUsdcVault
      );
      const user2UsdcBefore = await getAccount(
        provider.connection,
        user2UsdcAccount
      );

      console.log("User USDC bal before: ", user2UsdcBefore.amount);

      // Deposit USDC
      await marginProgram.methods
        .depositMargin(usdcDepositAmount)
        .accountsStrict({
          marginAccount: user2MarginAccount,
          marginVault: marginVault,
          vaultTokenAccount: marginUsdcVault,
          userTokenAccount: user2UsdcAccount,
          owner: user2.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user2])
        .rpc();

      // Get balances after deposit
      const marginUsdcVaultAfter = await getAccount(
        provider.connection,
        marginUsdcVault
      );
      const user2UsdcAfter = await getAccount(
        provider.connection,
        user2UsdcAccount
      );
      const marginAccountAfter =
        await marginProgram.account.marginAccount.fetch(user2MarginAccount);

      // Verify state changes
      assert.equal(
        new BN(marginUsdcVaultAfter.amount.toString())
          .sub(new BN(marginUsdcVaultBefore.amount.toString()))
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
      const marginSolVaultBefore = await getAccount(
        provider.connection,
        marginSolVault
      );

      // Deposit more SOL
      const additionalSolDeposit = new BN(LAMPORTS_PER_SOL / 2); // 0.5 SOL

      await wrapSol(
        user1.publicKey,
        user1SolAccount,
        additionalSolDeposit.toNumber(),
        provider,
        user1
      );

      const user1SolBefore = await getAccount(
        provider.connection,
        user1SolAccount
      );

      const marginAccountBefore =
        await marginProgram.account.marginAccount.fetch(user1MarginAccount);

      await marginProgram.methods
        .depositMargin(additionalSolDeposit)
        .accountsStrict({
          marginAccount: user1MarginAccount,
          marginVault: marginVault,
          vaultTokenAccount: marginSolVault,
          userTokenAccount: user1SolAccount,
          owner: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();

      // Get balances after deposit
      const marginSolVaultAfter = await getAccount(
        provider.connection,
        marginSolVault
      );
      const user1SolAfter = await getAccount(
        provider.connection,
        user1SolAccount
      );
      const marginAccountAfter =
        await marginProgram.account.marginAccount.fetch(user1MarginAccount);

      // Verify state changes
      assert.equal(
        new BN(marginSolVaultAfter.amount.toString())
          .sub(new BN(marginSolVaultBefore.amount.toString()))
          .toString(),
        additionalSolDeposit.toString(),
        "SOL vault balance should increase by additional deposit amount"
      );

      assert.equal(
        new BN(user1SolBefore.amount.toString())
          .sub(new BN(user1SolAfter.amount.toString()))
          .toString(),
        additionalSolDeposit.toString(),
        "User WSOL token balance should decrease by additional deposit amount"
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
      const marginUsdcVaultBefore = await getAccount(
        provider.connection,
        marginUsdcVault
      );
      const user2UsdcBefore = await getAccount(
        provider.connection,
        user2UsdcAccount
      );
      const marginAccountBefore =
        await marginProgram.account.marginAccount.fetch(user2MarginAccount);

      // Deposit more USDC
      const additionalUsdcDeposit = new BN(5_000_000); // 5 USDC

      await marginProgram.methods
        .depositMargin(additionalUsdcDeposit)
        .accountsStrict({
          marginAccount: user2MarginAccount,
          marginVault: marginVault,
          vaultTokenAccount: marginUsdcVault,
          userTokenAccount: user2UsdcAccount,
          owner: user2.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user2])
        .rpc();

      // Get balances after deposit
      const marginUsdcVaultAfter = await getAccount(
        provider.connection,
        marginUsdcVault
      );
      const user2UsdcAfter = await getAccount(
        provider.connection,
        user2UsdcAccount
      );
      const marginAccountAfter =
        await marginProgram.account.marginAccount.fetch(user2MarginAccount);

      // Verify state changes
      assert.equal(
        new BN(marginUsdcVaultAfter.amount.toString())
          .sub(new BN(marginUsdcVaultBefore.amount.toString()))
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
        await marginProgram.methods
          .depositMargin(new BN(0))
          .accountsStrict({
            marginAccount: user1MarginAccount,
            marginVault: marginVault,
            vaultTokenAccount: marginSolVault,
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
        await marginProgram.methods
          .depositMargin(new BN(1_000_000))
          .accountsStrict({
            marginAccount: user2MarginAccount,
            marginVault: marginVault,
            vaultTokenAccount: marginUsdcVault,
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

      await wrapSol(
        user1.publicKey,
        user1SolAccount,
        excessAmount.toNumber(),
        provider,
        user1
      );

      try {
        await marginProgram.methods
          .depositMargin(excessAmount)
          .accountsStrict({
            marginAccount: user1MarginAccount,
            marginVault: marginVault,
            vaultTokenAccount: marginSolVault,
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
