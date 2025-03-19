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
  let usdcRewardVault: PublicKey;

  // Set up pool state
  let poolState: PublicKey;

  // Set up token accounts
  let adminUsdcAccount: PublicKey;
  let adminSolAccount: PublicKey;
  let user1UsdcAccount: PublicKey;
  let user2UsdcAccount: PublicKey;

  let mockChainlinkFeed: PublicKey;

  // Test parameters
  const rewardRate = new BN(100_000); // USDC per second for rewards
  const rewardAmount = new BN(10_000_000_000); // 10,000 USDC with 6 decimals

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

    // Get the pool state to find reward vault
    const poolStateAccount = await program.account.poolState.fetch(poolState);
    usdcRewardVault = poolStateAccount.usdcRewardVault;

    configInitialized = true;
  });

  // Use beforeEach to ensure all accounts are ready for each test
  beforeEach(async () => {
    // Ensure configuration is initialized before running tests
    if (!configInitialized) {
      throw new Error("Configuration not initialized");
    }
  });

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
        poolStateBefore.totalRewardsDeposited.add(rewardAmount).toString(),
        "Total rewards deposited should increase by reward amount"
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
          "Unauthorized",
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

    it("should update rewards correctly", async () => {
      // Update rewards to force accumulation
      await program.methods
        .updateRewards()
        .accountsStrict({
          poolState,
        })
        .rpc();

      // Get pool state after updating rewards
      const poolStateAfter = await program.account.poolState.fetch(poolState);

      // Verify state is properly updated
      assert.isTrue(
        poolStateAfter.lastDistributionTime.toNumber() > 0,
        "Last distribution time should be set"
      );
    });
  });
});