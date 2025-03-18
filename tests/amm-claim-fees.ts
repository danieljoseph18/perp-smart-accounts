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

  describe("claim_fees", () => {
    it("should allow admin to claim accumulated SOL fees", async () => {
      // Get balances before claiming fees
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const adminSolBalanceBefore = await provider.connection.getBalance(
        admin.publicKey
      );

      // Ensure there are some accumulated SOL fees
      assert.isTrue(
        poolStateBefore.accumulatedSolFees.gtn(0),
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
          adminSolAccount: admin.publicKey,
          adminUsdcAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();

      // Get balances after claiming fees
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const adminSolBalanceAfter = await provider.connection.getBalance(
        admin.publicKey
      );

      // Verify state changes
      assert.isTrue(
        adminSolBalanceAfter > adminSolBalanceBefore,
        "Admin SOL balance should increase after claiming fees"
      );

      assert.equal(
        poolStateAfter.accumulatedSolFees.toString(),
        "0",
        "Accumulated SOL fees should be reset to zero"
      );
    });

    it("should allow admin to claim accumulated USDC fees", async () => {
      // First, ensure we have accumulated some USDC fees by making a deposit
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
          chainlinkProgram: CHAINLINK_PROGRAM_ID,
          chainlinkFeed: SOL_USD_FEED,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user2])
        .rpc();

      // Get balances before claiming fees
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const adminUsdcBefore = await getAccount(
        provider.connection,
        adminUsdcAccount
      );

      // Ensure there are some accumulated USDC fees
      assert.isTrue(
        poolStateBefore.accumulatedUsdcFees.gtn(0),
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
          adminSolAccount: admin.publicKey,
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
        await program.methods
          .claimFees()
          .accountsStrict({
            admin: user1.publicKey,
            poolState,
            solVault,
            usdcVault,
            adminSolAccount: user1.publicKey,
            adminUsdcAccount: user1UsdcAccount,
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
  });
});
