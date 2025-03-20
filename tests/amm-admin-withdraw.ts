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

    configInitialized = true;
  });

  // Ensure configuration is initialized before each test.
  beforeEach(async () => {
    if (!configInitialized) {
      throw new Error("Configuration not initialized");
    }
  });

  describe("admin_withdraw", () => {
    it("should allow admin to withdraw WSOL", async () => {
      // First deposit WSOL into the vault.
      await wrapSol(
        admin.publicKey,
        adminSolAccount,
        LAMPORTS_PER_SOL,
        provider,
        admin
      );

      const depositAmount = new BN(LAMPORTS_PER_SOL);
      await program.methods
        .adminDeposit(depositAmount)
        .accountsStrict({
          admin: admin.publicKey,
          poolState,
          adminTokenAccount: adminSolAccount,
          vaultAccount: solVault,
          chainlinkProgram: chainlinkProgram,
          chainlinkFeed: chainlinkFeed,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      // Get the pool state and admin's WSOL balance before withdrawal
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const adminSolBefore = await getAccount(
        provider.connection,
        adminSolAccount
      );
      const solVaultBefore = await getAccount(provider.connection, solVault);

      // Withdraw half of the deposited amount
      const withdrawAmount = depositAmount.divn(2);

      await program.methods
        .adminWithdraw(withdrawAmount)
        .accountsStrict({
          admin: admin.publicKey,
          poolState,
          vaultAccount: solVault,
          adminTokenAccount: adminSolAccount,
          chainlinkProgram: chainlinkProgram,
          chainlinkFeed: chainlinkFeed,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const adminSolAfter = await getAccount(
        provider.connection,
        adminSolAccount
      );
      const solVaultAfter = await getAccount(provider.connection, solVault);

      // Verify that the pool state's SOL deposited is reduced by the
      // withdrawal amount.
      assert.equal(
        poolStateBefore.solDeposited.sub(withdrawAmount).toString(),
        poolStateAfter.solDeposited.toString(),
        "Pool SOL deposited should decrease by withdrawal amount"
      );

      // Verify that the vault's balance decreased by the withdrawal amount
      assert.equal(
        new BN(solVaultBefore.amount.toString())
          .sub(new BN(solVaultAfter.amount.toString()))
          .toString(),
        withdrawAmount.toString(),
        "SOL vault balance should decrease by withdrawal amount"
      );

      // Verify that the admin's WSOL balance increased by the withdrawal amount
      assert.equal(
        new BN(adminSolAfter.amount.toString())
          .sub(new BN(adminSolBefore.amount.toString()))
          .toString(),
        withdrawAmount.toString(),
        "Admin WSOL balance should increase by withdrawal amount"
      );
    });

    it("should allow admin to withdraw USDC", async () => {
      // Deposit USDC into the vault.
      const depositAmount = new BN(100_000_000); // 100 USDC
      await program.methods
        .adminDeposit(depositAmount)
        .accountsStrict({
          admin: admin.publicKey,
          poolState,
          adminTokenAccount: adminUsdcAccount,
          vaultAccount: usdcVault,
          chainlinkProgram: chainlinkProgram,
          chainlinkFeed: chainlinkFeed,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      const usdcVaultBefore = await getAccount(provider.connection, usdcVault);
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const adminUsdcBefore = await getAccount(
        provider.connection,
        adminUsdcAccount
      );

      const withdrawAmount = new BN(50_000_000); // 50 USDC

      await program.methods
        .adminWithdraw(withdrawAmount)
        .accountsStrict({
          admin: admin.publicKey,
          poolState,
          vaultAccount: usdcVault,
          adminTokenAccount: adminUsdcAccount,
          chainlinkProgram: chainlinkProgram,
          chainlinkFeed: chainlinkFeed,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      const usdcVaultAfter = await getAccount(provider.connection, usdcVault);
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const adminUsdcAfter = await getAccount(
        provider.connection,
        adminUsdcAccount
      );

      // Verify that the USDC vault balance decreased exactly by the
      // withdrawal amount.
      assert.equal(
        new BN(usdcVaultBefore.amount.toString())
          .sub(new BN(usdcVaultAfter.amount.toString()))
          .toString(),
        withdrawAmount.toString(),
        "USDC vault balance should decrease by withdrawal amount"
      );

      // Verify that the admin's USDC token account increased exactly by the
      // withdrawal amount.
      assert.equal(
        new BN(adminUsdcAfter.amount.toString())
          .sub(new BN(adminUsdcBefore.amount.toString()))
          .toString(),
        withdrawAmount.toString(),
        "Admin USDC balance should increase by withdrawal amount"
      );

      // Verify that the pool state's USDC deposited is updated accordingly.
      assert.equal(
        poolStateBefore.usdcDeposited.sub(withdrawAmount).toString(),
        poolStateAfter.usdcDeposited.toString(),
        "Pool USDC deposited should decrease by withdrawal amount"
      );
    });

    it("should fail if non-admin tries to withdraw", async () => {
      // Create a token account for user1 to receive SOL.
      const user1SolAccount = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin, // Funded by admin as needed.
        solMint,
        user1.publicKey
      );

      try {
        await program.methods
          .adminWithdraw(new BN(LAMPORTS_PER_SOL))
          .accountsStrict({
            admin: user1.publicKey,
            poolState,
            vaultAccount: solVault,
            adminTokenAccount: user1SolAccount.address,
            chainlinkProgram: chainlinkProgram,
            chainlinkFeed: chainlinkFeed,
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
      // For an insufficient funds test, use the USDC vault.
      const usdcVaultInfo = await getAccount(provider.connection, usdcVault);
      const currentBalance = new BN(usdcVaultInfo.amount.toString());
      const excessAmount = currentBalance.addn(1); // Current balance + 1

      try {
        await program.methods
          .adminWithdraw(excessAmount)
          .accountsStrict({
            admin: admin.publicKey,
            poolState,
            vaultAccount: usdcVault,
            adminTokenAccount: adminUsdcAccount,
            chainlinkProgram: chainlinkProgram,
            chainlinkFeed: chainlinkFeed,
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
