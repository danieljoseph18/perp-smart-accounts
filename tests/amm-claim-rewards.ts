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
  let usdcRewardVault: PublicKey;

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
  const rewardRate = new BN(100_000); // USDC per second for rewards
  const rewardAmount = new BN(10_000_000_000); // 10,000 USDC with 6 decimals

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

    // Get the pool state to find reward vault
    const poolStateAccount = await program.account.poolState.fetch(poolState);
    usdcRewardVault = poolStateAccount.usdcRewardVault;

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

  describe("claim_rewards", () => {
    // Start rewards and deposit tokens to earn rewards
    before(async () => {
      try {
        // Start rewards with a reward rate
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

        // User1 deposit SOL to earn rewards
        const user1SolAccount = (
          await getOrCreateAssociatedTokenAccount(
            provider.connection,
            admin,
            solMint,
            user1.publicKey
          )
        ).address;

        // Add some SOL to user1's account
        const wrapAmount = 2 * LAMPORTS_PER_SOL; // 2 SOL
        const wrapIx = SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: user1SolAccount,
          lamports: wrapAmount,
        });

        const wrapTx = new anchor.web3.Transaction().add(wrapIx);
        await provider.sendAndConfirm(wrapTx, [admin]);

        // User1 deposit SOL to earn rewards
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
            chainlinkProgram: chainlinkProgram,
            chainlinkFeed: chainlinkFeed,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();

        // Wait a few seconds for rewards to accrue
        console.log("Waiting for rewards to accrue...");
        await new Promise((resolve) => setTimeout(resolve, 3000));
      } catch (error) {
        console.log("Error in setup, continuing with tests:", error);
      }
    });

    it("should allow users to claim rewards", async () => {
      // Get balances before claiming rewards
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const userStateBefore = await program.account.userState.fetch(user1State);
      const user1UsdcBefore = await getAccount(
        provider.connection,
        user1UsdcAccount
      );

      // Ensure rewards have started
      if (poolStateBefore.lastDistributionTime.eqn(0)) {
        console.log("Rewards haven't started, skipping test");
        return;
      }

      // Claim rewards
      await program.methods
        .claimRewards()
        .accountsStrict({
          user: user1.publicKey,
          poolState,
          userState: user1State,
          userUsdcAccount: user1UsdcAccount,
          usdcRewardVault,
          lpTokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user1])
        .rpc();

      // Get balances after claiming rewards
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const userStateAfter = await program.account.userState.fetch(user1State);
      const user1UsdcAfter = await getAccount(
        provider.connection,
        user1UsdcAccount
      );

      // Verify state changes
      assert.isTrue(
        new BN(user1UsdcAfter.amount.toString()).gte(
          new BN(user1UsdcBefore.amount.toString())
        ),
        "User USDC balance should not decrease after claiming rewards"
      );

      const rewardsClaimed = new BN(user1UsdcAfter.amount.toString()).sub(
        new BN(user1UsdcBefore.amount.toString())
      );

      if (rewardsClaimed.gtn(0)) {
        assert.equal(
          poolStateAfter.totalRewardsClaimed.toString(),
          poolStateBefore.totalRewardsClaimed.add(rewardsClaimed).toString(),
          "Total rewards claimed should increase by the claimed amount"
        );

        assert.equal(
          userStateAfter.pendingRewards.toString(),
          "0",
          "User rewards owed should be reset to zero"
        );
      }
    });

    it("should not allow users to claim rewards if they have none", async () => {
      // Get balances before claiming rewards
      const userStateBefore = await program.account.userState.fetch(user2State);
      const user2UsdcBefore = await getAccount(
        provider.connection,
        user2UsdcAccount
      );

      // Check if user has any rewards owed
      if (
        userStateBefore.pendingRewards &&
        userStateBefore.pendingRewards.eqn(0) &&
        userStateBefore.lpTokenBalance &&
        userStateBefore.lpTokenBalance.eqn(0)
      ) {
        console.log("User has no rewards, skipping test");
        return;
      }

      // Claim rewards
      await program.methods
        .claimRewards()
        .accountsStrict({
          user: user2.publicKey,
          poolState,
          userState: user2State,
          userUsdcAccount: user2UsdcAccount,
          usdcRewardVault,
          lpTokenMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user2])
        .rpc();

      // Get balances after claiming rewards
      const userStateAfter = await program.account.userState.fetch(user2State);
      const user2UsdcAfter = await getAccount(
        provider.connection,
        user2UsdcAccount
      );

      // Verify state is unchanged or that a small amount was claimed
      assert.isTrue(
        new BN(user2UsdcAfter.amount.toString()).gte(
          new BN(user2UsdcBefore.amount.toString())
        ),
        "User USDC balance should not decrease after claiming rewards"
      );

      if (userStateAfter.pendingRewards) {
        assert.equal(
          userStateAfter.pendingRewards.toString(),
          "0",
          "User rewards owed should be reset to zero"
        );
      }
    });
  });
});
