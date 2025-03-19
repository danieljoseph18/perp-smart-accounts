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
  createAssociatedTokenAccount,
  getOrCreateAssociatedTokenAccount,
  Account,
} from "@solana/spl-token";
import { assert } from "chai";
import BN from "bn.js";
import * as dotenv from "dotenv";
import { PerpMarginAccounts } from "../target/types/perp_margin_accounts";
import { initializeMarginProgram } from "./helpers/init-margin-program";
dotenv.config();

describe("perp-amm (initialization in progress)", () => {
  // Configure the client to use the local cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PerpAmm as Program<PerpAmm>;

  // Required for initialization
  const marginProgram = anchor.workspace
    .PerpMarginAccounts as Program<PerpMarginAccounts>;

  // Constants for standard Chainlink integration
  // For testing, we'll mock these in each test

  // Set up common accounts
  // Use a fixed keypair for admin
  const admin = Keypair.fromSeed(Uint8Array.from(Array(32).fill(1)));
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();

  let _: number;

  // Set up token mints and vaults
  let usdcMint: PublicKey;
  let solVault: Account;
  let usdcVault: Account;
  let lpTokenMint: PublicKey;
  let solMint: PublicKey;

  // Set up pool state
  let poolState: PublicKey;
  let poolStateBump: number;

  let lpTokenMintKeypair: Keypair;

  // Set up token accounts
  let adminUsdcAccount: PublicKey;
  let adminSolAccount: PublicKey;
  let user1UsdcAccount: PublicKey;
  let user2UsdcAccount: PublicKey;

  let mockChainlinkProgram: PublicKey;
  let mockChainlinkFeed: PublicKey;

  beforeEach(async () => {
    console.log("Airdropping SOL to admin and users...");

    // Airdrop SOL to admin and users with confirmations
    const adminAirdropTx = await provider.connection.requestAirdrop(
      admin.publicKey,
      100 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(adminAirdropTx);

    const user1AirdropTx = await provider.connection.requestAirdrop(
      user1.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(user1AirdropTx);

    const user2AirdropTx = await provider.connection.requestAirdrop(
      user2.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(user2AirdropTx);

    console.log("Airdrops complete. Creating usdc mint...");

    // Create a mock Chainlink program and feed accounts if they don't exist
    mockChainlinkProgram = new PublicKey(
      "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny"
    );
    mockChainlinkFeed = new PublicKey(
      "99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR"
    ); // Devnet feed

    // Fund the keypairs so they exist on chain
    const mockChainlinkTx = await provider.connection.requestAirdrop(
      mockChainlinkProgram,
      LAMPORTS_PER_SOL / 100
    );
    await provider.connection.confirmTransaction(mockChainlinkTx);

    const mockFeedTx = await provider.connection.requestAirdrop(
      mockChainlinkFeed,
      LAMPORTS_PER_SOL / 100
    );
    await provider.connection.confirmTransaction(mockFeedTx);

    // Create USDC mint
    usdcMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    console.log("Usdc mint created. Creating token accounts...");

    // Create token accounts for all users
    adminUsdcAccount = await createAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      admin.publicKey
    );

    user1UsdcAccount = await createAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      user1.publicKey
    );

    user2UsdcAccount = await createAssociatedTokenAccount(
      provider.connection,
      admin,
      usdcMint,
      user2.publicKey
    );

    console.log("Token accounts created. Minting initial USDC...");

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

    console.log("Creating mock SOL mint...");

    // Use wrapped SOL instead of mock SOL
    solMint = new PublicKey("So11111111111111111111111111111111111111112");

    console.log("Creating token accounts for admin's wrapped SOL...");

    // Create token accounts for admin's wrapped SOL
    const adminSolAccountInfo = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      solMint,
      admin.publicKey
    );
    adminSolAccount = adminSolAccountInfo.address;

    console.log("Wrapping SOL for admin...");

    // Wrap native SOL to get wrapped SOL tokens
    const wrapAmount = 50 * LAMPORTS_PER_SOL; // 50 SOL (we airdropped 100 SOL)
    const wrapIx = SystemProgram.transfer({
      fromPubkey: admin.publicKey,
      toPubkey: adminSolAccount,
      lamports: wrapAmount,
    });

    const wrapTx = new anchor.web3.Transaction().add(wrapIx);
    await provider.sendAndConfirm(wrapTx, [admin]);

    console.log("Deriving PDA for pool state...");

    // Derive PDA for pool state
    [poolState, poolStateBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_state")],
      program.programId
    );

    // Derive margin vault PDA first
    const [marginVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("margin_vault")],
      marginProgram.programId
    );

    console.log("Creating vault accounts...");

    try {
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
    } catch (error: any) {
      throw error;
    }

    console.log("Initializing margin program...");

    // Initialize margin program
    await initializeMarginProgram(
      provider,
      marginProgram,
      solVault.address,
      usdcVault.address,
      mockChainlinkProgram,
      mockChainlinkFeed
    );

    console.log("Initializing Perp AMM program...");

    // Check if pool state already exists
    const poolStateInfo = await provider.connection.getAccountInfo(poolState);

    if (poolStateInfo) {
      console.log(
        "✓ Perp AMM program already initialized, skipping initialization"
      );
      // We still need to get the LP token mint for later use
      const poolStateAccount = await program.account.poolState.fetch(poolState);
      console.log(
        "Stored admin in PoolState:",
        poolStateAccount.admin.toString()
      );
      console.log("Current admin keypair:", admin.publicKey.toString());
      lpTokenMint = poolStateAccount.lpTokenMint;
      return {
        poolState,
        solVault: solVault.address,
        usdcVault: usdcVault.address,
        lpTokenMint,
      };
    }

    try {
      // Create a keypair for the LP token mint
      lpTokenMintKeypair = Keypair.generate();
      lpTokenMint = lpTokenMintKeypair.publicKey;

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
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([admin, lpTokenMintKeypair])
        .rpc();

      console.log("✓ Perp AMM program initialized successfully!");
      return {
        poolState,
        solVault: solVault.address,
        usdcVault: usdcVault.address,
        lpTokenMint,
      };
    } catch (error) {
      console.error("Failed to initialize Perp AMM:", error);
      throw error;
    }
  });

  describe("admin_deposit", () => {
    it("should allow admin to deposit tokens to the SOL vault", async () => {
      // Get balances before admin deposit
      const solVaultBefore = await getAccount(
        provider.connection,
        solVault.address
      );
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const adminSolBefore = await getAccount(
        provider.connection,
        adminSolAccount
      );

      // FIXME: First need to wrap SOL into WSOL in the admin account

      console.log("Admin Sol balance before deposit:", adminSolBefore.amount);

      // Admin deposit to SOL vault
      const depositAmount = new BN(1_000_000_000); // 1 SOL
      await program.methods
        .adminDeposit(depositAmount)
        .accountsStrict({
          admin: admin.publicKey,
          poolState,
          adminTokenAccount: adminSolAccount,
          vaultAccount: solVault.address,
          chainlinkProgram: mockChainlinkProgram,
          chainlinkFeed: mockChainlinkFeed,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();

      // Get balances after admin deposit
      const solVaultAfter = await getAccount(
        provider.connection,
        solVault.address
      );
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const adminSolAfter = await getAccount(
        provider.connection,
        adminSolAccount
      );

      // Verify state changes
      assert.equal(
        new BN(solVaultAfter.amount.toString())
          .sub(new BN(solVaultBefore.amount.toString()))
          .toString(),
        depositAmount.toString(),
        "SOL vault balance should increase by deposit amount"
      );

      assert.equal(
        new BN(adminSolBefore.amount.toString())
          .sub(new BN(adminSolAfter.amount.toString()))
          .toString(),
        depositAmount.toString(),
        "Admin SOL balance should decrease by deposit amount"
      );

      assert.equal(
        poolStateAfter.solDeposited.toString(),
        poolStateBefore.solDeposited.add(depositAmount).toString(),
        "Pool SOL deposited should increase by deposit amount"
      );
    });

    it("should allow admin to deposit USDC", async () => {
      // Get balances before admin deposit
      const usdcVaultBefore = await getAccount(
        provider.connection,
        usdcVault.address
      );
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const adminUsdcBefore = await getAccount(
        provider.connection,
        adminUsdcAccount
      );

      console.log(
        "Pool state USDC account: ",
        poolStateBefore.usdcVault.toString()
      );
      console.log("Passed in USDC vault: ", usdcVault.address.toString());

      const depositAmount = new BN(100_000_000); // 100 USDC

      // Admin deposit USDC
      await program.methods
        .adminDeposit(depositAmount)
        .accountsStrict({
          admin: admin.publicKey,
          poolState,
          adminTokenAccount: adminUsdcAccount,
          vaultAccount: usdcVault.address,
          chainlinkProgram: mockChainlinkProgram,
          chainlinkFeed: mockChainlinkFeed,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();

      // Get balances after admin deposit
      const usdcVaultAfter = await getAccount(
        provider.connection,
        usdcVault.address
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
        poolStateBefore.usdcDeposited.add(depositAmount).toString(),
        "Pool USDC deposited should increase by deposit amount"
      );
    });

    it("should fail if non-admin tries to deposit", async () => {
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
            vaultAccount: solVault.address,
            chainlinkProgram: mockChainlinkProgram,
            chainlinkFeed: mockChainlinkFeed,
            tokenProgram: TOKEN_PROGRAM_ID,
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
