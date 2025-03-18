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
  createMint,
  mintTo,
  getAccount,
  createAssociatedTokenAccount,
} from "@solana/spl-token";
import { assert } from "chai";
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

  describe("claim_rewards", () => {
    before(async () => {
      // Wait for some time to accumulate rewards
      await new Promise((resolve) => setTimeout(resolve, 2000));
    });

    it("should allow user1, who has LP tokens, to claim rewards", async () => {
      // Get balances before claiming rewards
      const user1UsdcBefore = await getAccount(
        provider.connection,
        user1UsdcAccount
      );
      const rewardVaultBefore = await getAccount(
        provider.connection,
        usdcRewardVault
      );
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const userStateBefore = await program.account.userState.fetch(user1State);

      // Claim rewards
      await program.methods
        .claimRewards()
        .accountsStrict({
          user: user1.publicKey,
          poolState,
          userState: user1State,
          usdcRewardVault,
          userUsdcAccount: user1UsdcAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          lpTokenMint,
        })
        .signers([user1])
        .rpc();

      // Get balances after claiming rewards
      const user1UsdcAfter = await getAccount(
        provider.connection,
        user1UsdcAccount
      );
      const rewardVaultAfter = await getAccount(
        provider.connection,
        usdcRewardVault
      );
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const userStateAfter = await program.account.userState.fetch(user1State);

      // Verify state changes
      const rewardsClaimed = new BN(user1UsdcAfter.amount.toString()).sub(
        new BN(user1UsdcBefore.amount.toString())
      );

      assert.isTrue(rewardsClaimed.gtn(0), "User should receive some rewards");

      assert.equal(
        new BN(rewardVaultBefore.amount.toString())
          .sub(new BN(rewardVaultAfter.amount.toString()))
          .toString(),
        rewardsClaimed.toString(),
        "Reward vault balance should decrease by rewards claimed"
      );

      assert.equal(
        poolStateAfter.totalRewardsClaimed.toString(),
        poolStateBefore.totalRewardsClaimed.add(rewardsClaimed).toString(),
        "Total rewards claimed should increase by rewards claimed"
      );

      assert.equal(
        userStateAfter.pendingRewards.toString(),
        "0",
        "Pending rewards should be reset to zero"
      );
    });

    it("should allow user2, who has LP tokens, to claim rewards", async () => {
      // Get balances before claiming rewards
      const user2UsdcBefore = await getAccount(
        provider.connection,
        user2UsdcAccount
      );
      const rewardVaultBefore = await getAccount(
        provider.connection,
        usdcRewardVault
      );
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const userStateBefore = await program.account.userState.fetch(user2State);

      // Claim rewards
      await program.methods
        .claimRewards()
        .accountsStrict({
          user: user2.publicKey,
          poolState,
          userState: user2State,
          usdcRewardVault,
          userUsdcAccount: user2UsdcAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          lpTokenMint,
        })
        .signers([user2])
        .rpc();

      // Get balances after claiming rewards
      const user2UsdcAfter = await getAccount(
        provider.connection,
        user2UsdcAccount
      );
      const rewardVaultAfter = await getAccount(
        provider.connection,
        usdcRewardVault
      );
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const userStateAfter = await program.account.userState.fetch(user2State);

      // Verify state changes
      const rewardsClaimed = new BN(user2UsdcAfter.amount.toString()).sub(
        new BN(user2UsdcBefore.amount.toString())
      );

      assert.isTrue(rewardsClaimed.gtn(0), "User should receive some rewards");

      assert.equal(
        new BN(rewardVaultBefore.amount.toString())
          .sub(new BN(rewardVaultAfter.amount.toString()))
          .toString(),
        rewardsClaimed.toString(),
        "Reward vault balance should decrease by rewards claimed"
      );

      assert.equal(
        poolStateAfter.totalRewardsClaimed.toString(),
        poolStateBefore.totalRewardsClaimed.add(rewardsClaimed).toString(),
        "Total rewards claimed should increase by rewards claimed"
      );

      assert.equal(
        userStateAfter.pendingRewards.toString(),
        "0",
        "Pending rewards should be reset to zero"
      );
    });

    it("should update rewards correctly when user deposits more", async () => {
      // Get state before deposit
      const userStateBefore = await program.account.userState.fetch(user1State);

      // Deposit more SOL
      await program.methods
        .deposit(new BN(LAMPORTS_PER_SOL))
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

      // Get state after deposit
      const userStateAfter = await program.account.userState.fetch(user1State);

      // Verify pending rewards are updated
      assert.isTrue(
        userStateAfter.pendingRewards.gte(userStateBefore.pendingRewards),
        "Pending rewards should be updated when user deposits more"
      );
    });

    it("should fail to claim rewards if user has no LP tokens", async () => {
      // Create a new user with no LP tokens
      const newUser = Keypair.generate();
      await provider.connection.requestAirdrop(
        newUser.publicKey,
        LAMPORTS_PER_SOL
      );

      // Create user state for new user
      const [newUserState, _] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_state"), newUser.publicKey.toBuffer()],
        program.programId
      );

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
        .signers([newUser])
        .rpc();

      // Create USDC account for new user
      const newUserUsdcAccount = await createAssociatedTokenAccount(
        provider.connection,
        admin,
        usdcMint,
        newUser.publicKey
      );

      try {
        await program.methods
          .claimRewards()
          .accountsStrict({
            user: newUser.publicKey,
            poolState,
            userState: newUserState,
            usdcRewardVault,
            userUsdcAccount: newUserUsdcAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            lpTokenMint,
          })
          .signers([newUser])
          .rpc();

        assert.fail("Expected transaction to fail with no LP tokens");
      } catch (error: any) {
        assert.include(
          error.message,
          "User has no LP tokens",
          "Expected error message about no LP tokens"
        );
      }
    });
  });
});
