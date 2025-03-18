import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpAmm } from "../target/types/perp_amm";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  createMint,
  mintTo,
  getAccount,
  createAssociatedTokenAccount,
  getMint,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import BN from "bn.js";

describe("perp-amm", () => {
  // Configure the client to use the local cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PerpAmm as Program<PerpAmm>;

  // Constants
  const CHAINLINK_PROGRAM_ID = new PublicKey(
    "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny"
  );
  const SOL_USD_FEED = new PublicKey(
    "HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6"
  );

  // Set up common accounts
  const admin = Keypair.generate();
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();

  let _: number;

  // Set up token mints and vaults
  let usdcMint: PublicKey;
  let lpTokenMint: PublicKey;
  let solVault: PublicKey;
  let usdcVault: PublicKey;
  let usdcRewardVault: PublicKey;

  // Set up pool state
  let poolState: PublicKey;
  let poolStateBump: number;

  // Set up user accounts
  let user1State: PublicKey;
  let user1StateBump: number;
  let user2State: PublicKey;
  let user2StateBump: number;

  // Set up token accounts
  let adminUsdcAccount: PublicKey;
  let adminLpTokenAccount: PublicKey;
  let adminSolAccount: PublicKey;

  let user1UsdcAccount: PublicKey;
  let user1LpTokenAccount: PublicKey;
  let user1SolAccount: PublicKey;

  let user2UsdcAccount: PublicKey;
  let user2LpTokenAccount: PublicKey;
  let user2SolAccount: PublicKey;

  // Test parameters
  const initialSolDeposit = new BN(2 * LAMPORTS_PER_SOL);
  const initialUsdcDeposit = new BN(200_000_000); // 200 USDC with 6 decimals
  const rewardRate = new BN(100_000); // USDC per second for rewards
  const rewardAmount = new BN(10_000_000_000); // 10,000 USDC with 6 decimals

  before(async () => {
    // Airdrop SOL to admin and users
    await provider.connection.requestAirdrop(
      admin.publicKey,
      100 * LAMPORTS_PER_SOL
    );
    await provider.connection.requestAirdrop(
      user1.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.requestAirdrop(
      user2.publicKey,
      10 * LAMPORTS_PER_SOL
    );

    // Create USDC mint
    usdcMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Create token accounts
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

    // Derive PDA for pool state
    [poolState, poolStateBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_state")],
      program.programId
    );

    // Derive PDAs for user states
    [user1State, user1StateBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_state"), user1.publicKey.toBuffer()],
      program.programId
    );

    [user2State, user2StateBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_state"), user2.publicKey.toBuffer()],
      program.programId
    );

    // Derive PDAs for vaults
    [solVault, _] = PublicKey.findProgramAddressSync(
      [Buffer.from("sol_vault"), poolState.toBuffer()],
      program.programId
    );

    [usdcVault, _] = PublicKey.findProgramAddressSync(
      [Buffer.from("usdc_vault"), poolState.toBuffer()],
      program.programId
    );

    [usdcRewardVault, _] = PublicKey.findProgramAddressSync(
      [Buffer.from("usdc_reward_vault"), poolState.toBuffer()],
      program.programId
    );

    // Derive PDA for LP token mint
    [lpTokenMint, _] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_token_mint"), poolState.toBuffer()],
      program.programId
    );
  });

  // Test suite will go here, each instruction will have its own describe block

  describe("initialize", () => {
    it("should initialize the pool state", async () => {
      // Create LP token accounts for all users
      user1LpTokenAccount = await createAssociatedTokenAccount(
        provider.connection,
        admin,
        lpTokenMint,
        user1.publicKey
      );

      user2LpTokenAccount = await createAssociatedTokenAccount(
        provider.connection,
        admin,
        lpTokenMint,
        user2.publicKey
      );

      adminLpTokenAccount = await createAssociatedTokenAccount(
        provider.connection,
        admin,
        lpTokenMint,
        admin.publicKey
      );

      // Initialize the pool
      await program.methods
        .initialize()
        .accountsStrict({
          admin: admin.publicKey,
          authority: admin.publicKey,
          poolState,
          solVault,
          usdcVault,
          lpTokenMint,
          usdcRewardVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([admin])
        .rpc();

      // Verify the pool state was initialized correctly
      const poolStateAccount = await program.account.poolState.fetch(poolState);

      assert.isTrue(poolStateAccount.admin.equals(admin.publicKey));
      assert.isTrue(poolStateAccount.lpTokenMint.equals(lpTokenMint));
      assert.isTrue(poolStateAccount.solVault.equals(solVault));
      assert.isTrue(poolStateAccount.usdcVault.equals(usdcVault));
      assert.isTrue(poolStateAccount.usdcRewardVault.equals(usdcRewardVault));
      assert.equal(poolStateAccount.solDeposited.toString(), "0");
      assert.equal(poolStateAccount.usdcDeposited.toString(), "0");
      assert.equal(poolStateAccount.accumulatedSolFees.toString(), "0");
      assert.equal(poolStateAccount.accumulatedUsdcFees.toString(), "0");
      assert.equal(poolStateAccount.totalRewardsDeposited.toString(), "0");
      assert.equal(poolStateAccount.totalRewardsClaimed.toString(), "0");
    });
  });

  describe("deposit", () => {
    it("should deposit SOL to the pool", async () => {
      // Get balance before deposit
      const solVaultBalanceBefore = await provider.connection.getBalance(
        solVault
      );
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const userStateBefore = await program.account.userState.fetch(user1State);
      const lpTokenSupplyBefore = (
        await getMint(provider.connection, lpTokenMint)
      ).supply;

      // Deposit SOL
      await program.methods
        .deposit(initialSolDeposit)
        .accountsStrict({
          user: user1.publicKey,
          poolState,
          userTokenAccount: user1.publicKey, // SOL is native, use wallet directly
          vaultAccount: solVault,
          userState: user1State,
          lpTokenMint,
          userLpTokenAccount: user1LpTokenAccount,
          chainlinkProgram: CHAINLINK_PROGRAM_ID,
          chainlinkFeed: SOL_USD_FEED,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      // Get balance after deposit
      const solVaultBalanceAfter = await provider.connection.getBalance(
        solVault
      );
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const userStateAfter = await program.account.userState.fetch(user1State);
      const lpTokenSupplyAfter = (
        await getMint(provider.connection, lpTokenMint)
      ).supply;
      const user1LpBalance = (
        await getAccount(provider.connection, user1LpTokenAccount)
      ).amount;

      // Calculate expected values (accounting for 0.1% fee)
      const feeAmount = initialSolDeposit.muln(1).divn(1000); // 0.1% fee
      const depositedAmount = initialSolDeposit.sub(feeAmount);

      // Verify state changes
      assert.equal(
        solVaultBalanceAfter - solVaultBalanceBefore,
        initialSolDeposit.toNumber(),
        "SOL vault balance should increase by deposit amount"
      );

      assert.equal(
        poolStateAfter.solDeposited.toString(),
        poolStateBefore.solDeposited.add(depositedAmount).toString(),
        "Pool SOL deposited should increase by deposit amount minus fees"
      );

      assert.equal(
        poolStateAfter.accumulatedSolFees.toString(),
        poolStateBefore.accumulatedSolFees.add(feeAmount).toString(),
        "Accumulated SOL fees should increase by fee amount"
      );

      assert.isTrue(
        new BN(lpTokenSupplyAfter.toString()).gt(
          new BN(lpTokenSupplyBefore.toString())
        ),
        "LP token supply should increase"
      );

      assert.equal(
        userStateAfter.lpTokenBalance.toString(),
        userStateBefore.lpTokenBalance
          .add(new BN(user1LpBalance.toString()))
          .toString(),
        "User LP token balance should increase"
      );
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
          chainlinkProgram: CHAINLINK_PROGRAM_ID,
          chainlinkFeed: SOL_USD_FEED, // Not used for USDC deposits, but still required
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

      // Calculate expected values (accounting for 0.1% fee)
      const feeAmount = initialUsdcDeposit.muln(1).divn(1000); // 0.1% fee
      const depositedAmount = initialUsdcDeposit.sub(feeAmount);

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

      assert.equal(
        poolStateAfter.usdcDeposited.toString(),
        poolStateBefore.usdcDeposited.add(depositedAmount).toString(),
        "Pool USDC deposited should increase by deposit amount minus fees"
      );

      assert.equal(
        poolStateAfter.accumulatedUsdcFees.toString(),
        poolStateBefore.accumulatedUsdcFees.add(feeAmount).toString(),
        "Accumulated USDC fees should increase by fee amount"
      );

      assert.isTrue(
        new BN(lpTokenSupplyAfter.toString()).gt(
          new BN(lpTokenSupplyBefore.toString())
        ),
        "LP token supply should increase"
      );

      assert.equal(
        userStateAfter.lpTokenBalance.toString(),
        userStateBefore.lpTokenBalance
          .add(new BN(user2LpBalance.toString()))
          .toString(),
        "User LP token balance should increase"
      );
    });

    it("should fail to deposit SOL if amount is zero", async () => {
      try {
        await program.methods
          .deposit(new BN(0))
          .accountsStrict({
            user: user1.publicKey,
            poolState,
            userTokenAccount: user1.publicKey,
            vaultAccount: solVault,
            userState: user1State,
            lpTokenMint,
            userLpTokenAccount: user1LpTokenAccount,
            chainlinkProgram: CHAINLINK_PROGRAM_ID,
            chainlinkFeed: SOL_USD_FEED,
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
            chainlinkProgram: CHAINLINK_PROGRAM_ID,
            chainlinkFeed: SOL_USD_FEED,
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
