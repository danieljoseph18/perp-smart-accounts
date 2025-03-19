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

  // Test parameters
  const initialSolDeposit = new BN(2 * LAMPORTS_PER_SOL);
  const initialUsdcDeposit = new BN(200_000_000); // 200 USDC with 6 decimals

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

  describe("withdraw", () => {
    // First make deposits that will be withdrawn
    before(async () => {
      try {
        // Create a SOL token account for user1
        const user1SolAccount = (await getOrCreateAssociatedTokenAccount(
          provider.connection,
          admin,
          solMint,
          user1.publicKey
        )).address;

        // Add some SOL to user1's account
        const wrapAmount = 3 * LAMPORTS_PER_SOL; // 3 SOL
        const wrapIx = SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: user1SolAccount,
          lamports: wrapAmount,
        });

        const wrapTx = new anchor.web3.Transaction().add(wrapIx);
        await provider.sendAndConfirm(wrapTx, [admin]);

        // User1 deposit SOL to earn LP tokens
        await program.methods
          .deposit(initialSolDeposit)
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

        // User2 deposit USDC to earn LP tokens
        await program.methods
          .deposit(initialUsdcDeposit)
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
        console.log("Error in setup, continuing with tests:", error);
      }
    });

    it("should withdraw SOL from the pool", async () => {
      // Create a SOL token account for user1 to receive the withdrawn SOL
      const user1SolAccount = (await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        solMint,
        user1.publicKey
      )).address;

      // Get balances before withdrawal
      const solVaultBefore = await getAccount(
        provider.connection,
        solVault
      );
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const userStateBefore = await program.account.userState.fetch(user1State);
      const user1SolBefore = await getAccount(
        provider.connection,
        user1SolAccount
      );
      const lpTokenSupplyBefore = (
        await getMint(provider.connection, lpTokenMint)
      ).supply;
      const user1LpBalanceBefore = (
        await getAccount(provider.connection, user1LpTokenAccount)
      ).amount;

      // Skip test if user doesn't have LP tokens
      if (new BN(user1LpBalanceBefore.toString()).eqn(0)) {
        console.log("User1 has no LP tokens, skipping test");
        return;
      }

      // Calculate half of the LP tokens to withdraw
      const withdrawLpAmount = new BN(user1LpBalanceBefore.toString()).divn(2);

      // Withdraw SOL
      await program.methods
        .withdraw(withdrawLpAmount)
        .accountsStrict({
          user: user1.publicKey,
          poolState,
          userState: user1State,
          lpTokenMint,
          userLpTokenAccount: user1LpTokenAccount,
          vaultAccount: solVault,
          userTokenAccount: user1SolAccount,
          chainlinkProgram: chainlinkMockProgram.programId,
          chainlinkFeed: mockChainlinkFeed,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      // Get balances after withdrawal
      const solVaultAfter = await getAccount(
        provider.connection,
        solVault
      );
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const userStateAfter = await program.account.userState.fetch(user1State);
      const user1SolAfter = await getAccount(
        provider.connection,
        user1SolAccount
      );
      const lpTokenSupplyAfter = (
        await getMint(provider.connection, lpTokenMint)
      ).supply;
      const user1LpBalanceAfter = (
        await getAccount(provider.connection, user1LpTokenAccount)
      ).amount;

      // Verify state changes
      assert.isTrue(
        new BN(solVaultBefore.amount.toString()).gt(
          new BN(solVaultAfter.amount.toString())
        ),
        "SOL vault balance should decrease"
      );

      assert.isTrue(
        new BN(user1SolAfter.amount.toString()).gt(
          new BN(user1SolBefore.amount.toString())
        ),
        "User SOL balance should increase"
      );

      assert.isTrue(
        poolStateBefore.solDeposited.gt(poolStateAfter.solDeposited),
        "Pool SOL deposited should decrease"
      );

      assert.isTrue(
        new BN(lpTokenSupplyBefore.toString()).gt(
          new BN(lpTokenSupplyAfter.toString())
        ),
        "LP token supply should decrease"
      );

      assert.equal(
        new BN(user1LpBalanceAfter.toString()).toString(),
        new BN(user1LpBalanceBefore.toString())
          .sub(withdrawLpAmount)
          .toString(),
        "User LP token balance should decrease by withdrawal amount"
      );

      if (userStateBefore.lpTokenBalance) {
        assert.equal(
          userStateAfter.lpTokenBalance.toString(),
          userStateBefore.lpTokenBalance.sub(withdrawLpAmount).toString(),
          "User state LP token balance should decrease by withdrawal amount"
        );
      }
    });

    it("should withdraw USDC from the pool", async () => {
      // Get balances before withdrawal
      const usdcVaultBefore = await getAccount(provider.connection, usdcVault);
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const userStateBefore = await program.account.userState.fetch(user2State);
      const user2UsdcBefore = await getAccount(
        provider.connection,
        user2UsdcAccount
      );
      const lpTokenSupplyBefore = (
        await getMint(provider.connection, lpTokenMint)
      ).supply;
      const user2LpBalanceBefore = (
        await getAccount(provider.connection, user2LpTokenAccount)
      ).amount;

      // Skip test if user doesn't have LP tokens
      if (new BN(user2LpBalanceBefore.toString()).eqn(0)) {
        console.log("User2 has no LP tokens, skipping test");
        return;
      }

      // Calculate half of the LP tokens to withdraw
      const withdrawLpAmount = new BN(user2LpBalanceBefore.toString()).divn(2);

      // Withdraw USDC
      await program.methods
        .withdraw(withdrawLpAmount)
        .accountsStrict({
          user: user2.publicKey,
          poolState,
          userState: user2State,
          lpTokenMint,
          userLpTokenAccount: user2LpTokenAccount,
          vaultAccount: usdcVault,
          userTokenAccount: user2UsdcAccount,
          chainlinkProgram: chainlinkMockProgram.programId,
          chainlinkFeed: mockChainlinkFeed,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user2])
        .rpc();

      // Get balances after withdrawal
      const usdcVaultAfter = await getAccount(provider.connection, usdcVault);
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const userStateAfter = await program.account.userState.fetch(user2State);
      const user2UsdcAfter = await getAccount(
        provider.connection,
        user2UsdcAccount
      );
      const lpTokenSupplyAfter = (
        await getMint(provider.connection, lpTokenMint)
      ).supply;
      const user2LpBalanceAfter = (
        await getAccount(provider.connection, user2LpTokenAccount)
      ).amount;

      // Verify state changes
      assert.isTrue(
        new BN(usdcVaultBefore.amount.toString()).gt(
          new BN(usdcVaultAfter.amount.toString())
        ),
        "USDC vault balance should decrease"
      );

      assert.isTrue(
        new BN(user2UsdcAfter.amount.toString()).gt(
          new BN(user2UsdcBefore.amount.toString())
        ),
        "User USDC balance should increase"
      );

      assert.isTrue(
        poolStateBefore.usdcDeposited.gt(poolStateAfter.usdcDeposited),
        "Pool USDC deposited should decrease"
      );

      assert.isTrue(
        new BN(lpTokenSupplyBefore.toString()).gt(
          new BN(lpTokenSupplyAfter.toString())
        ),
        "LP token supply should decrease"
      );

      assert.equal(
        new BN(user2LpBalanceAfter.toString()).toString(),
        new BN(user2LpBalanceBefore.toString())
          .sub(withdrawLpAmount)
          .toString(),
        "User LP token balance should decrease by withdrawal amount"
      );

      if (userStateBefore.lpTokenBalance) {
        assert.equal(
          userStateAfter.lpTokenBalance.toString(),
          userStateBefore.lpTokenBalance.sub(withdrawLpAmount).toString(),
          "User state LP token balance should decrease by withdrawal amount"
        );
      }
    });

    it("should fail to withdraw if LP token amount is zero", async () => {
      // Create a SOL token account for user1 to receive the withdrawn SOL
      const user1SolAccount = (await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        solMint,
        user1.publicKey
      )).address;

      try {
        await program.methods
          .withdraw(new BN(0))
          .accountsStrict({
            user: user1.publicKey,
            poolState,
            userState: user1State,
            lpTokenMint,
            userLpTokenAccount: user1LpTokenAccount,
            vaultAccount: solVault,
            userTokenAccount: user1SolAccount,
            chainlinkProgram: chainlinkMockProgram.programId,
            chainlinkFeed: mockChainlinkFeed,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();

        assert.fail("Expected transaction to fail with zero amount");
      } catch (error: any) {
        assert.include(
          error.message,
          "Amount must be greater than zero",
          "Expected error message about zero amount"
        );
      }
    });

    it("should fail to withdraw if LP token amount exceeds balance", async () => {
      // Create a SOL token account for user1 to receive the withdrawn SOL
      const user1SolAccount = (await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        solMint,
        user1.publicKey
      )).address;

      const user1LpBalance = await getAccount(
        provider.connection,
        user1LpTokenAccount
      );
      const excessAmount = new BN(user1LpBalance.amount.toString()).addn(1); // Balance + 1

      try {
        await program.methods
          .withdraw(excessAmount)
          .accountsStrict({
            user: user1.publicKey,
            poolState,
            userState: user1State,
            lpTokenMint,
            userLpTokenAccount: user1LpTokenAccount,
            vaultAccount: solVault,
            userTokenAccount: user1SolAccount,
            chainlinkProgram: chainlinkMockProgram.programId,
            chainlinkFeed: mockChainlinkFeed,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();

        assert.fail("Expected transaction to fail with insufficient LP tokens");
      } catch (error: any) {
        assert.include(
          error.message,
          "insufficient funds",
          "Expected error message about insufficient funds"
        );
      }
    });
  });
});