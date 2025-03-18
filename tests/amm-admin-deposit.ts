import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpAmm } from "../target/types/perp_amm";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
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

  describe("admin_deposit", () => {
    it("should allow admin to deposit SOL", async () => {
      // Get balances before admin deposit
      const solVaultBalanceBefore = await provider.connection.getBalance(
        solVault
      );
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const adminSolBalanceBefore = await provider.connection.getBalance(
        admin.publicKey
      );

      const depositAmount = new BN(LAMPORTS_PER_SOL); // 1 SOL

      // Admin deposit SOL
      await program.methods
        .adminDeposit(depositAmount)
        .accountsStrict({
          admin: admin.publicKey,
          poolState,
          adminTokenAccount: admin.publicKey,
          vaultAccount: solVault,
          chainlinkProgram: CHAINLINK_PROGRAM_ID,
          chainlinkFeed: SOL_USD_FEED,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();

      // Get balances after admin deposit
      const solVaultBalanceAfter = await provider.connection.getBalance(
        solVault
      );
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const adminSolBalanceAfter = await provider.connection.getBalance(
        admin.publicKey
      );

      // Verify state changes
      assert.approximately(
        solVaultBalanceAfter - solVaultBalanceBefore,
        depositAmount.toNumber(),
        1000, // Allow small difference for gas fees
        "SOL vault balance should increase by deposit amount"
      );

      assert.approximately(
        adminSolBalanceBefore - adminSolBalanceAfter,
        depositAmount.toNumber(),
        1000, // Allow small difference for gas fees
        "Admin SOL balance should decrease by deposit amount"
      );

      assert.equal(
        poolStateAfter.solDeposited.toString(),
        poolStateBefore.solDeposited.add(depositAmount).toString(),
        "Pool SOL deposited should increase by deposit amount"
      );
    });

    it("should allow admin to deposit USDC", async () => {
      // Get balances before admin deposit
      const usdcVaultBefore = await getAccount(provider.connection, usdcVault);
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const adminUsdcBefore = await getAccount(
        provider.connection,
        adminUsdcAccount
      );

      const depositAmount = new BN(100_000_000); // 100 USDC

      // Admin deposit USDC
      await program.methods
        .adminDeposit(depositAmount)
        .accountsStrict({
          admin: admin.publicKey,
          poolState,
          adminTokenAccount: adminUsdcAccount,
          vaultAccount: usdcVault,
          chainlinkProgram: CHAINLINK_PROGRAM_ID,
          chainlinkFeed: SOL_USD_FEED,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc();

      // Get balances after admin deposit
      const usdcVaultAfter = await getAccount(provider.connection, usdcVault);
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const adminUsdcAfter = await getAccount(
        provider.connection,
        adminUsdcAccount
      );

      // Verify state changes
      assert.equal(
        new BN(usdcVaultAfter.amount.toString())
          .sub(new BN(usdcVaultBefore.amount.toString()))
          .toString(),
        depositAmount.toString(),
        "USDC vault balance should increase by deposit amount"
      );

      assert.equal(
        new BN(adminUsdcBefore.amount.toString())
          .sub(new BN(adminUsdcAfter.amount.toString()))
          .toString(),
        depositAmount.toString(),
        "Admin USDC balance should decrease by deposit amount"
      );

      assert.equal(
        poolStateAfter.usdcDeposited.toString(),
        poolStateBefore.usdcDeposited.add(depositAmount).toString(),
        "Pool USDC deposited should increase by deposit amount"
      );
    });

    it("should fail if non-admin tries to deposit", async () => {
      try {
        await program.methods
          .adminDeposit(new BN(LAMPORTS_PER_SOL))
          .accountsStrict({
            admin: user1.publicKey,
            poolState,
            adminTokenAccount: user1.publicKey,
            vaultAccount: solVault,
            chainlinkProgram: CHAINLINK_PROGRAM_ID,
            chainlinkFeed: SOL_USD_FEED,
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
