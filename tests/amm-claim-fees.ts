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
import { setupAmmProgram } from "./helpers/init-amm-program";
import { ChainlinkMock } from "../target/types/chainlink_mock";
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
  const chainlinkMockProgram = anchor.workspace
    .ChainlinkMock as Program<ChainlinkMock>;

  // Use a fixed keypair for admin
  const admin = Keypair.fromSeed(Uint8Array.from(Array(32).fill(1)));
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();

  // Set up token mints and vaults
  let usdcMint: PublicKey;
  let solVault: PublicKey;
  let usdcVault: PublicKey;
  let lpTokenMint: PublicKey;
  let solMint: PublicKey;

  // Set up pool state
  let poolState: PublicKey;

  // Set up token accounts
  let adminUsdcAccount: PublicKey;
  let adminSolAccount: PublicKey;
  let user1UsdcAccount: PublicKey;
  let user2UsdcAccount: PublicKey;

  let mockChainlinkFeed: PublicKey;

  // User LP token accounts
  let user1LpTokenAccount: PublicKey;
  let user2LpTokenAccount: PublicKey;
  
  // User states
  let user1State: PublicKey;
  let user2State: PublicKey;

  // Global configuration state
  let configInitialized = false;

  before(async () => {
    console.log("=== Starting test setup ===");

    // Set up AMM program and get needed addresses
    const setup = await setupAmmProgram(
      provider,
      program,
      marginProgram,
      chainlinkMockProgram,
      admin,
      user1,
      user2
    );

    // Set all the configuration from the setup
    poolState = setup.poolState;
    solMint = setup.solMint;
    usdcMint = setup.usdcMint;
    lpTokenMint = setup.lpTokenMint;
    solVault = setup.solVault;
    usdcVault = setup.usdcVault;
    mockChainlinkFeed = setup.mockChainlinkFeed;
    adminSolAccount = setup.adminSolAccount;
    adminUsdcAccount = setup.adminUsdcAccount;
    user1UsdcAccount = setup.user1UsdcAccount;
    user2UsdcAccount = setup.user2UsdcAccount;

    // Create LP token accounts for users
    user1LpTokenAccount = (await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      lpTokenMint,
      user1.publicKey
    )).address;

    user2LpTokenAccount = (await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      lpTokenMint,
      user2.publicKey
    )).address;

    // Derive user states
    [user1State] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_state"), user1.publicKey.toBuffer()],
      program.programId
    );

    [user2State] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_state"), user2.publicKey.toBuffer()],
      program.programId
    );

    configInitialized = true;
  });

  // Use beforeEach to ensure all accounts are ready for each test
  beforeEach(async () => {
    // Ensure configuration is initialized before running tests
    if (!configInitialized) {
      throw new Error("Configuration not initialized");
    }
  });

  describe("claim_fees", () => {
    // Generate fees by making deposits
    before(async () => {
      // Deposit USDC from user2 to generate some fees
      try {
        await program.methods
          .deposit(new BN(100_000_000)) // 100 USDC
          .accountsStrict({
            user: user2.publicKey,
            poolState,
            userTokenAccount: user2UsdcAccount,
            vaultAccount: usdcVault,
            userState: user2State,
            lpTokenMint,
            userLpTokenAccount: user2LpTokenAccount,
            chainlinkProgram: chainlinkMockProgram.programId,
            chainlinkFeed: mockChainlinkFeed,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user2])
          .rpc();
      } catch (error) {
        console.log("Could not deposit to generate fees, continuing tests:", error);
      }
    });

    it("should allow admin to claim accumulated SOL fees", async () => {
      // Get balances before claiming fees
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const adminSolBefore = await getAccount(
        provider.connection,
        adminSolAccount
      );

      // Deposit SOL to generate some fees
      if (poolStateBefore.accumulatedSolFees.eqn(0)) {
        // Admin deposit SOL to vault
        const depositAmount = new BN(LAMPORTS_PER_SOL);
        await program.methods
          .adminDeposit(depositAmount)
          .accountsStrict({
            admin: admin.publicKey,
            poolState,
            adminTokenAccount: adminSolAccount,
            vaultAccount: solVault,
            chainlinkProgram: chainlinkMockProgram.programId,
            chainlinkFeed: mockChainlinkFeed,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin])
          .rpc();

        // User1 deposit SOL (which will generate fees)
        const user1SolAccount = (await getOrCreateAssociatedTokenAccount(
          provider.connection,
          admin,
          solMint,
          user1.publicKey
        )).address;

        // Add some SOL to user1's account
        const wrapAmount = 2 * LAMPORTS_PER_SOL; // 2 SOL
        const wrapIx = SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: user1SolAccount,
          lamports: wrapAmount,
        });

        const wrapTx = new anchor.web3.Transaction().add(wrapIx);
        await provider.sendAndConfirm(wrapTx, [admin]);

        // User deposit SOL
        await program.methods
          .deposit(new BN(LAMPORTS_PER_SOL))
          .accountsStrict({
            user: user1.publicKey,
            poolState,
            userTokenAccount: user1SolAccount,
            vaultAccount: solVault,
            userState: user1State,
            lpTokenMint,
            userLpTokenAccount: user1LpTokenAccount,
            chainlinkProgram: chainlinkMockProgram.programId,
            chainlinkFeed: mockChainlinkFeed,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();
      }

      // Get updated pool state
      const poolStateWithFees = await program.account.poolState.fetch(poolState);

      // Ensure there are some accumulated SOL fees
      assert.isTrue(
        poolStateWithFees.accumulatedSolFees.gtn(0),
        "There should be some accumulated SOL fees"
      );

      // Claim fees
      await program.methods
        .claimFees()
        .accountsStrict({
          admin: admin.publicKey,
          poolState,
          solVault,
          usdcVault,
          adminSolAccount,
          adminUsdcAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();

      // Get balances after claiming fees
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const adminSolAfter = await getAccount(
        provider.connection,
        adminSolAccount
      );

      // Verify state changes
      assert.isTrue(
        new BN(adminSolAfter.amount.toString()).gt(
          new BN(adminSolBefore.amount.toString())
        ),
        "Admin SOL balance should increase after claiming fees"
      );

      assert.equal(
        poolStateAfter.accumulatedSolFees.toString(),
        "0",
        "Accumulated SOL fees should be reset to zero"
      );
    });

    it("should allow admin to claim accumulated USDC fees", async () => {
      // Get balances before claiming fees
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const adminUsdcBefore = await getAccount(
        provider.connection,
        adminUsdcAccount
      );

      // If no USDC fees, generate some by making a deposit
      if (poolStateBefore.accumulatedUsdcFees.eqn(0)) {
        await program.methods
          .deposit(new BN(100_000_000)) // 100 USDC
          .accountsStrict({
            user: user2.publicKey,
            poolState,
            userTokenAccount: user2UsdcAccount,
            vaultAccount: usdcVault,
            userState: user2State,
            lpTokenMint,
            userLpTokenAccount: user2LpTokenAccount,
            chainlinkProgram: chainlinkMockProgram.programId,
            chainlinkFeed: mockChainlinkFeed,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user2])
          .rpc();
      }

      // Get updated pool state
      const poolStateWithFees = await program.account.poolState.fetch(poolState);

      // Ensure there are some accumulated USDC fees
      assert.isTrue(
        poolStateWithFees.accumulatedUsdcFees.gtn(0),
        "There should be some accumulated USDC fees"
      );

      // Claim fees
      await program.methods
        .claimFees()
        .accountsStrict({
          admin: admin.publicKey,
          poolState,
          solVault,
          usdcVault,
          adminSolAccount,
          adminUsdcAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();

      // Get balances after claiming fees
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const adminUsdcAfter = await getAccount(
        provider.connection,
        adminUsdcAccount
      );

      // Verify state changes
      assert.isTrue(
        new BN(adminUsdcAfter.amount.toString()).gt(
          new BN(adminUsdcBefore.amount.toString())
        ),
        "Admin USDC balance should increase after claiming fees"
      );

      assert.equal(
        poolStateAfter.accumulatedUsdcFees.toString(),
        "0",
        "Accumulated USDC fees should be reset to zero"
      );
    });

    it("should fail if non-admin tries to claim fees", async () => {
      try {
        // Get SOL account for user1
        const user1SolAccount = (await getOrCreateAssociatedTokenAccount(
          provider.connection,
          admin,
          solMint,
          user1.publicKey
        )).address;

        await program.methods
          .claimFees()
          .accountsStrict({
            admin: user1.publicKey,
            poolState,
            solVault,
            usdcVault,
            adminSolAccount: user1SolAccount,
            adminUsdcAccount: user1UsdcAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();

        assert.fail("Expected transaction to fail with unauthorized admin");
      } catch (error: any) {
        assert.include(
          error.message,
          "Unauthorized",
          "Expected error message about unauthorized admin"
        );
      }
    });
  });
});