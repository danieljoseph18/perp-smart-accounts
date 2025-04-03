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
  let usdcRewardVault: PublicKey;
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

    console.log("Setup complete, retrieving configuration values...");

    // Retrieve configuration values from the setup helper.
    poolState = setup.poolState;
    solMint = setup.solMint;
    usdcMint = setup.usdcMint;
    lpTokenMint = setup.lpTokenMint;
    solVault = setup.solVault;
    usdcVault = setup.usdcVault;
    usdcRewardVault = setup.usdcRewardVault;
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

  describe("direct_deposit", () => {
    it("should allow admin to deposit WSOL to the SOL vault", async () => {
      // Get the current pool state to ensure we're using the correct values
      const poolStateAccount = await program.account.poolState.fetch(poolState);

      // First, wrap some SOL for the admin
      await wrapSol(
        admin.publicKey,
        adminSolAccount,
        2 * LAMPORTS_PER_SOL,
        provider,
        admin
      );

      // Get pool state before deposit
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const solDepositedBefore = poolStateBefore.solDeposited;

      // Check admin's WSOL balance before deposit
      const adminSolBefore = await getAccount(
        provider.connection,
        adminSolAccount
      );

      console.log(
        "Admin WSOL balance before deposit:",
        adminSolBefore.amount.toString()
      );

      const depositAmount = new BN(1_000_000_000); // 1 SOL
      await program.methods
        .directDeposit(depositAmount)
        .accountsStrict({
          depositor: admin.publicKey,
          poolState,
          depositorTokenAccount: adminSolAccount,
          vaultAccount: poolStateAccount.solVault,
          chainlinkProgram: chainlinkProgram,
          chainlinkFeed: chainlinkFeed,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      // Get pool state after admin deposit for verification
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const solDepositedAfter = poolStateAfter.solDeposited;

      // Check admin's WSOL balance after deposit
      const adminSolAfter = await getAccount(
        provider.connection,
        adminSolAccount
      );

      // Verify that the SOL deposited increased by the deposit amount.
      assert.equal(
        new BN(solDepositedAfter.toString())
          .sub(new BN(solDepositedBefore.toString()))
          .toString(),
        depositAmount.toString(),
        "SOL deposited in pool state should increase by deposit amount"
      );

      // Verify that the admin's WSOL balance decreased by the deposit amount
      assert.equal(
        new BN(adminSolBefore.amount.toString())
          .sub(new BN(adminSolAfter.amount.toString()))
          .toString(),
        depositAmount.toString(),
        "Admin WSOL balance should decrease by the deposit amount"
      );
    });

    it("should allow admin to deposit USDC", async () => {
      // Get the current pool state to ensure we're using the correct values
      const poolStateAccount = await program.account.poolState.fetch(poolState);

      // Get balances before admin deposit
      const poolStateBefore = await program.account.poolState.fetch(poolState);
      const usdcDepositedBefore = poolStateBefore.usdcDeposited;

      const adminUsdcBefore = await getAccount(
        provider.connection,
        adminUsdcAccount
      );

      console.log(
        "Admin USDC balance before deposit:",
        adminUsdcBefore.amount.toString()
      );
      console.log(
        "USDC deposited before deposit:",
        usdcDepositedBefore.toString()
      );

      const depositAmount = new BN(100_000_000); // 100 USDC

      // Admin deposit USDC
      await program.methods
        .directDeposit(depositAmount)
        .accountsStrict({
          depositor: admin.publicKey,
          poolState,
          depositorTokenAccount: adminUsdcAccount,
          vaultAccount: poolStateAccount.usdcVault,
          chainlinkProgram: chainlinkProgram,
          chainlinkFeed: chainlinkFeed,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      // Get balances after admin deposit
      const poolStateAfter = await program.account.poolState.fetch(poolState);
      const usdcDepositedAfter = poolStateAfter.usdcDeposited;
      const adminUsdcAfter = await getAccount(
        provider.connection,
        adminUsdcAccount
      );

      // Verify state changes
      assert.equal(
        new BN(usdcDepositedAfter.toString())
          .sub(new BN(usdcDepositedBefore.toString()))
          .toString(),
        depositAmount.toString(),
        "USDC deposited in pool state should increase by deposit amount"
      );

      assert.equal(
        new BN(adminUsdcBefore.amount.toString())
          .sub(new BN(adminUsdcAfter.amount.toString()))
          .toString(),
        depositAmount.toString(),
        "Admin USDC balance should decrease by deposit amount"
      );

      assert.equal(
        usdcDepositedAfter.toString(),
        usdcDepositedBefore.add(depositAmount).toString(),
        "Pool USDC deposited should increase by deposit amount"
      );
    });
  });
});
