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
  createMint,
} from "@solana/spl-token";
import { assert } from "chai";
import BN from "bn.js";
import * as dotenv from "dotenv";
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

  // Test parameters
  const withdrawalTimelock = 5 * 60; // 5 minutes in seconds

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

  // Ensure configuration is initialized before each test
  beforeEach(async () => {
    if (!configInitialized) {
      throw new Error("Configuration not initialized");
    }
  });

  // Helper function to ensure minimum balance
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

  describe("initialize", () => {
    it("should initialize a margin vault with Chainlink addresses", async () => {
      // Fetch the margin vault account to verify it was initialized correctly
      const marginVaultAccount = await marginProgram.account.marginVault.fetch(
        marginVault
      );

      // Verify the vault's fields were set correctly
      assert.equal(
        marginVaultAccount.marginSolVault.toString(),
        marginSolVault.toString(),
        "SOL vault should match the provided address"
      );
      assert.equal(
        marginVaultAccount.marginUsdcVault.toString(),
        marginUsdcVault.toString(),
        "USDC vault should match the provided address"
      );
      assert.equal(
        marginVaultAccount.authority.toString(),
        admin.publicKey.toString(),
        "Authority should match the admin's public key"
      );
      assert.equal(
        marginVaultAccount.withdrawalTimelock.toString(),
        withdrawalTimelock.toString(),
        "Withdrawal timelock should match the provided value"
      );
      assert.equal(
        marginVaultAccount.solFeesAccumulated.toString(),
        "0",
        "SOL fees accumulated should be initialized to zero"
      );
      assert.equal(
        marginVaultAccount.usdcFeesAccumulated.toString(),
        "0",
        "USDC fees accumulated should be initialized to zero"
      );

      // Verify Chainlink addresses
      assert.equal(
        marginVaultAccount.chainlinkProgram.toString(),
        chainlinkProgram.toString(),
        "Chainlink program should match the provided address"
      );
      assert.equal(
        marginVaultAccount.chainlinkFeed.toString(),
        chainlinkFeed.toString(),
        "Chainlink feed should match the provided address"
      );
    });

    it("should fail to reinitialize an existing margin vault", async () => {
      try {
        // Attempt to initialize the margin vault again
        await marginProgram.methods
          .initialize(
            new BN(withdrawalTimelock),
            chainlinkProgram,
            chainlinkFeed
          )
          .accountsStrict({
            authority: admin.publicKey,
            marginVault: marginVault,
            marginSolVault: marginSolVault,
            marginUsdcVault: marginUsdcVault,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([admin])
          .rpc();

        assert.fail("Expected transaction to fail when reinitializing vault");
      } catch (error) {
        // We expect an error about the account being already initialized
        assert.include(
          error.message,
          "Error",
          "Expected error message about already initialized account"
        );
      }
    });

    it("should initialize a user margin account", async () => {
      // Airdrop some SOL to user1
      await ensureMinimumBalance(user1.publicKey, LAMPORTS_PER_SOL);

      // Derive the margin account PDA for user1
      const [user1MarginAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("margin_account"), user1.publicKey.toBuffer()],
        marginProgram.programId
      );

      const amountToDeposit = new BN(1000);

      await wrapSol(
        user1.publicKey,
        user1SolAccount,
        amountToDeposit.toNumber(),
        provider,
        user1
      );

      // Initialize margin account for user1 with zero deposit
      await marginProgram.methods
        .depositMargin(amountToDeposit)
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

      // Fetch the margin account to verify it was initialized correctly
      const marginAccount = await marginProgram.account.marginAccount.fetch(
        user1MarginAccount
      );

      // Verify the margin account's fields were set correctly
      assert.equal(
        marginAccount.owner.toString(),
        user1.publicKey.toString(),
        "Margin account owner should be user1"
      );
      assert.equal(
        marginAccount.solBalance.toString(),
        amountToDeposit.toString(),
        "SOL balance should be initialized to the amount deposited"
      );
      assert.equal(
        marginAccount.usdcBalance.toString(),
        "0",
        "USDC balance should be initialized to zero"
      );
      assert.equal(
        marginAccount.pendingSolWithdrawal.toString(),
        "0",
        "Pending SOL withdrawal should be initialized to zero"
      );
      assert.equal(
        marginAccount.pendingUsdcWithdrawal.toString(),
        "0",
        "Pending USDC withdrawal should be initialized to zero"
      );
      assert.equal(
        marginAccount.lastWithdrawalRequest.toString(),
        "0",
        "Last withdrawal request should be initialized to zero"
      );
    });

    it("should fail to initialize a user margin account with incorrect owner", async () => {
      // Derive the margin account PDA for user2
      const [user2MarginAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("margin_account"), user2.publicKey.toBuffer()],
        marginProgram.programId
      );

      const amountToDeposit = new BN(1000);

      await wrapSol(
        user2.publicKey,
        user2SolAccount,
        amountToDeposit.toNumber(),
        provider,
        user2
      );

      try {
        // Use user2 as signer but pass user1 as owner
        await marginProgram.methods
          .depositMargin(amountToDeposit)
          .accountsStrict({
            marginAccount: user2MarginAccount,
            marginVault: marginVault,
            vaultTokenAccount: marginSolVault,
            userTokenAccount: user2SolAccount,
            owner: user1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user2])
          .rpc();

        assert.fail("Expected transaction to fail with incorrect owner");
      } catch (error) {
        assert.include(
          error.message,
          "unknown signer",
          "Expected error message about missing required signer"
        );
      }
    });

    it("should fail to initialize with invalid token accounts", async () => {
      // Create a new margin vault PDA for this test with a different seed
      const [newMarginVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("margin_vault_test")],
        marginProgram.programId
      );

      // Create token accounts owned by the wallet instead of the PDA
      const invalidSolVault = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        solMint,
        admin.publicKey
      );

      try {
        // Attempt to initialize with invalid token accounts
        await marginProgram.methods
          .initialize(
            new BN(withdrawalTimelock),
            chainlinkProgram,
            chainlinkFeed
          )
          .accountsStrict({
            authority: admin.publicKey,
            marginVault: newMarginVault,
            marginSolVault: marginSolVault,
            marginUsdcVault: marginUsdcVault,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([admin])
          .rpc();

        assert.fail("Expected transaction to fail with constraint error");
      } catch (error) {
        assert.include(
          error.message,
          "Error",
          "Expected error message about invalid token accounts"
        );
      }
    });
  });
});
