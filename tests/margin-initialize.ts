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

  // Test parameters
  const withdrawalTimelock = 24 * 60 * 60; // 24 hours in seconds

  // Global configuration state
  let configInitialized = false;

  before(async () => {
    console.log("=== Starting test setup ===");

    // Ensure admin has enough SOL
    await ensureMinimumBalance(admin.publicKey, 10 * LAMPORTS_PER_SOL);

    // Use native SOL mint
    solMint = NATIVE_MINT;
    console.log("Using SOL mint:", solMint.toString());

    // Derive the margin vault PDA
    [marginVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("margin_vault")],
      program.programId
    );
    console.log("Margin vault PDA:", marginVault.toString());

    // Create token accounts for admin
    adminSolAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        solMint,
        admin.publicKey
      )
    ).address;

    // Create token account for user1
    user1SolAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        solMint,
        user1.publicKey
      )
    ).address;

    // Create token vaults for margin program
    const solVaultAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      solMint,
      marginVault,
      true
    );
    solVault = solVaultAccount.address;
    console.log("Created SOL vault:", solVault.toString());

    // Create USDC mint
    usdcMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );
    console.log("Created USDC mint:", usdcMint.toString());

    // Create USDC accounts after mint is created
    adminUsdcAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        usdcMint,
        admin.publicKey
      )
    ).address;

    const usdcVaultAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      marginVault,
      true
    );
    usdcVault = usdcVaultAccount.address;
    console.log("Created USDC vault:", usdcVault.toString());

    // Wrap some SOL for admin
    await wrapSol(
      admin.publicKey,
      adminSolAccount,
      5 * LAMPORTS_PER_SOL,
      provider,
      admin
    );

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
      // Initialize the margin vault with Chainlink addresses
      await program.methods
        .initialize(new BN(withdrawalTimelock), chainlinkProgram, chainlinkFeed)
        .accountsStrict({
          authority: admin.publicKey,
          marginVault: marginVault,
          solVault: solVault,
          usdcVault: usdcVault,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([admin])
        .rpc();

      // Fetch the margin vault account to verify it was initialized correctly
      const marginVaultAccount = await program.account.marginVault.fetch(
        marginVault
      );

      // Verify the vault's fields were set correctly
      assert.equal(
        marginVaultAccount.solVault.toString(),
        solVault.toString(),
        "SOL vault should match the provided address"
      );
      assert.equal(
        marginVaultAccount.usdcVault.toString(),
        usdcVault.toString(),
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
        await program.methods
          .initialize(
            new BN(withdrawalTimelock),
            chainlinkProgram,
            chainlinkFeed
          )
          .accountsStrict({
            authority: admin.publicKey,
            marginVault: marginVault,
            solVault: solVault,
            usdcVault: usdcVault,
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

    it("should update Chainlink addresses", async () => {
      // Create new mock Chainlink addresses
      const newChainlinkProgram = Keypair.generate().publicKey;
      const newChainlinkFeed = Keypair.generate().publicKey;

      console.log("New Chainlink program:", newChainlinkProgram.toString());
      console.log("New Chainlink feed:", newChainlinkFeed.toString());

      // Update the Chainlink addresses
      await program.methods
        .updateChainlinkAddresses(newChainlinkProgram, newChainlinkFeed)
        .accountsStrict({
          marginVault: marginVault,
          authority: admin.publicKey,
        })
        .signers([admin])
        .rpc();

      // Fetch the margin vault account to verify the addresses were updated
      const marginVaultAccount = await program.account.marginVault.fetch(
        marginVault
      );

      // Verify the new Chainlink addresses
      assert.equal(
        marginVaultAccount.chainlinkProgram.toString(),
        newChainlinkProgram.toString(),
        "Chainlink program should be updated to the new address"
      );
      assert.equal(
        marginVaultAccount.chainlinkFeed.toString(),
        newChainlinkFeed.toString(),
        "Chainlink feed should be updated to the new address"
      );
    });

    it("should fail to update Chainlink addresses with unauthorized authority", async () => {
      // Create an unauthorized user
      const unauthorizedUser = Keypair.generate();

      // Airdrop some SOL to the unauthorized user
      await ensureMinimumBalance(unauthorizedUser.publicKey, LAMPORTS_PER_SOL);

      try {
        // Create new mock Chainlink addresses
        const newChainlinkProgram = Keypair.generate().publicKey;
        const newChainlinkFeed = Keypair.generate().publicKey;

        // Attempt to update with unauthorized user
        await program.methods
          .updateChainlinkAddresses(newChainlinkProgram, newChainlinkFeed)
          .accountsStrict({
            marginVault: marginVault,
            authority: unauthorizedUser.publicKey,
          })
          .signers([unauthorizedUser])
          .rpc();

        assert.fail("Expected transaction to fail with unauthorized authority");
      } catch (error) {
        assert.include(
          error.message,
          "Error",
          "Expected error message about unauthorized authority"
        );
      }
    });

    it("should initialize a user margin account", async () => {
      // Airdrop some SOL to user1
      await ensureMinimumBalance(user1.publicKey, LAMPORTS_PER_SOL);

      // Derive the margin account PDA for user1
      const [user1MarginAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("margin_account"), user1.publicKey.toBuffer()],
        program.programId
      );

      // Initialize margin account for user1 with zero deposit
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

      // Fetch the margin account to verify it was initialized correctly
      const marginAccount = await program.account.marginAccount.fetch(
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
        "0",
        "SOL balance should be initialized to zero"
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
        program.programId
      );

      try {
        // Try to initialize user2's margin account with user1's signature
        await program.methods
          .depositMargin(new BN(0))
          .accountsStrict({
            marginAccount: user2MarginAccount,
            marginVault: marginVault,
            vaultTokenAccount: solVault,
            userTokenAccount: user1SolAccount,
            owner: user2.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1]) // user1 is not the owner
          .rpc();

        assert.fail("Expected transaction to fail with incorrect owner");
      } catch (error) {
        assert.include(
          error.message,
          "Error",
          "Expected error message about mismatched owner"
        );
      }
    });

    it("should fail to initialize with invalid token accounts", async () => {
      // Create a new margin vault PDA for this test with a different seed
      const [newMarginVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("margin_vault_test")],
        program.programId
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
        await program.methods
          .initialize(
            new BN(withdrawalTimelock),
            chainlinkProgram,
            chainlinkFeed
          )
          .accountsStrict({
            authority: admin.publicKey,
            marginVault: newMarginVault,
            solVault: invalidSolVault.address,
            usdcVault: usdcVault, // This is still valid
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
