import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PerpMarginAccounts } from "../target/types/perp_margin_accounts";
import { PerpAmm } from "../target/types/perp_amm";
import {
  PublicKey,
  SystemProgram,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";
import BN from "bn.js";
import * as dotenv from "dotenv";
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

describe("perp-margin-accounts", () => {
  // Configure the client to use the local cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const ammProgram = anchor.workspace.PerpAmm as Program<PerpAmm>;

  const marginProgram = anchor.workspace
    .PerpMarginAccounts as Program<PerpMarginAccounts>;

  // Use a fixed keypair for admin (for consistent testing)
  const admin = Keypair.fromSeed(Uint8Array.from(Array(32).fill(1)));
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();

  // Set up token mints and vaults
  let usdcMint: PublicKey;
  let solMint: PublicKey;
  let marginVault: PublicKey;
  let solVault: PublicKey;
  let usdcVault: PublicKey;
  let lpTokenMint: PublicKey;

  // Set up pool state
  let poolState: PublicKey;

  // Set up token accounts
  let adminSolAccount: PublicKey;
  let adminUsdcAccount: PublicKey;
  let user1SolAccount: PublicKey;
  let user1UsdcAccount: PublicKey;
  let user2SolAccount: PublicKey;
  let user2UsdcAccount: PublicKey;

  // User states
  let user1State: PublicKey;
  let user2State: PublicKey;

  // User LP token accounts
  let user1LpTokenAccount: PublicKey;
  let user2LpTokenAccount: PublicKey;

  // User margin accounts
  let user1MarginAccount: PublicKey;
  let user2MarginAccount: PublicKey;

  let marginSolVault: PublicKey;
  let marginUsdcVault: PublicKey;

  // Test parameters
  const solDepositAmount = new BN(LAMPORTS_PER_SOL); // 1 SOL
  const usdcDepositAmount = new BN(10_000_000); // 10 USDC (with 6 decimals)

  // Test parameters
  const withdrawalTimelock = 1; // 1 seconds

  const initialSolDeposit = new BN(1000);
  const initialUsdcDeposit = new BN(1000);

  // Global configuration state
  let configInitialized = false;

  before(async () => {
    console.log("=== Starting test setup ===");

    // Set up the AMM program; this helper creates mints, vaults,
    // poolState, and admin/user token accounts.
    const setup = await setupAmmProgram(
      provider,
      ammProgram,
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
    adminSolAccount = setup.adminSolAccount;
    adminUsdcAccount = setup.adminUsdcAccount;
    user1UsdcAccount = setup.user1UsdcAccount;
    user2UsdcAccount = setup.user2UsdcAccount;
    marginVault = setup.marginVault;
    marginSolVault = setup.marginSolVault;
    marginUsdcVault = setup.marginUsdcVault;

    console.log("Margin vault:", marginVault.toString());

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
      marginProgram.programId
    );

    [user2State] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_state"), user2.publicKey.toBuffer()],
      marginProgram.programId
    );

    // Derive user margin accounts
    [user1MarginAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("margin_account"), user1.publicKey.toBuffer()],
      marginProgram.programId
    );

    [user2MarginAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("margin_account"), user2.publicKey.toBuffer()],
      marginProgram.programId
    );

    configInitialized = true;

    // Get user token accounts

    user1SolAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        solMint,
        user1.publicKey
      )
    ).address;

    user1UsdcAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        usdcMint,
        user1.publicKey
      )
    ).address;

    user2SolAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        solMint,
        user2.publicKey
      )
    ).address;

    user2UsdcAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        usdcMint,
        user2.publicKey
      )
    ).address;

    console.log("User token accounts created");

    configInitialized = true;
  });

  describe("liquidate_margin_account", () => {
    it("should liquidate a margin account's SOL balance", async () => {
      // Wrap SOL first to get WSOL tokens
      await wrapSol(
        user1.publicKey,
        user1SolAccount,
        initialSolDeposit.toNumber(),
        provider,
        user1
      );

      // First, deposit SOL into user1's margin account.
      await marginProgram.methods
        .depositMargin(initialSolDeposit)
        .accountsStrict({
          marginAccount: user1MarginAccount,
          marginVault: marginVault,
          vaultTokenAccount: marginSolVault,
          userTokenAccount: user1SolAccount,
          owner: user1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();

      // Fetch margin account state before liquidation.
      const marginAccountBefore =
        await marginProgram.account.marginAccount.fetch(user1MarginAccount);
      const depositedSol = marginAccountBefore.solBalance;
      assert.equal(
        depositedSol.toString(),
        initialSolDeposit.toString(),
        "Initial SOL balance should match deposit amount"
      );

      // Capture the pool SOL vault balance before liquidation.
      const poolSolBefore = await getAccount(provider.connection, solVault);
      const poolSolAmountBefore = new BN(poolSolBefore.amount.toString());

      // Call the liquidation instruction.
      await marginProgram.methods
        .liquidateMarginAccount()
        .accountsStrict({
          marginAccount: user1MarginAccount,
          marginVault: marginVault,
          marginVaultTokenAccount: marginSolVault,
          poolState: poolState,
          poolVaultAccount: solVault,
          chainlinkProgram: chainlinkProgram,
          chainlinkFeed: chainlinkFeed,
          authority: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          liquidityPoolProgram: ammProgram.programId,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      console.log("Liquidation transaction for SOL completed.");

      // Fetch margin account state after liquidation.
      const marginAccountAfter =
        await marginProgram.account.marginAccount.fetch(user1MarginAccount);
      assert.equal(
        marginAccountAfter.solBalance.toString(),
        "0",
        "SOL balance should be zero after liquidation"
      );

      // Verify that the AMM pool vault increased by the deposited amount.
      const poolSolAfter = await getAccount(provider.connection, solVault);
      const poolSolAmountAfter = new BN(poolSolAfter.amount.toString());
      const diff = poolSolAmountAfter.sub(poolSolAmountBefore);
      assert.equal(
        diff.toString(),
        initialSolDeposit.toString(),
        "Pool SOL vault should increase by the liquidated amount"
      );
    });

    it("should liquidate a margin account's USDC balance", async () => {
      // Deposit USDC into user2's margin account.
      await marginProgram.methods
        .depositMargin(initialUsdcDeposit)
        .accountsStrict({
          marginAccount: user2MarginAccount,
          marginVault: marginVault,
          vaultTokenAccount: marginUsdcVault,
          userTokenAccount: user2UsdcAccount,
          owner: user2.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user2])
        .rpc();

      // Fetch margin account state before liquidation.
      const marginAccountBefore =
        await marginProgram.account.marginAccount.fetch(user2MarginAccount);
      const depositedUsdc = marginAccountBefore.usdcBalance;
      assert.equal(
        depositedUsdc.toString(),
        initialUsdcDeposit.toString(),
        "Initial USDC balance should match deposit amount"
      );

      // Capture the pool USDC vault balance before liquidation.
      const poolUsdcBefore = await getAccount(provider.connection, usdcVault);
      const poolUsdcAmountBefore = new BN(poolUsdcBefore.amount.toString());

      // Call the liquidation instruction.
      await marginProgram.methods
        .liquidateMarginAccount()
        .accountsStrict({
          marginAccount: user2MarginAccount,
          marginVault: marginVault,
          marginVaultTokenAccount: marginUsdcVault,
          poolState: poolState,
          poolVaultAccount: usdcVault,
          chainlinkProgram: chainlinkProgram,
          chainlinkFeed: chainlinkFeed,
          authority: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          liquidityPoolProgram: ammProgram.programId,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      console.log("Liquidation transaction for USDC completed.");

      // Fetch margin account state after liquidation.
      const marginAccountAfter =
        await marginProgram.account.marginAccount.fetch(user2MarginAccount);
      assert.equal(
        marginAccountAfter.usdcBalance.toString(),
        "0",
        "USDC balance should be zero after liquidation"
      );

      // Verify that the AMM pool vault increased by the liquidated amount.
      const poolUsdcAfter = await getAccount(provider.connection, usdcVault);
      const poolUsdcAmountAfter = new BN(poolUsdcAfter.amount.toString());
      const diff = poolUsdcAmountAfter.sub(poolUsdcAmountBefore);
      assert.equal(
        diff.toString(),
        initialUsdcDeposit.toString(),
        "Pool USDC vault should increase by the liquidated amount"
      );
    });

    it("should fail to liquidate with an unauthorized authority", async () => {
      try {
        // Attempt liquidation using an unauthorized authority.
        await marginProgram.methods
          .liquidateMarginAccount()
          .accountsStrict({
            marginAccount: user1MarginAccount,
            marginVault: marginVault,
            marginVaultTokenAccount: marginSolVault,
            poolState: poolState,
            poolVaultAccount: solVault,
            chainlinkProgram: chainlinkProgram,
            chainlinkFeed: chainlinkFeed,
            authority: admin.publicKey, // Unauthorized!
            tokenProgram: TOKEN_PROGRAM_ID,
            liquidityPoolProgram: ammProgram.programId,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();

        assert.fail("Expected transaction to fail with unauthorized authority");
      } catch (error: any) {
        assert.include(
          error.toString(),
          "unknown signer",
          "Expected error about unauthorized liquidation"
        );
      }
    });
  });
});
