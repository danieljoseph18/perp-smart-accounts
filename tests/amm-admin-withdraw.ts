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

    configInitialized = true;
  });

  // Use beforeEach to ensure all accounts are ready for each test
  beforeEach(async () => {
    // Ensure configuration is initialized before running tests
    if (!configInitialized) {
      throw new Error("Configuration not initialized");
    }
  });

  describe("admin_withdraw", () => {
    it("should allow admin to withdraw SOL", async () => {
      // First ensure there's SOL in the vault by depositing some
      const depositAmount = new BN(LAMPORTS_PER_SOL);
      await program.methods
        .adminDeposit(depositAmount)
        .accountsStrict({
          admin: admin.publicKey,
          poolState,
          adminTokenAccount: adminSolAccount,
          vaultAccount: solVault,
          chainlinkProgram: chainlinkMockProgram.programId,
          chainlinkFeed: mockChainlinkFeed,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      // Get balances before admin withdrawal
      const solVaultBefore = await getAccount(provider.connection, solVault);
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const adminSolBefore = await getAccount(
        provider.connection,
        adminSolAccount
      );

      const withdrawAmount = new BN(LAMPORTS_PER_SOL / 2); // 0.5 SOL

      // Admin withdraw SOL
      await program.methods
        .adminWithdraw(withdrawAmount)
        .accountsStrict({
          admin: admin.publicKey,
          poolState,
          vaultAccount: solVault,
          adminTokenAccount: adminSolAccount,
          chainlinkProgram: chainlinkMockProgram.programId,
          chainlinkFeed: mockChainlinkFeed,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      // Get balances after admin withdrawal
      const solVaultAfter = await getAccount(provider.connection, solVault);
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const adminSolAfter = await getAccount(
        provider.connection,
        adminSolAccount
      );

      // Verify state changes
      assert.equal(
        new BN(solVaultBefore.amount.toString())
          .sub(new BN(solVaultAfter.amount.toString()))
          .toString(),
        withdrawAmount.toString(),
        "SOL vault balance should decrease by withdrawal amount"
      );

      assert.equal(
        new BN(adminSolAfter.amount.toString())
          .sub(new BN(adminSolBefore.amount.toString()))
          .toString(),
        withdrawAmount.toString(),
        "Admin SOL balance should increase by withdrawal amount"
      );

      assert.equal(
        poolStateBefore.solDeposited.sub(withdrawAmount).toString(),
        poolStateAfter.solDeposited.toString(),
        "Pool SOL deposited should decrease by withdrawal amount"
      );
    });

    it("should allow admin to withdraw USDC", async () => {
      // First ensure there's USDC in the vault by depositing some
      const depositAmount = new BN(100_000_000); // 100 USDC
      await program.methods
        .adminDeposit(depositAmount)
        .accountsStrict({
          admin: admin.publicKey,
          poolState,
          adminTokenAccount: adminUsdcAccount,
          vaultAccount: usdcVault,
          chainlinkProgram: chainlinkMockProgram.programId,
          chainlinkFeed: mockChainlinkFeed,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      // Get balances before admin withdrawal
      const usdcVaultBefore = await getAccount(provider.connection, usdcVault);
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const adminUsdcBefore = await getAccount(
        provider.connection,
        adminUsdcAccount
      );

      const withdrawAmount = new BN(50_000_000); // 50 USDC

      // Admin withdraw USDC
      await program.methods
        .adminWithdraw(withdrawAmount)
        .accountsStrict({
          admin: admin.publicKey,
          poolState,
          vaultAccount: usdcVault,
          adminTokenAccount: adminUsdcAccount,
          chainlinkProgram: chainlinkMockProgram.programId,
          chainlinkFeed: mockChainlinkFeed,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      // Get balances after admin withdrawal
      const usdcVaultAfter = await getAccount(provider.connection, usdcVault);
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const adminUsdcAfter = await getAccount(
        provider.connection,
        adminUsdcAccount
      );

      // Verify state changes
      assert.equal(
        new BN(usdcVaultBefore.amount.toString())
          .sub(new BN(usdcVaultAfter.amount.toString()))
          .toString(),
        withdrawAmount.toString(),
        "USDC vault balance should decrease by withdrawal amount"
      );

      assert.equal(
        new BN(adminUsdcAfter.amount.toString())
          .sub(new BN(adminUsdcBefore.amount.toString()))
          .toString(),
        withdrawAmount.toString(),
        "Admin USDC balance should increase by withdrawal amount"
      );

      assert.equal(
        poolStateBefore.usdcDeposited.sub(withdrawAmount).toString(),
        poolStateAfter.usdcDeposited.toString(),
        "Pool USDC deposited should decrease by withdrawal amount"
      );
    });

    it("should fail if non-admin tries to withdraw", async () => {
      try {
        // Create a token account for user1 to receive SOL
        const user1SolAccount = await getOrCreateAssociatedTokenAccount(
          provider.connection,
          admin, // Fund with admin since user1 doesn't have enough SOL
          solMint,
          user1.publicKey
        );

        await program.methods
          .adminWithdraw(new BN(LAMPORTS_PER_SOL))
          .accountsStrict({
            admin: user1.publicKey,
            poolState,
            vaultAccount: solVault,
            adminTokenAccount: user1SolAccount.address,
            chainlinkProgram: chainlinkMockProgram.programId,
            chainlinkFeed: mockChainlinkFeed,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
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

    it("should fail if admin tries to withdraw more than vault balance", async () => {
      // Get current vault balance
      const solVaultInfo = await getAccount(provider.connection, solVault);
      const currentBalance = new BN(solVaultInfo.amount.toString());
      const excessAmount = currentBalance.addn(1); // Balance + 1

      try {
        await program.methods
          .adminWithdraw(excessAmount)
          .accountsStrict({
            admin: admin.publicKey,
            poolState,
            vaultAccount: solVault,
            adminTokenAccount: adminSolAccount,
            chainlinkProgram: chainlinkMockProgram.programId,
            chainlinkFeed: mockChainlinkFeed,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin])
          .rpc();

        assert.fail(
          "Expected transaction to fail with insufficient vault balance"
        );
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
