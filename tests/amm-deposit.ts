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
} from "@solana/spl-token";
import { assert } from "chai";
import BN from "bn.js";
import * as dotenv from "dotenv";
import { PerpMarginAccounts } from "../target/types/perp_margin_accounts";
import { setupAmmProgram } from "./helpers/init-amm-program";

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

  describe("deposit", () => {
    it("should deposit SOL to the pool", async () => {
      // Create a SOL token account for user1
      const user1SolAccount = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          admin,
          solMint,
          user1.publicKey
        )
      ).address;

      // Add some SOL to user1's account
      const wrapAmount = 3 * LAMPORTS_PER_SOL; // 3 SOL
      const wrapIx = SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: user1SolAccount,
        lamports: wrapAmount,
      });

      const wrapTx = new anchor.web3.Transaction().add(wrapIx);
      await provider.sendAndConfirm(wrapTx, [admin]);

      // Get balance before deposit
      const solVaultBefore = await getAccount(provider.connection, solVault);
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const userStateBefore = await program.account.userState.fetch(user1State);
      const lpTokenSupplyBefore = (
        await getMint(provider.connection, lpTokenMint)
      ).supply;
      const user1SolBefore = await getAccount(
        provider.connection,
        user1SolAccount
      );

      // Deposit SOL
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

      // Get balance after deposit
      const solVaultAfter = await getAccount(provider.connection, solVault);
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const userStateAfter = await program.account.userState.fetch(user1State);
      const lpTokenSupplyAfter = (
        await getMint(provider.connection, lpTokenMint)
      ).supply;
      const user1SolAfter = await getAccount(
        provider.connection,
        user1SolAccount
      );
      const user1LpBalance = (
        await getAccount(provider.connection, user1LpTokenAccount)
      ).amount;

      // Calculate expected values (accounting for 0.1% fee)
      const feeAmount = initialSolDeposit.muln(1).divn(1000); // 0.1% fee
      const depositedAmount = initialSolDeposit.sub(feeAmount);

      // Verify state changes
      assert.equal(
        new BN(solVaultAfter.amount.toString())
          .sub(new BN(solVaultBefore.amount.toString()))
          .toString(),
        initialSolDeposit.toString(),
        "SOL vault balance should increase by deposit amount"
      );

      assert.equal(
        new BN(user1SolBefore.amount.toString())
          .sub(new BN(user1SolAfter.amount.toString()))
          .toString(),
        initialSolDeposit.toString(),
        "User SOL balance should decrease by deposit amount"
      );

      assert.isTrue(
        new BN(lpTokenSupplyAfter.toString()).gt(
          new BN(lpTokenSupplyBefore.toString())
        ),
        "LP token supply should increase"
      );

      // Check user state updates
      if (userStateBefore.lpTokenBalance) {
        assert.isTrue(
          userStateAfter.lpTokenBalance.gt(userStateBefore.lpTokenBalance),
          "User LP token balance should increase"
        );
      } else {
        assert.isTrue(
          userStateAfter.lpTokenBalance.gtn(0),
          "User LP token balance should be greater than zero"
        );
      }
    });

    it("should deposit USDC to the pool", async () => {
      // Get balances before deposit
      const usdcVaultBefore = await getAccount(provider.connection, usdcVault);
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const userStateBefore = await program.account.userState.fetch(user2State);
      const lpTokenSupplyBefore = (
        await getMint(provider.connection, lpTokenMint)
      ).supply;
      const user2UsdcBefore = await getAccount(
        provider.connection,
        user2UsdcAccount
      );

      // Deposit USDC
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

      // Get balances after deposit
      const usdcVaultAfter = await getAccount(provider.connection, usdcVault);
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const userStateAfter = await program.account.userState.fetch(user2State);
      const lpTokenSupplyAfter = (
        await getMint(provider.connection, lpTokenMint)
      ).supply;
      const user2UsdcAfter = await getAccount(
        provider.connection,
        user2UsdcAccount
      );
      const user2LpBalance = (
        await getAccount(provider.connection, user2LpTokenAccount)
      ).amount;

      // Verify state changes
      assert.equal(
        new BN(usdcVaultAfter.amount.toString())
          .sub(new BN(usdcVaultBefore.amount.toString()))
          .toString(),
        initialUsdcDeposit.toString(),
        "USDC vault balance should increase by deposit amount"
      );

      assert.equal(
        new BN(user2UsdcBefore.amount.toString())
          .sub(new BN(user2UsdcAfter.amount.toString()))
          .toString(),
        initialUsdcDeposit.toString(),
        "User USDC balance should decrease by deposit amount"
      );

      assert.isTrue(
        new BN(lpTokenSupplyAfter.toString()).gt(
          new BN(lpTokenSupplyBefore.toString())
        ),
        "LP token supply should increase"
      );

      // Check user state updates
      if (userStateBefore.lpTokenBalance) {
        assert.isTrue(
          userStateAfter.lpTokenBalance.gt(userStateBefore.lpTokenBalance),
          "User LP token balance should increase"
        );
      } else {
        assert.isTrue(
          userStateAfter.lpTokenBalance.gtn(0),
          "User LP token balance should be greater than zero"
        );
      }
    });

    it("should fail to deposit SOL if amount is zero", async () => {
      // Create a SOL token account for user1 if it doesn't exist
      const user1SolAccount = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          admin,
          solMint,
          user1.publicKey
        )
      ).address;

      try {
        await program.methods
          .deposit(new BN(0))
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

        assert.fail("Expected transaction to fail with zero amount");
      } catch (error: any) {
        assert.include(
          error.message,
          "Amount must be greater than zero",
          "Expected error message about zero amount"
        );
      }
    });

    it("should fail to deposit USDC if amount exceeds balance", async () => {
      const userUsdcBalance = await getAccount(
        provider.connection,
        user2UsdcAccount
      );
      const excessAmount = new BN(userUsdcBalance.amount.toString()).addn(1); // Balance + 1

      try {
        await program.methods
          .deposit(excessAmount)
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

        assert.fail("Expected transaction to fail with insufficient funds");
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