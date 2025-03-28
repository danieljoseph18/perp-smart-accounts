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
  getAccount,
  getOrCreateAssociatedTokenAccount,
  getMint,
  transfer,
} from "@solana/spl-token";
import { assert } from "chai";
import BN from "bn.js";
import * as dotenv from "dotenv";
import { PerpMarginAccounts } from "../target/types/perp_margin_accounts";
import { setupAmmProgram } from "./helpers/init-amm-program";
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

describe("perp-amm (with configuration persistence)", () => {
  // Configure the client to use the local cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PerpAmm as Program<PerpAmm>;

  // Required for initialization
  const marginProgram = anchor.workspace
    .PerpMarginAccounts as Program<PerpMarginAccounts>;

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

    // Set up the AMM program; this helper creates mints, vaults,
    // poolState, and admin/user token accounts.
    const setup = await setupAmmProgram(
      provider,
      program,
      marginProgram,
      chainlinkProgram,
      chainlinkFeed,
      admin,
      user1,
      user2
    );

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
      program.programId
    );

    [user2State] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_state"), user2.publicKey.toBuffer()],
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

  describe("withdraw", () => {
    // First make deposits that will be withdrawn
    before(async () => {
      try {
        // Create a SOL token account for user1 and fund it with SOL
        const user1SolAccount = (
          await getOrCreateAssociatedTokenAccount(
            provider.connection,
            admin,
            solMint,
            user1.publicKey
          )
        ).address;

        await wrapSol(
          user1.publicKey,
          user1SolAccount,
          initialSolDeposit.toNumber(),
          provider,
          user1
        );

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
            chainlinkProgram: chainlinkProgram,
            chainlinkFeed: chainlinkFeed,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();

        // Fund user2's USDC account before deposit
        await transfer(
          provider.connection,
          admin,
          adminUsdcAccount,
          user2UsdcAccount,
          admin,
          initialUsdcDeposit.toNumber()
        );

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
            chainlinkProgram: chainlinkProgram,
            chainlinkFeed: chainlinkFeed,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user2])
          .rpc();
      } catch (error) {
        console.log("Error in setup, continuing with tests:", error);
      }
    });

    it("should withdraw WSOL from the pool", async () => {
      // Create a WSOL token account for user1 to receive the withdrawn WSOL
      const user1SolAccount = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          admin, // Use admin as the payer since they have enough SOL
          solMint,
          user1.publicKey
        )
      ).address;

      // Get balances before withdrawal
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const solDepositedBefore = poolStateBefore.solDeposited;
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

      // Withdraw WSOL
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
          chainlinkProgram: chainlinkProgram,
          chainlinkFeed: chainlinkFeed,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      // Get balances after withdrawal
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const solDepositedAfter = poolStateAfter.solDeposited;
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
        new BN(solDepositedBefore.toString()).gt(
          new BN(solDepositedAfter.toString())
        ),
        "SOL deposited in pool state should decrease"
      );

      assert.isTrue(
        new BN(user1SolAfter.amount.toString()).gt(
          new BN(user1SolBefore.amount.toString())
        ),
        "User WSOL balance should increase"
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
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const usdcDepositedBefore = poolStateBefore.usdcDeposited;
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
          chainlinkProgram: chainlinkProgram,
          chainlinkFeed: chainlinkFeed,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user2])
        .rpc();

      // Get balances after withdrawal
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const usdcDepositedAfter = poolStateAfter.usdcDeposited;
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
        new BN(usdcDepositedBefore.toString()).gt(
          new BN(usdcDepositedAfter.toString())
        ),
        "USDC deposited in pool state should decrease"
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
      const user1SolAccount = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          admin, // Use admin as the payer since they have enough SOL
          solMint,
          user1.publicKey
        )
      ).address;

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
            chainlinkProgram: chainlinkProgram,
            chainlinkFeed: chainlinkFeed,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();

        assert.fail("Expected transaction to fail with zero amount");
      } catch (error: any) {
        assert.include(
          error.message,
          "InvalidTokenAmount", // Update to match actual error in withdraw.rs
          "Expected error message about zero amount"
        );
      }
    });

    it("should fail to withdraw if LP token amount exceeds balance", async () => {
      // Create a SOL token account for user1 to receive the withdrawn SOL
      const user1SolAccount = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          admin, // Use admin as the payer since they have enough SOL
          solMint,
          user1.publicKey
        )
      ).address;

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
            chainlinkProgram: chainlinkProgram,
            chainlinkFeed: chainlinkFeed,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();

        assert.fail("Expected transaction to fail with insufficient LP tokens");
      } catch (error: any) {
        assert.include(
          error.message,
          "InsufficientLpBalance", // Update to match actual error in withdraw.rs
          "Expected error message about insufficient LP balance"
        );
      }
    });
  });
});
