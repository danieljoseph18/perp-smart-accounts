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

  describe("start_rewards", () => {
    it("should allow admin to start rewards distribution", async () => {
      // Get balances before starting rewards
      const rewardVaultBefore = await getAccount(
        provider.connection,
        usdcRewardVault
      );
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const adminUsdcBefore = await getAccount(
        provider.connection,
        adminUsdcAccount
      );

      // Start rewards
      await program.methods
        .startRewards(rewardAmount, rewardRate)
        .accountsStrict({
          admin: admin.publicKey,
          poolState,
          adminUsdcAccount,
          usdcRewardVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();

      // Get balances after starting rewards
      const rewardVaultAfter = await getAccount(
        provider.connection,
        usdcRewardVault
      );
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const adminUsdcAfter = await getAccount(
        provider.connection,
        adminUsdcAccount
      );

      // Verify state changes
      assert.equal(
        new BN(rewardVaultAfter.amount.toString())
          .sub(new BN(rewardVaultBefore.amount.toString()))
          .toString(),
        rewardAmount.toString(),
        "Reward vault balance should increase by reward amount"
      );

      assert.equal(
        new BN(adminUsdcBefore.amount.toString())
          .sub(new BN(adminUsdcAfter.amount.toString()))
          .toString(),
        rewardAmount.toString(),
        "Admin USDC balance should decrease by reward amount"
      );

      assert.equal(
        poolStateAfter.totalRewardsDeposited.toString(),
        rewardAmount.toString(),
        "Total rewards deposited should equal reward amount"
      );

      assert.equal(
        poolStateAfter.tokensPerInterval.toString(),
        rewardRate.toString(),
        "Tokens per interval should be set correctly"
      );

      assert.isTrue(
        poolStateAfter.lastDistributionTime.toNumber() > 0,
        "Last distribution time should be set"
      );
    });

    it("should fail if non-admin tries to start rewards", async () => {
      try {
        await program.methods
          .startRewards(new BN(1000000), new BN(10))
          .accountsStrict({
            admin: user1.publicKey,
            poolState,
            adminUsdcAccount: user1UsdcAccount,
            usdcRewardVault,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();

        assert.fail("Expected transaction to fail with unauthorized admin");
      } catch (error: any) {
        assert.include(
          error.message,
          "Only admin can perform this action",
          "Expected error message about unauthorized admin"
        );
      }
    });

    it("should allow admin to update reward rate", async () => {
      // Get pool state before updating rewards
      const poolStateBefore = await program.account.poolState.fetch(poolState);

      const newRewardRate = rewardRate.muln(2); // Double the reward rate

      // Update rewards without adding more USDC
      await program.methods
        .startRewards(new BN(0), newRewardRate)
        .accountsStrict({
          admin: admin.publicKey,
          poolState,
          adminUsdcAccount,
          usdcRewardVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();

      // Get pool state after updating rewards
      const poolStateAfter = await program.account.poolState.fetch(poolState);

      // Verify state changes
      assert.equal(
        poolStateAfter.tokensPerInterval.toString(),
        newRewardRate.toString(),
        "Tokens per interval should be updated"
      );

      assert.equal(
        poolStateAfter.totalRewardsDeposited.toString(),
        poolStateBefore.totalRewardsDeposited.toString(),
        "Total rewards deposited should remain unchanged"
      );

      assert.isTrue(
        poolStateAfter.lastDistributionTime.toNumber() >=
          poolStateBefore.lastDistributionTime.toNumber(),
        "Last distribution time should be updated"
      );
    });
  });
});
